// version 2.1.0
// MasterController Security Middleware - CSRF, Headers, Rate Limiting, CORS
//
// v2.1.0 hardening summary:
//   - constructor now stores `this.options` (2.0.9 silently dropped it,
//     making the trustedProxies gate dead code in three places).
//   - HSTS is emitted per-request via master.isRequestSecure() when the
//     middleware is bound to a MasterControl instance (bindMaster). This
//     means TLS termination at a trusted proxy correctly enables HSTS.
//   - The `preload` directive is no longer hardcoded in the HSTS header; it
//     is opt-in via master._hstsPreload (or the enableHSTS() options).
//   - CSRF tokens are indexed by sessionId (not by token). sessionId is
//     required at issue time and at validate time. Successful validation
//     rotates the token (single-use) — a leaked token cannot be replayed.
//   - The rate-limit identity NEVER trusts an anonymous client's x-api-key
//     header. Identity is the resolved client IP (via master.getClientIp
//     when available) plus, optionally, an authenticated session id.
//   - The rate-limit store has an LRU cap (rateLimitStoreMax, default 10k)
//     to prevent unbounded growth from key-rotation attacks.
//   - Block windows escalate exponentially on repeat offenders, capped at
//     24 hours. Offenses are tracked per identity.
//   - A stop() method clears the cleanup interval so tests exit cleanly
//     and long-running processes can release the timer if they need to.

import crypto from 'node:crypto';
import { logger } from '../error/MasterErrorLogger.js';

// --- Shared stores (module-scope so multiple instances see the same state) ---
// Rate-limit and CSRF stores must be shared across the singleton and any
// factory-wrapped middleware instances. In a single-process deployment the
// default `Map` is fine. Multi-instance deployments MUST inject a shared
// Redis-backed adapter via `security.useRateLimitStore(store)` and
// `security.useCsrfStore(store)` — otherwise each process has its own bucket
// (effective rate limit is N_workers * rateLimitMax) and CSRF rotate-on-use
// silently fails when the issue and validate hit different processes.
//
// The adapter contract is a subset of the Map interface:
//   get(key) -> value | undefined
//   set(key, value) -> void
//   delete(key) -> boolean
//   entries() -> Iterable<[key, value]>
//   keys()    -> Iterable<key>
//   get size (property) -> number
//
// A Redis adapter that provides these methods (using EX for TTL) is enough
// for both the rate-limit and CSRF paths.
let rateLimitStore = new Map();
let csrfTokenStore = new Map();

function __assertStoreShape(store, label) {
    if (!store || typeof store !== 'object') throw new TypeError(`${label} must be a non-null object`);
    for (const method of ['get', 'set', 'delete', 'entries', 'keys']) {
        if (typeof store[method] !== 'function') {
            throw new TypeError(`${label} is missing required method: ${method}()`);
        }
    }
    if (typeof store.size !== 'number' && typeof Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(store), 'size')?.get !== 'function') {
        throw new TypeError(`${label} must expose a numeric \`size\` property`);
    }
}

// Timing-safe string compare. Returns false on length mismatch WITHOUT leaking
// length via early return (still runs a same-length compare to keep timing
// flat). Used for CSRF token / session id equality.
function __timingSafeEqualStr(a, b) {
    const aBuf = Buffer.from(String(a));
    const bBuf = Buffer.from(String(b));
    if (aBuf.length !== bBuf.length) {
        crypto.timingSafeEqual(aBuf, aBuf);
        return false;
    }
    return crypto.timingSafeEqual(aBuf, bBuf);
}

// Standard defensive response headers. HSTS is NOT included here — it is
// applied separately from securityHeadersMiddleware because it must gate on
// per-request TLS state, not on a static object.
const SECURITY_HEADERS = {
    'X-XSS-Protection': '1; mode=block',
    'X-Frame-Options': 'SAMEORIGIN',
    'X-Content-Type-Options': 'nosniff',
    'X-DNS-Prefetch-Control': 'off',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Powered-By': ''
};

