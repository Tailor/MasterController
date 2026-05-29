// version 1.0.1
// MasterController Security Middleware - CSRF, Headers, Rate Limiting, CORS

/**
 * Security middleware for MasterController
 * Provides: CSRF protection, Security headers, Rate limiting, CORS
 */

import crypto from 'node:crypto';
import { logger } from '../error/MasterErrorLogger.js';

// Rate limiting store
const rateLimitStore = new Map();

// CSRF token store (use Redis in production)
const csrfTokenStore = new Map();

/**
 * Timing-safe string comparison. Returns false on length mismatch in constant
 * time relative to the longer of the two lengths to avoid leaking length info
 * via timing. Used for comparing session IDs and CSRF tokens to mitigate
 * timing-side-channel attacks.
 */
function __timingSafeEqualStr(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) {
    // Still do a constant-time compare against itself to keep timing flat.
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// Security headers configuration
const SECURITY_HEADERS = {
  // Prevent XSS attacks
  'X-XSS-Protection': '1; mode=block',

  // Prevent clickjacking
  'X-Frame-Options': 'SAMEORIGIN',

  // Prevent MIME type sniffing
  'X-Content-Type-Options': 'nosniff',

  // Prevent DNS prefetching
  'X-DNS-Prefetch-Control': 'off',

  // Disable browser features
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',

  // Referrer policy
  'Referrer-Policy': 'strict-origin-when-cross-origin',

  // Remove X-Powered-By header
  'X-Powered-By': ''
};

// HSTS (HTTP Strict Transport Security) - only in production
const HSTS_HEADER = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload'
};

class SecurityMiddleware {
  constructor(options = {}) {
    this.csrfEnabled = options.csrf !== false;
    this.rateLimitEnabled = options.rateLimit !== false;
    this.corsEnabled = options.cors !== false;
    this.headersEnabled = options.headers !== false;

    // Rate limit config
    this.rateLimitWindow = options.rateLimitWindow || 60000; // 1 minute
    this.rateLimitMax = options.rateLimitMax || 100; // 100 requests per window

    // CSRF config
    this.csrfCookieName = options.csrfCookieName || '_csrf';
    this.csrfHeaderName = options.csrfHeaderName || 'x-csrf-token';
    this.csrfTokenExpiry = options.csrfTokenExpiry || 3600000; // 1 hour

    // CORS config
    this.corsOrigins = options.corsOrigins || ['*'];
    this.corsMethods = options.corsMethods || ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'];
    this.corsHeaders = options.corsHeaders || ['Content-Type', 'Authorization', 'X-Requested-With'];

    // Start cleanup interval
    this._startCleanup();
  }

  /**
   * Apply security headers to response
   */
  securityHeadersMiddleware(req, res, next) {
    if (!this.headersEnabled) {
      if (typeof next === 'function') next();
      return;
    }

    // Apply standard security headers
    for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
      if (value === '') {
        res.removeHeader(header);
      } else {
        res.setHeader(header, value);
      }
    }

    // Apply HSTS only in production over HTTPS.
    // SECURITY: only honor X-Forwarded-Proto when the peer is in trustedProxies.
    const isProduction = process.env.NODE_ENV === 'production';
    const peer = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
    const trustedProxies = this.options?.trustedProxies || [];
    const normalized = peer.startsWith('::ffff:') ? peer.slice(7) : peer;
    const trusted = trustedProxies.some(p => p === peer || p === normalized);
    const isHTTPS = req.connection?.encrypted || req.socket?.encrypted ||
                    (trusted && req.headers['x-forwarded-proto'] === 'https');

    if (isProduction && isHTTPS) {
      for (const [header, value] of Object.entries(HSTS_HEADER)) {
        res.setHeader(header, value);
      }
    }