class SecurityMiddleware {
    constructor(options = {}) {
        // v2.1.0 fix: previous versions never stored the options object, so
        // every downstream `this.options?.trustedProxies` read was undefined.
        this.options = options;

        this.csrfEnabled = options.csrf !== false;
        this.rateLimitEnabled = options.rateLimit !== false;
        this.corsEnabled = options.cors !== false;
        this.headersEnabled = options.headers !== false;

        // Rate limit config
        this.rateLimitWindow = options.rateLimitWindow || 60000; // 1 minute
        this.rateLimitMax = options.rateLimitMax || 100;         // per window
        // LRU cap on the in-memory rate-limit store. Prevents unbounded memory
        // growth from clients rotating identity headers. Multi-instance
        // deployments should replace the whole store with Redis via setStore.
        this.rateLimitStoreMax = options.rateLimitStoreMax || 10000;
        // Backoff config: cap = 24h, multiplier = 2x
        this.blockMaxMs = options.blockMaxMs || 24 * 60 * 60 * 1000;

        // CSRF config
        this.csrfCookieName = options.csrfCookieName || '_csrf';
        this.csrfHeaderName = options.csrfHeaderName || 'x-csrf-token';
        this.csrfTokenExpiry = options.csrfTokenExpiry || 3600000; // 1 hour

        // CORS config
        this.corsOrigins = options.corsOrigins || ['*'];
        this.corsMethods = options.corsMethods || ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'];
        this.corsHeaders = options.corsHeaders || ['Content-Type', 'Authorization', 'X-Requested-With'];

        // Optional master reference for trusted-proxy / TLS awareness. Set via
        // bindMaster() from MasterControl.setupServer(). Falls back to the
        // options-only behavior when no master is bound (useful for tests).
        this._master = null;

        // Per-identity offense count (drives exponential backoff).
        this._offenses = new Map();

        this._startCleanup();
    }

    /**
     * Bind this middleware to a MasterControl instance so trusted-proxy
     * and TLS awareness delegate to the framework's canonical helpers.
     * MasterControl calls this once during setupServer().
     */
    bindMaster(master) {
        this._master = master;
    }

    /**
     * Replace the rate-limit store with a custom (usually Redis-backed) one.
     * The store must implement Map's get/set/delete/entries/keys/size interface.
     * Multi-instance deployments MUST call this — otherwise each worker has
     * its own bucket and the effective rate limit is N_workers × rateLimitMax.
     */
    useRateLimitStore(store) {
        __assertStoreShape(store, 'rate-limit store');
        rateLimitStore = store;
    }

    /**
     * Replace the CSRF token store with a custom (usually Redis-backed) one.
     * Same contract as useRateLimitStore. Required for multi-instance because
     * rotate-on-use validation only works when the issue and validate paths
     * see the same state.
     */
    useCsrfStore(store) {
        __assertStoreShape(store, 'CSRF store');
        csrfTokenStore = store;
    }

    /**
     * Stop the internal cleanup interval. Long-running processes normally
     * never need this; tests use it to let the event loop drain.
     */
    stop() {
        if (this._cleanupInterval) {
            clearInterval(this._cleanupInterval);
            this._cleanupInterval = null;
        }
    }

    // ---------------- Standard security headers + HSTS ----------------

    securityHeadersMiddleware(req, res, next) {
        if (!this.headersEnabled) {
            if (typeof next === 'function') next();
            return;
        }

        for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
            if (value === '') {
                res.removeHeader(header);
            } else {
                res.setHeader(header, value);
            }
        }

        // HSTS is only meaningful over TLS. Emit only in production AND when
        // the request itself is secure (either encrypted socket or a trusted
        // TLS-terminating proxy said so via X-Forwarded-Proto: https).
        const isProduction = process.env.NODE_ENV === 'production';
        if (isProduction && this._isRequestSecure(req)) {
            res.setHeader('Strict-Transport-Security', this._buildHstsHeader());
        }

        if (typeof next === 'function') next();
    }

    _isRequestSecure(req) {
        if (this._master && typeof this._master.isRequestSecure === 'function') {
            return this._master.isRequestSecure(req);
        }
        if (req.socket?.encrypted || req.connection?.encrypted) return true;
        const trustedProxies = this.options.trustedProxies || [];
        const peer = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
        const normalized = peer.startsWith('::ffff:') ? peer.slice(7) : peer;
        const trusted = trustedProxies.some(p => p === peer || p === normalized);
        return trusted && req.headers['x-forwarded-proto'] === 'https';
    }

    _buildHstsHeader() {
        const master = this._master;
        const maxAge = master?._hstsMaxAge ?? this.options.hstsMaxAge ?? 31536000;
        const includeSub = master ? master._hstsIncludeSubDomains !== false
                                  : this.options.hstsIncludeSubDomains !== false;
        const preload = master ? master._hstsPreload === true
                               : this.options.hstsPreload === true;
        let value = `max-age=${maxAge}`;
        if (includeSub) value += '; includeSubDomains';
        if (preload) value += '; preload';
        return value;
    }

    // ---------------- CORS ----------------

    corsMiddleware(req, res, next) {
        if (!this.corsEnabled) {
            if (typeof next === 'function') next();
            return;
        }

        const origin = req.headers.origin;
        const wildcard = this.corsOrigins.includes('*');
        const explicitlyAllowed = origin && this.corsOrigins.includes(origin);

        if (explicitlyAllowed) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Credentials', 'true');
            res.setHeader('Vary', 'Origin');
            res.setHeader('Access-Control-Allow-Methods', this.corsMethods.join(', '));
            res.setHeader('Access-Control-Allow-Headers', this.corsHeaders.join(', '));
            res.setHeader('Access-Control-Max-Age', '86400');
        } else if (wildcard) {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', this.corsMethods.join(', '));
            res.setHeader('Access-Control-Allow-Headers', this.corsHeaders.join(', '));
            res.setHeader('Access-Control-Max-Age', '86400');
        }

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        if (typeof next === 'function') next();
    }

    // ---------------- Rate limiting ----------------

    rateLimitMiddleware(req, res, next) {
        if (!this.rateLimitEnabled) {
            if (typeof next === 'function') next();
            return;
        }

        const identifier = this._getClientIdentifier(req);
        const now = Date.now();
        const windowStart = now - this.rateLimitWindow;

        let record = rateLimitStore.get(identifier);
        if (!record) {
            record = { requests: [], blocked: false, blockExpiry: 0 };
            this._setRateLimitRecord(identifier, record);
        } else {
            // Touch for LRU: reinsertion moves the key to end of iteration order.
            rateLimitStore.delete(identifier);
            rateLimitStore.set(identifier, record);
        }

        if (record.blocked && now < record.blockExpiry) {
            const retryAfter = Math.ceil((record.blockExpiry - now) / 1000);
            res.setHeader('Retry-After', retryAfter);
            res.setHeader('X-RateLimit-Limit', this.rateLimitMax);
            res.setHeader('X-RateLimit-Remaining', 0);
            res.setHeader('X-RateLimit-Reset', new Date(record.blockExpiry).toISOString());

            logger.warn({
                code: 'MC_SECURITY_RATE_LIMIT_EXCEEDED',
                message: 'Rate limit exceeded',
                context: { identifier: this._hashIdentifier(identifier), ip: this._getClientIP(req) }
            });

            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Too Many Requests',
                message: 'Rate limit exceeded. Please try again later.',
                retryAfter
            }));
            return;
        }

        record.requests = record.requests.filter(ts => ts > windowStart);

        if (record.requests.length >= this.rateLimitMax) {
            const offenseCount = (this._offenses.get(identifier) || 0) + 1;
            this._offenses.set(identifier, offenseCount);
            const blockMs = this._computeBlockDurationMs(identifier, offenseCount);

            record.blocked = true;
            record.blockExpiry = now + blockMs;

            logger.warn({
                code: 'MC_SECURITY_RATE_LIMIT_TRIGGERED',
                message: 'Rate limit triggered',
                context: {
                    identifier: this._hashIdentifier(identifier),
                    ip: this._getClientIP(req),
                    offenseCount,
                    blockMs
                }
            });

            const retryAfter = Math.ceil(blockMs / 1000);
            res.setHeader('Retry-After', retryAfter);
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Too Many Requests',
                message: 'Rate limit exceeded. Please try again later.',
                retryAfter
            }));
            return;
        }

        record.requests.push(now);
        const remaining = this.rateLimitMax - record.requests.length;
        const resetTime = now + this.rateLimitWindow;
        res.setHeader('X-RateLimit-Limit', this.rateLimitMax);
        res.setHeader('X-RateLimit-Remaining', remaining);
        res.setHeader('X-RateLimit-Reset', new Date(resetTime).toISOString());

        if (typeof next === 'function') next();
    }

    _setRateLimitRecord(identifier, record) {
        rateLimitStore.set(identifier, record);
        // Enforce LRU cap. Map iteration is insertion order, so the first
        // key is the least recently touched. Evict until we're within the cap.
        while (rateLimitStore.size > this.rateLimitStoreMax) {
            const oldest = rateLimitStore.keys().next().value;
            rateLimitStore.delete(oldest);
            this._offenses.delete(oldest);
        }
    }

    _computeBlockDurationMs(_identifier, offenseCount) {
        // Exponential backoff: window * 2^(offense-1), capped at blockMaxMs.
        const base = this.rateLimitWindow;
        const exp = Math.max(0, offenseCount - 1);
        const scaled = base * Math.pow(2, Math.min(exp, 30));
        return Math.min(scaled, this.blockMaxMs);
    }

    // ---------------- CSRF ----------------

    csrfMiddleware(req, res, next) {
        if (!this.csrfEnabled) {
            if (typeof next === 'function') next();
            return;
        }

        const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
        if (safeMethods.includes(req.method)) {
            if (typeof next === 'function') next();
            return;
        }

        const tokenFromHeader = req.headers[this.csrfHeaderName];
        const tokenFromBody = req.body && req.body._csrf;
        const tokenFromQuery = req.url.includes('_csrf=') ? this._getQueryParam(req.url, '_csrf') : null;
        const clientToken = tokenFromHeader || tokenFromBody || tokenFromQuery;

        const currentSession = req.sessionId || req.session?.id;

        if (!clientToken || !currentSession) {
            logger.warn({
                code: 'MC_SECURITY_CSRF_MISSING',
                message: 'CSRF token missing',
                context: { method: req.method, path: req.url, ip: this._getClientIP(req) }
            });
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Forbidden', message: 'CSRF token missing' }));
            return;
        }

        const validation = this.validateCSRFToken(clientToken, currentSession);
        if (!validation.valid) {
            logger.warn({
                code: 'MC_SECURITY_CSRF_INVALID',
                message: 'CSRF token invalid',
                context: { reason: validation.reason, method: req.method, path: req.url, ip: this._getClientIP(req) }
            });
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Forbidden', message: validation.reason || 'CSRF token invalid' }));
            return;
        }

        // Issue a fresh token so the client can pick it up from the response.
        const freshToken = this.generateCSRFToken(currentSession);
        res.setHeader('X-CSRF-Token', freshToken);
        if (typeof next === 'function') next();
    }

    /**
     * Generate a CSRF token bound to `sessionId`. sessionId is REQUIRED — a
     * token with no session binding is replayable across users and is never
     * accepted by validateCSRFToken.
     */
    generateCSRFToken(sessionId) {
        if (!sessionId || typeof sessionId !== 'string') {
            throw new Error(
                'generateCSRFToken(sessionId): a non-empty sessionId is required. ' +
                'Tokens without session binding are replayable and would be rejected ' +
                'by validateCSRFToken. Call this after the session middleware has ' +
                'assigned req.sessionId.'
            );
        }
        const token = crypto.randomBytes(32).toString('hex');
        const expiry = Date.now() + this.csrfTokenExpiry;
        csrfTokenStore.set(token, { sessionId, expiry, createdAt: Date.now() });
        return token;
    }

    /**
     * Validate a CSRF token. sessionId is REQUIRED and must match the sessionId
     * the token was issued for (timing-safe comparison). On success, the token
     * is deleted (single-use — leaked tokens cannot be replayed).
     */
    validateCSRFToken(token, sessionId) {
        if (!token) return { valid: false, reason: 'Token not provided' };
        if (!sessionId) return { valid: false, reason: 'Session required for CSRF validation' };

        const stored = csrfTokenStore.get(token);
        if (!stored) return { valid: false, reason: 'Token not found' };

        if (Date.now() > stored.expiry) {
            csrfTokenStore.delete(token);
            return { valid: false, reason: 'Token expired' };
        }

        if (!__timingSafeEqualStr(String(stored.sessionId), String(sessionId))) {
            return { valid: false, reason: 'Token does not belong to this session' };
        }

        // Rotate-on-use: single-use tokens defeat replay by leaked-token theft.
        csrfTokenStore.delete(token);
        return { valid: true };
    }

    // ---------------- Identity + IP helpers ----------------

    /**
     * Identity key for rate limiting. Never trusts anonymous client headers.
     *
     *   - if the request already has a *server-issued* session id, use that
     *     (an attacker cannot forge it without hitting the same bucket);
     *   - otherwise key on the resolved client IP.
     *
     * Explicitly does NOT use req.headers['x-api-key'] — an unauthenticated
     * attacker can rotate that header freely, bypassing the IP bucket and
     * inflating the store.
     */
    _getClientIdentifier(req) {
        if (req.session?.id) return `session:${req.session.id}`;
        return `ip:${this._getClientIP(req)}`;
    }

    _getClientIP(req) {
        if (this._master && typeof this._master.getClientIp === 'function') {
            return this._master.getClientIp(req) || 'unknown';
        }
        const trustedProxies = this.options.trustedProxies || [];
        const peer = req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
        const normalized = peer.startsWith('::ffff:') ? peer.slice(7) : peer;
        const trusted = trustedProxies.some(p => p === peer || p === normalized);
        if (trusted) {
            const forwarded = req.headers['x-forwarded-for'];
            if (forwarded) {
                const hops = String(forwarded).split(',').map(s => s.trim()).filter(Boolean);
                for (let i = hops.length - 1; i >= 0; i--) {
                    const h = hops[i];
                    const hn = h.startsWith('::ffff:') ? h.slice(7) : h;
                    if (!trustedProxies.some(p => p === h || p === hn)) return h;
                }
            }
            if (req.headers['x-real-ip']) return req.headers['x-real-ip'];
        }
        return peer;
    }

    _hashIdentifier(identifier) {
        // Hash for logs so plaintext session ids or IPs aren't written to disk.
        return crypto.createHash('sha256').update(String(identifier)).digest('hex').slice(0, 16);
    }

    _getQueryParam(url, param) {
        const match = url.match(new RegExp(`[?&]${param}=([^&]*)`));
        return match ? decodeURIComponent(match[1]) : null;
    }

    // ---------------- Cleanup ----------------

    _startCleanup() {
        this._cleanupInterval = setInterval(() => {
            const now = Date.now();

            for (const [token, data] of csrfTokenStore.entries()) {
                if (now > data.expiry) csrfTokenStore.delete(token);
            }

            for (const [identifier, record] of rateLimitStore.entries()) {
                const windowStart = now - this.rateLimitWindow;
                record.requests = record.requests.filter(ts => ts > windowStart);
                if (record.requests.length === 0 && !record.blocked) {
                    rateLimitStore.delete(identifier);
                    this._offenses.delete(identifier);
                }
                if (record.blocked && now > record.blockExpiry) {
                    record.blocked = false;
                    record.requests = [];
                }
            }
        }, 60000);
        // Do not keep the process alive just for the cleanup timer.
        if (this._cleanupInterval.unref) this._cleanupInterval.unref();
    }

    // ---------------- Public introspection (used by tests + ops) ----------------

    clearRateLimit(identifier) {
        rateLimitStore.delete(identifier);
        this._offenses.delete(identifier);
    }

    getRateLimitStoreSize() {
        return rateLimitStore.size;
    }

    getRateLimitStatus(identifier) {
        const record = rateLimitStore.get(identifier);
        if (!record) {
            return { requests: 0, remaining: this.rateLimitMax, blocked: false };
        }
        const now = Date.now();
        const windowStart = now - this.rateLimitWindow;
        const recent = record.requests.filter(ts => ts > windowStart);
        return {
            requests: recent.length,
            remaining: Math.max(0, this.rateLimitMax - recent.length),
            blocked: record.blocked && now < record.blockExpiry,
            blockExpiry: record.blocked ? record.blockExpiry : null
        };
    }
}