    if (typeof next === 'function') next();
  }

  /**
   * CORS middleware
   */
  corsMiddleware(req, res, next) {
    if (!this.corsEnabled) {
      if (typeof next === 'function') next();
      return;
    }

    const origin = req.headers.origin;

    // SECURITY (v3.0): never combine wildcard origin with credentials. The
    // previous code reflected the request's Origin AND set
    // Access-Control-Allow-Credentials: true whenever corsOrigins included
    // '*' (which was the default!) — this neutered SameSite + CSRF for every
    // authenticated endpoint. Now wildcard implies no credentials, per spec.
    const wildcard = this.corsOrigins.includes('*');
    const explicitlyAllowed = origin && this.corsOrigins.includes(origin);

    if (explicitlyAllowed) {
      // Specific allow-listed origin → may include credentials.
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', this.corsMethods.join(', '));
      res.setHeader('Access-Control-Allow-Headers', this.corsHeaders.join(', '));
      res.setHeader('Access-Control-Max-Age', '86400');
    } else if (wildcard) {
      // Wildcard → public API only. Must NOT include credentials.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', this.corsMethods.join(', '));
      res.setHeader('Access-Control-Allow-Headers', this.corsHeaders.join(', '));
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    // Otherwise: origin not allowed, send no CORS headers (browser will block).

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (typeof next === 'function') next();
  }

  /**
   * Rate limiting middleware
   */
  rateLimitMiddleware(req, res, next) {
    if (!this.rateLimitEnabled) {
      if (typeof next === 'function') next();
      return;
    }

    const identifier = this._getClientIdentifier(req);
    const now = Date.now();
    const windowStart = now - this.rateLimitWindow;

    // Get or create rate limit record
    let record = rateLimitStore.get(identifier);
    if (!record) {
      record = { requests: [], blocked: false, blockExpiry: 0 };
      rateLimitStore.set(identifier, record);
    }

    // Check if blocked
    if (record.blocked && now < record.blockExpiry) {
      const retryAfter = Math.ceil((record.blockExpiry - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      res.setHeader('X-RateLimit-Limit', this.rateLimitMax);
      res.setHeader('X-RateLimit-Remaining', 0);
      res.setHeader('X-RateLimit-Reset', new Date(record.blockExpiry).toISOString());

      logger.warn({
        code: 'MC_SECURITY_RATE_LIMIT_EXCEEDED',
        message: 'Rate limit exceeded',
        identifier,
        ip: this._getClientIP(req)
      });

      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please try again later.',
        retryAfter: retryAfter
      }));
      return;
    }

    // Remove old requests outside window
    record.requests = record.requests.filter(timestamp => timestamp > windowStart);

    // Check if limit exceeded
    if (record.requests.length >= this.rateLimitMax) {
      record.blocked = true;
      record.blockExpiry = now + this.rateLimitWindow;

      logger.warn({
        code: 'MC_SECURITY_RATE_LIMIT_TRIGGERED',
        message: 'Rate limit triggered',
        identifier,
        ip: this._getClientIP(req),
        requests: record.requests.length
      });

      const retryAfter = Math.ceil(this.rateLimitWindow / 1000);
      res.setHeader('Retry-After', retryAfter);
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please try again later.',
        retryAfter: retryAfter
      }));
      return;
    }

    // Add current request
    record.requests.push(now);

    // Set rate limit headers
    const remaining = this.rateLimitMax - record.requests.length;
    const resetTime = now + this.rateLimitWindow;

    res.setHeader('X-RateLimit-Limit', this.rateLimitMax);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', new Date(resetTime).toISOString());

    if (typeof next === 'function') next();
  }

  /**
   * CSRF protection middleware
   */
  csrfMiddleware(req, res, next) {
    if (!this.csrfEnabled) {
      if (typeof next === 'function') next();
      return;
    }

    // Skip CSRF for safe methods
    const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
    if (safeMethods.includes(req.method)) {
      if (typeof next === 'function') next();
      return;
    }

    // Get CSRF token from request
    const tokenFromHeader = req.headers[this.csrfHeaderName];
    const tokenFromBody = req.body && req.body._csrf;
    const tokenFromQuery = req.url.includes('_csrf=') ? this._getQueryParam(req.url, '_csrf') : null;

    const clientToken = tokenFromHeader || tokenFromBody || tokenFromQuery;

    if (!clientToken) {
      logger.warn({
        code: 'MC_SECURITY_CSRF_MISSING',
        message: 'CSRF token missing',
        method: req.method,
        path: req.url,
        ip: this._getClientIP(req)
      });

      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Forbidden',
        message: 'CSRF token missing'
      }));
      return;
    }

    // Verify CSRF token
    const storedToken = csrfTokenStore.get(clientToken);

    if (!storedToken) {
      logger.warn({
        code: 'MC_SECURITY_CSRF_INVALID',
        message: 'CSRF token invalid',
        method: req.method,
        path: req.url,
        ip: this._getClientIP(req)
      });

      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Forbidden',
        message: 'CSRF token invalid'
      }));
      return;
    }

    // Check token expiry
    if (Date.now() > storedToken.expiry) {
      csrfTokenStore.delete(clientToken);

      logger.warn({
        code: 'MC_SECURITY_CSRF_EXPIRED',
        message: 'CSRF token expired',
        method: req.method,
        path: req.url,
        ip: this._getClientIP(req)
      });

      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Forbidden',
        message: 'CSRF token expired'
      }));
      return;
    }

    // SECURITY (v3.0): bind token to session. Previously the in-memory store
    // accepted any valid token for any user — making CSRF protection
    // effectively no-op between authenticated users. Now the token MUST have
    // been issued to the current request's session.
    const currentSession = req.sessionId || req.session?.id;
    if (storedToken.sessionId) {
      if (!currentSession ||
          !__timingSafeEqualStr(String(storedToken.sessionId), String(currentSession))) {
        logger.warn({
          code: 'MC_SECURITY_CSRF_SESSION_MISMATCH',
          message: 'CSRF token belongs to a different session',
          ip: this._getClientIP(req)
        });
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden', message: 'CSRF token invalid' }));
        return;
      }
    }

    // SECURITY (v3.0): rotate-on-use. A leaked token was previously reusable
    // until expiry (default 1h). Now it's single-use; issue a fresh one in
    // the response so clients can pick it up.
    csrfTokenStore.delete(clientToken);
    const freshToken = this.generateCSRFToken(currentSession);
    res.setHeader('X-CSRF-Token', freshToken);

    if (typeof next === 'function') next();
  }

  /**
   * Generate CSRF token
   */
  generateCSRFToken(sessionId = null) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiry = Date.now() + this.csrfTokenExpiry;

    csrfTokenStore.set(token, {
      sessionId,
      expiry,
      createdAt: Date.now()
    });

    return token;
  }

  /**
   * Validate CSRF token manually. sessionId is required for tokens issued
   * with a sessionId — passing null when the stored token has one will fail.
   *
   * @param {string} token - The token from the client
   * @param {string|null} sessionId - The current request's session ID
   * @returns {{valid: boolean, reason?: string}}
   */
  validateCSRFToken(token, sessionId = null) {
    const storedToken = csrfTokenStore.get(token);

    if (!storedToken) {
      return { valid: false, reason: 'Token not found' };
    }

    if (Date.now() > storedToken.expiry) {
      csrfTokenStore.delete(token);
      return { valid: false, reason: 'Token expired' };
    }

    if (storedToken.sessionId) {
      if (!sessionId || !__timingSafeEqualStr(String(storedToken.sessionId), String(sessionId))) {
        return { valid: false, reason: 'Token does not belong to this session' };
      }
    }

    return { valid: true };
  }

  /**
   * Get client identifier for rate limiting
   */
  _getClientIdentifier(req) {
    // Use session ID if available
    if (req.session && req.session.id) {
      return `session:${req.session.id}`;
    }

    // Use API key if available
    if (req.headers['x-api-key']) {
      return `api:${req.headers['x-api-key']}`;
    }

    // Fall back to IP
    return `ip:${this._getClientIP(req)}`;
  }

  /**
   * Get client IP address
   */
  _getClientIP(req) {
    // SECURITY: only trust X-Forwarded-For / X-Real-IP if the immediate peer
    // is in our trustedProxies allow-list. Otherwise an attacker can spoof
    // arbitrary IPs to bypass rate limiting and poison security logs.
    const peer = req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
    const trustedProxies = this.options?.trustedProxies || [];
    const normalized = peer.startsWith('::ffff:') ? peer.slice(7) : peer;
    const trusted = trustedProxies.some(p => p === peer || p === normalized);

    if (trusted) {
      const forwarded = req.headers['x-forwarded-for'];
      if (forwarded) {
        // Walk right-to-left, return first untrusted hop (real client).
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

  /**
   * Get query parameter from URL
   */
  _getQueryParam(url, param) {
    const match = url.match(new RegExp(`[?&]${param}=([^&]*)`));
    return match ? decodeURIComponent(match[1]) : null;
  }

  /**
   * Cleanup expired tokens and rate limit records
   */
  _startCleanup() {
    setInterval(() => {
      const now = Date.now();

      // Cleanup expired CSRF tokens
      for (const [token, data] of csrfTokenStore.entries()) {
        if (now > data.expiry) {
          csrfTokenStore.delete(token);
        }
      }

      // Cleanup old rate limit records
      for (const [identifier, record] of rateLimitStore.entries()) {
        const windowStart = now - this.rateLimitWindow;
        record.requests = record.requests.filter(timestamp => timestamp > windowStart);

        // Remove empty records
        if (record.requests.length === 0 && !record.blocked) {
          rateLimitStore.delete(identifier);
        }

        // Unblock if expiry passed
        if (record.blocked && now > record.blockExpiry) {
          record.blocked = false;
          record.requests = [];
        }
      }
    }, 60000); // Run every minute
  }

  /**
   * Clear rate limit for identifier (useful for testing)
   */
  clearRateLimit(identifier) {
    rateLimitStore.delete(identifier);
  }

  /**
   * Get rate limit status for identifier
   */
  getRateLimitStatus(identifier) {
    const record = rateLimitStore.get(identifier);
    if (!record) {
      return {
        requests: 0,
        remaining: this.rateLimitMax,
        blocked: false
      };
    }

    const now = Date.now();
    const windowStart = now - this.rateLimitWindow;
    const recentRequests = record.requests.filter(timestamp => timestamp > windowStart);

    return {
      requests: recentRequests.length,
      remaining: Math.max(0, this.rateLimitMax - recentRequests.length),
      blocked: record.blocked && now < record.blockExpiry,
      blockExpiry: record.blocked ? record.blockExpiry : null
    };
  }
}

// Create singleton instance
const security = new SecurityMiddleware();

/**
 * Factory functions for middleware
 */

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

function validateCSRFToken(token) {
  return security.validateCSRFToken(token);
}

/**
 * Pipeline-compatible middleware wrappers
 * These adapt from (ctx, next) format to (req, res, next) format
 */

function pipelineSecurityHeaders(options = {}) {
  const instance = options.instance || security;
  return async (ctx, next) => {
    // Create next callback for old-style middleware
    let nextCalled = false;
    const oldNext = () => { nextCalled = true; };

    // Call old middleware
    instance.securityHeadersMiddleware(ctx.request, ctx.response, oldNext);

    // Continue pipeline if next was called
    if (nextCalled && typeof next === 'function') {
      await next();
    }
  };
}

function pipelineCors(options = {}) {
  const instance = new SecurityMiddleware({ ...options, headers: false, csrf: false, rateLimit: false });
  return async (ctx, next) => {
    let nextCalled = false;
    const oldNext = () => { nextCalled = true; };

    instance.corsMiddleware(ctx.request, ctx.response, oldNext);

    // CORS might terminate for OPTIONS - check if response ended
    if (!ctx.response.writableEnded && nextCalled && typeof next === 'function') {
      await next();
    }
  };
}

function pipelineRateLimit(options = {}) {
  const instance = new SecurityMiddleware({ ...options, headers: false, csrf: false, cors: false });
  return async (ctx, next) => {
    let nextCalled = false;
    const oldNext = () => { nextCalled = true; };

    instance.rateLimitMiddleware(ctx.request, ctx.response, oldNext);

    // Rate limit might terminate - check if response ended
    if (!ctx.response.writableEnded && nextCalled && typeof next === 'function') {
      await next();
    }
  };
}

function pipelineCsrf(options = {}) {
  const instance = new SecurityMiddleware({ ...options, headers: false, cors: false, rateLimit: false });
  return async (ctx, next) => {
    let nextCalled = false;
    const oldNext = () => { nextCalled = true; };

    instance.csrfMiddleware(ctx.request, ctx.response, oldNext);

    // CSRF might terminate - check if response ended
    if (!ctx.response.writableEnded && nextCalled && typeof next === 'function') {
      await next();
    }
  };
}

export { SecurityMiddleware,
  security,
  securityHeaders,
  cors,
  rateLimit,
  csrf,
  generateCSRFToken,
  validateCSRFToken,
  SECURITY_HEADERS,
  // Pipeline-compatible exports
  pipelineSecurityHeaders,
  pipelineCors,
  pipelineRateLimit,
  pipelineCsrf };