// Singleton the framework wires up. MasterControl.setupServer() calls
// security.bindMaster(this) so trustedProxies + isRequestSecure work.
const security = new SecurityMiddleware();

// -------- Factories & pipeline adapters --------

function securityHeaders() {
    return (req, res, next) => security.securityHeadersMiddleware(req, res, next);
}

function cors(options = {}) {
    const instance = new SecurityMiddleware({ ...options, headers: false, csrf: false, rateLimit: false });
    return (req, res, next) => instance.corsMiddleware(req, res, next);
}

function rateLimit(options = {}) {
    const instance = new SecurityMiddleware({ ...options, headers: false, csrf: false, cors: false });
    return (req, res, next) => instance.rateLimitMiddleware(req, res, next);
}

function csrf(options = {}) {
    const instance = new SecurityMiddleware({ ...options, headers: false, cors: false, rateLimit: false });
    return (req, res, next) => instance.csrfMiddleware(req, res, next);
}

function generateCSRFToken(sessionId) {
    return security.generateCSRFToken(sessionId);
}

function validateCSRFToken(token, sessionId) {
    return security.validateCSRFToken(token, sessionId);
}

function pipelineSecurityHeaders(options = {}) {
    const instance = options.instance || security;
    return async (ctx, next) => {
        let nextCalled = false;
        const oldNext = () => { nextCalled = true; };
        instance.securityHeadersMiddleware(ctx.request, ctx.response, oldNext);
        if (nextCalled && typeof next === 'function') await next();
    };
}

function pipelineCors(options = {}) {
    const instance = new SecurityMiddleware({ ...options, headers: false, csrf: false, rateLimit: false });
    return async (ctx, next) => {
        let nextCalled = false;
        const oldNext = () => { nextCalled = true; };
        instance.corsMiddleware(ctx.request, ctx.response, oldNext);
        if (!ctx.response.writableEnded && nextCalled && typeof next === 'function') await next();
    };
}

function pipelineRateLimit(options = {}) {
    const instance = new SecurityMiddleware({ ...options, headers: false, csrf: false, cors: false });
    return async (ctx, next) => {
        let nextCalled = false;
        const oldNext = () => { nextCalled = true; };
        instance.rateLimitMiddleware(ctx.request, ctx.response, oldNext);
        if (!ctx.response.writableEnded && nextCalled && typeof next === 'function') await next();
    };
}

function pipelineCsrf(options = {}) {
    const instance = new SecurityMiddleware({ ...options, headers: false, cors: false, rateLimit: false });
    return async (ctx, next) => {
        let nextCalled = false;
        const oldNext = () => { nextCalled = true; };
        instance.csrfMiddleware(ctx.request, ctx.response, oldNext);
        if (!ctx.response.writableEnded && nextCalled && typeof next === 'function') await next();
    };
}

export {
    SecurityMiddleware,
    security,
    securityHeaders,
    cors,
    rateLimit,
    csrf,
    generateCSRFToken,
    validateCSRFToken,
    SECURITY_HEADERS,
    pipelineSecurityHeaders,
    pipelineCors,
    pipelineRateLimit,
    pipelineCsrf
};
