/**
 * MasterAuth — authentication & authorization modeled on ASP.NET Core.
 *
 *   ASP.NET Core                                  MasterController
 *   AddAuthentication().AddJwtBearer(...)         master.auth.addJwtBearer('bearer', { secret | publicKey, issuer, audience })
 *   AddAuthentication().AddCookie(...)            master.auth.addCookie('cookie', { secret, loginPath, mode: 'web'|'api' })
 *   custom AuthenticationHandler                  master.auth.addScheme('apiKey', { type: 'custom', authenticate(requestObject) })
 *   AddAuthorization(o => o.AddPolicy(...))       master.auth.addPolicy('AdminOnly', { roles: ['admin'] } | (user, ctx) => bool)
 *   [Authorize] / [Authorize(Roles, Policy)]      route: router.route(p, 'c#a', 'get', { authorize: { roles: ['admin'] } })
 *                                                 controller: static authorize = { '*': true, index: false }
 *                                                 in-action: if (!(await this.authorize('AdminOnly'))) return;
 *   [AllowAnonymous]                              { allowAnonymous: true } / static allowAnonymous = ['index']
 *   HttpContext.User (ClaimsPrincipal)            requestObject.user / this.user  (isAuthenticated, id, name, roles, claims, hasClaim, isInRole)
 *   SignInAsync / SignOutAsync                    await this.signIn(claims) / await this.signOut()
 *   JwtSecurityTokenHandler                       master.auth.issueToken(claims, { expiresIn: '15m' }) / verifyToken(token)
 *   PasswordHasher<TUser>                         master.auth.passwordHasher.hash(pw) / verify(pw, stored)
 *   UseAuthentication()                           registered automatically before routing (never blocks; authorization decides)
 *   401 Challenge / 403 Forbid                    RFC 7807 ProblemDetails JSON (+ WWW-Authenticate) or redirect for cookie 'web' mode
 *
 * No dependencies beyond node:crypto and the `cookie` package already used by sessions.
 */
import crypto from 'node:crypto';
import cookie from 'cookie';
import { logger } from '../error/MasterErrorLogger.js';

// ---------------------------------------------------------------------------
// Claims principal (ASP.NET ClaimsPrincipal / ClaimsIdentity)
// ---------------------------------------------------------------------------

export class ClaimsPrincipal {
    /**
     * @param {Array<{type:string,value:*}>|Object} claims claim list, or an object
     *        ({ sub, name, roles: [...], email, ... }) flattened into claims
     * @param {{authenticationType?: string|null}} [opts]
     */
    constructor(claims = [], { authenticationType = null } = {}) {
        this.claims = ClaimsPrincipal._normalize(claims);
        this.authenticationType = authenticationType || null;
        Object.freeze(this.claims);
    }

    static _normalize(claims) {
        if (!claims) return [];
        if (Array.isArray(claims)) {
            return claims
                .filter(c => c && typeof c === 'object' && c.type !== undefined)
                .map(c => ({ type: String(c.type), value: c.value }));
        }
        if (typeof claims === 'object') {
            const out = [];
            for (const [k, v] of Object.entries(claims)) {
                if (v === undefined || v === null || typeof v === 'function') continue;
                if (k === 'roles' || k === 'role') { for (const r of [].concat(v)) out.push({ type: 'role', value: String(r) }); continue; }
                if (k === 'id' && !('sub' in claims)) { out.push({ type: 'sub', value: v }); continue; }
                if (Array.isArray(v)) { for (const item of v) out.push({ type: k, value: item }); continue; }
                if (typeof v === 'object') continue;          // nested objects are not claims
                out.push({ type: k, value: v });
            }
            return out;
        }
        return [];
    }

    static anonymous() { return new ClaimsPrincipal([], {}); }

    /** Build a principal from JWT payload / claims object / claim list / another principal. */
    static from(source, authenticationType) {
        if (source instanceof ClaimsPrincipal) {
            return source.authenticationType === authenticationType ? source : new ClaimsPrincipal(source.claims, { authenticationType });
        }
        return new ClaimsPrincipal(source, { authenticationType });
    }

    get isAuthenticated() { return !!this.authenticationType; }
    get id() { const v = this.findFirst('sub'); return v !== null ? v : this.findFirst('id'); }
    get name() {
        for (const t of ['name', 'preferred_username', 'username', 'email', 'sub']) { const v = this.findFirst(t); if (v !== null) return v; }
        return null;
    }
    get roles() { return this.findAll('role').map(String); }
    findFirst(type) { const c = this.claims.find(x => x.type === type); return c ? c.value : null; }
    findAll(type) { return this.claims.filter(x => x.type === type).map(x => x.value); }
    hasClaim(type, value) { return this.claims.some(x => x.type === type && (value === undefined || String(x.value) === String(value))); }
    isInRole(role) { return this.roles.includes(String(role)); }
    toJSON() {
        return { isAuthenticated: this.isAuthenticated, authenticationType: this.authenticationType, id: this.id, name: this.name, roles: this.roles, claims: this.claims };
    }
}

// ---------------------------------------------------------------------------
// JWT (HS256/384/512, RS256/384/512, PS256/384/512, ES256/384/512) — node:crypto only
// ---------------------------------------------------------------------------

export class JwtError extends Error {
    constructor(code, message) { super(message); this.name = 'JwtError'; this.code = code; }
}

const ALGS = {
    HS256: { kind: 'hmac', hash: 'sha256' }, HS384: { kind: 'hmac', hash: 'sha384' }, HS512: { kind: 'hmac', hash: 'sha512' },
    RS256: { kind: 'rsa', hash: 'sha256' }, RS384: { kind: 'rsa', hash: 'sha384' }, RS512: { kind: 'rsa', hash: 'sha512' },
    PS256: { kind: 'pss', hash: 'sha256' }, PS384: { kind: 'pss', hash: 'sha384' }, PS512: { kind: 'pss', hash: 'sha512' },
    ES256: { kind: 'ec', hash: 'sha256' }, ES384: { kind: 'ec', hash: 'sha384' }, ES512: { kind: 'ec', hash: 'sha512' },
};
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

/** '15m' | '2h' | '7d' | '30s' | number(seconds) -> seconds */
export function parseDuration(v) {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'number') return v;
    const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/i);
    if (!m) throw new TypeError(`Invalid duration '${v}' (use seconds or '30s' | '15m' | '2h' | '7d')`);
    const n = parseFloat(m[1]);
    const unit = (m[2] || 's').toLowerCase();
    const mult = { ms: 1 / 1000, s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[unit];
    return Math.round(n * mult);
}

function _keyFor(kind, key, forSign) {
    if (!key) throw new JwtError('no_key', 'JWT: a secret/key is required');
    if (kind === 'hmac') {
        if (typeof key === 'string' && key.length < 32) throw new JwtError('weak_key', 'JWT: HMAC secrets must be at least 32 characters (256 bits)');
        return key;
    }
    if (kind === 'pss') return { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST };
    if (kind === 'ec') return { key, dsaEncoding: 'ieee-p1363' };
    return key;   // rsa (PKCS#1 v1.5)
}

export const jwt = {
    /**
     * @param {Object} payload claims
     * @param {string|Buffer|KeyObject} key HMAC secret or private key (PEM/KeyObject)
     * @param {{algorithm?:string, expiresIn?:string|number, notBefore?:string|number, issuer?:string, audience?:string|string[], subject?:string, jwtid?:string, header?:Object, noTimestamp?:boolean}} [opts]
     */
    sign(payload, key, opts = {}) {
        const alg = opts.algorithm || 'HS256';
        const spec = ALGS[alg];
        if (!spec) throw new JwtError('alg_not_supported', `JWT: unsupported algorithm '${alg}'`);
        const now = Math.floor(Date.now() / 1000);
        const body = { ...payload };
        if (!opts.noTimestamp && body.iat === undefined) body.iat = now;
        const exp = parseDuration(opts.expiresIn);
        if (exp !== undefined) body.exp = now + exp;
        const nbf = parseDuration(opts.notBefore);
        if (nbf !== undefined) body.nbf = now + nbf;
        if (opts.issuer) body.iss = opts.issuer;
        if (opts.audience) body.aud = opts.audience;
        if (opts.subject !== undefined) body.sub = opts.subject;
        if (opts.jwtid) body.jti = opts.jwtid;
        const header = { alg, typ: 'JWT', ...(opts.header || {}) };
        const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(body))}`;
        const k = _keyFor(spec.kind, key, true);
        const sig = spec.kind === 'hmac'
            ? crypto.createHmac(spec.hash, k).update(signingInput).digest()
            : crypto.sign(spec.hash, Buffer.from(signingInput), k);
        return `${signingInput}.${b64u(sig)}`;
    },

    decode(token) {
        const parts = String(token || '').split('.');
        if (parts.length !== 3) throw new JwtError('malformed', 'JWT: malformed token');
        try {
            return { header: JSON.parse(unb64u(parts[0]).toString('utf8')), payload: JSON.parse(unb64u(parts[1]).toString('utf8')), signature: parts[2], signingInput: `${parts[0]}.${parts[1]}` };
        } catch (_) { throw new JwtError('malformed', 'JWT: malformed token'); }
    },

    /**
     * @param {string} token
     * @param {string|Buffer|KeyObject|function} key secret / public key, or (header, payload) => key (key resolver, e.g. by `kid`)
     * @param {{algorithms?:string[], issuer?:string|string[], audience?:string|string[], clockToleranceSec?:number, ignoreExpiration?:boolean, maxAgeSec?:number}} [opts]
     */
    verify(token, key, opts = {}) {
        const { header, payload, signature, signingInput } = jwt.decode(token);
        const allowed = opts.algorithms || ['HS256'];
        if (!header || typeof header.alg !== 'string' || !allowed.includes(header.alg)) throw new JwtError('alg_not_allowed', `JWT: algorithm '${header && header.alg}' is not allowed`);
        const spec = ALGS[header.alg];
        if (!spec) throw new JwtError('alg_not_supported', `JWT: unsupported algorithm '${header.alg}'`);
        const resolvedKey = typeof key === 'function' ? key(header, payload) : key;
        const k = _keyFor(spec.kind, resolvedKey, false);
        let valid = false;
        try {
            if (spec.kind === 'hmac') {
                const expected = crypto.createHmac(spec.hash, k).update(signingInput).digest();
                const given = unb64u(signature);
                valid = expected.length === given.length && crypto.timingSafeEqual(expected, given);
            } else {
                valid = crypto.verify(spec.hash, Buffer.from(signingInput), k, unb64u(signature));
            }
        } catch (_) { valid = false; }
        if (!valid) throw new JwtError('bad_signature', 'JWT: invalid signature');
        const now = Math.floor(Date.now() / 1000);
        const tol = opts.clockToleranceSec === undefined ? 60 : opts.clockToleranceSec;
        if (!opts.ignoreExpiration && typeof payload.exp === 'number' && now > payload.exp + tol) throw new JwtError('expired', 'JWT: token expired');
        if (typeof payload.nbf === 'number' && now + tol < payload.nbf) throw new JwtError('not_active', 'JWT: token not yet valid');
        if (opts.maxAgeSec && typeof payload.iat === 'number' && now > payload.iat + opts.maxAgeSec + tol) throw new JwtError('expired', 'JWT: token too old');
        if (opts.issuer) {
            const ok = [].concat(opts.issuer).includes(payload.iss);
            if (!ok) throw new JwtError('bad_issuer', 'JWT: issuer mismatch');
        }
        if (opts.audience) {
            const want = [].concat(opts.audience);
            const have = [].concat(payload.aud || []);
            if (!have.some(a => want.includes(a))) throw new JwtError('bad_audience', 'JWT: audience mismatch');
        }
        return payload;
    },
};

// ---------------------------------------------------------------------------
// Password hasher (ASP.NET PasswordHasher<TUser>) — scrypt, salted, constant-time
// ---------------------------------------------------------------------------

export class PasswordHasher {
    constructor({ N = 2 ** 15, r = 8, p = 1, keyLen = 64, saltLen = 16 } = {}) {
        Object.assign(this, { N, r, p, keyLen, saltLen });
    }
    /** -> "$scrypt$N=32768,r=8,p=1$<salt>$<hash>" (base64url) */
    async hash(password) {
        if (typeof password !== 'string' || password.length === 0) throw new TypeError('PasswordHasher.hash(password) requires a non-empty string');
        const salt = crypto.randomBytes(this.saltLen);
        const hash = await this._derive(password, salt, this.N, this.r, this.p, this.keyLen);
        return `$scrypt$N=${this.N},r=${this.r},p=${this.p}$${b64u(salt)}$${b64u(hash)}`;
    }
    /** -> { valid, needsRehash }  (needsRehash: stored params weaker than current) */
    async verify(password, stored) {
        const parsed = PasswordHasher.parse(stored);
        if (!parsed || typeof password !== 'string') return { valid: false, needsRehash: false };
        const hash = await this._derive(password, parsed.salt, parsed.N, parsed.r, parsed.p, parsed.hash.length);
        const valid = hash.length === parsed.hash.length && crypto.timingSafeEqual(hash, parsed.hash);
        const needsRehash = valid && (parsed.N < this.N || parsed.r < this.r || parsed.p < this.p || parsed.hash.length < this.keyLen);
        return { valid, needsRehash };
    }
    static parse(stored) {
        const m = typeof stored === 'string' && stored.match(/^\$scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/);
        if (!m) return null;
        return { N: +m[1], r: +m[2], p: +m[3], salt: unb64u(m[4]), hash: unb64u(m[5]) };
    }
    _derive(password, salt, N, r, p, keyLen) {
        return new Promise((resolve, reject) => {
            crypto.scrypt(password, salt, keyLen, { N, r, p, maxmem: 256 * N * r * 2 }, (err, key) => err ? reject(err) : resolve(key));
        });
    }
}

// ---------------------------------------------------------------------------
// Authentication + authorization service (master.auth)
// ---------------------------------------------------------------------------

const PROBLEM_TYPES = {
    401: 'https://tools.ietf.org/html/rfc9110#section-15.5.2',
    403: 'https://tools.ietf.org/html/rfc9110#section-15.5.4',
    500: 'https://tools.ietf.org/html/rfc9110#section-15.6.1',
};

export class AuthenticationService {
    constructor(master) {
        this._master = master;
        this._schemes = new Map();
        this._policies = new Map();
        this.defaultScheme = null;            // ASP.NET DefaultAuthenticateScheme
        this.defaultChallengeScheme = null;   // ASP.NET DefaultChallengeScheme
        this.passwordHasher = new PasswordHasher();
        this.realm = 'MasterController';
    }

    // ---- configuration (AddAuthentication / AddJwtBearer / AddCookie / AddPolicy) ----

    /**
     * Register an authentication scheme.
     * @param {string} name
     * @param {Object} options  { type: 'bearer'|'cookie'|'custom', ... } — see addJwtBearer / addCookie / custom:
     *        custom: { authenticate(requestObject) -> claims|ClaimsPrincipal|null, challenge?(requestObject, service), forbid?(...), signIn?(requestObject, principal, opts), signOut?(requestObject, opts) }
     */
    addScheme(name, options = {}) {
        if (!name || typeof name !== 'string') throw new TypeError('auth.addScheme(name, options) requires a scheme name');
        const type = options.type || (options.authenticate ? 'custom' : 'bearer');
        if (!['bearer', 'cookie', 'custom'].includes(type)) throw new TypeError(`auth.addScheme: unknown scheme type '${type}' (bearer | cookie | custom)`);
        if (type === 'custom' && typeof options.authenticate !== 'function') throw new TypeError(`auth.addScheme('${name}'): custom schemes need authenticate(requestObject)`);
        const scheme = { name, type, ...options };
        if (type === 'bearer') {
            scheme.algorithm = scheme.algorithm || 'HS256';
            scheme.algorithms = scheme.algorithms || [scheme.algorithm];
            if (!scheme.secret && !scheme.publicKey && !scheme.keyResolver) throw new TypeError(`auth.addJwtBearer('${name}'): provide secret (HS*), publicKey (RS*/PS*/ES*) or keyResolver`);
            if (scheme.secret && typeof scheme.secret === 'string' && scheme.secret.length < 32) throw new TypeError(`auth.addJwtBearer('${name}'): secret must be at least 32 characters`);
            scheme.header = scheme.header || 'authorization';
            scheme.clockToleranceSec = scheme.clockToleranceSec === undefined ? 60 : scheme.clockToleranceSec;
        }
        if (type === 'cookie') {
            if (!scheme.secret) throw new TypeError(`auth.addCookie('${name}'): a signing secret is required (string or [current, ...previous] for rotation)`);
            for (const s of [].concat(scheme.secret)) if (typeof s !== 'string' || s.length < 32) throw new TypeError(`auth.addCookie('${name}'): secrets must be at least 32 characters`);
            scheme.cookieName = scheme.cookieName || 'mc_auth';
            scheme.maxAgeMs = scheme.maxAgeMs || 14 * 24 * 3600 * 1000;        // ASP.NET default ExpireTimeSpan = 14 days
            scheme.slidingExpiration = scheme.slidingExpiration !== false;
            scheme.httpOnly = scheme.httpOnly !== false;
            scheme.sameSite = scheme.sameSite || 'lax';
            scheme.path = scheme.path || '/';
            scheme.secure = scheme.secure === undefined ? 'auto' : scheme.secure;
            scheme.mode = scheme.mode || 'api';                               // 'web' redirects to loginPath on challenge
            scheme.loginPath = scheme.loginPath || '/login';
            scheme.accessDeniedPath = scheme.accessDeniedPath || null;
            scheme.returnUrlParam = scheme.returnUrlParam || 'returnUrl';
        }
        this._schemes.set(name, scheme);
        if (!this.defaultScheme) this.defaultScheme = name;
        if (!this.defaultChallengeScheme) this.defaultChallengeScheme = name;
        return this;
    }
    addJwtBearer(name = 'bearer', options = {}) { return this.addScheme(name, { ...options, type: 'bearer' }); }
    addCookie(name = 'cookie', options = {}) { return this.addScheme(name, { ...options, type: 'cookie' }); }
    setDefaultScheme(name, { challenge } = {}) { this.scheme(name); this.defaultScheme = name; this.defaultChallengeScheme = challenge || name; return this; }
    scheme(name) {
        const s = this._schemes.get(name);
        if (!s) throw new Error(`auth: no authentication scheme named '${name}' (registered: ${[...this._schemes.keys()].join(', ') || 'none'})`);
        return s;
    }
    get schemes() { return [...this._schemes.keys()]; }

    /**
     * Register an authorization policy (ASP.NET AddPolicy).
     * @param {string} name
     * @param {Function|Object} requirement  (user, requestObject) => boolean|Promise<boolean>
     *        or { roles?: string[] (any), claims?: { type: value|values (all) }, requireAuthenticated?: boolean, handler?: fn }
     */
    addPolicy(name, requirement) {
        if (!name || typeof name !== 'string') throw new TypeError('auth.addPolicy(name, requirement) requires a name');
        if (typeof requirement !== 'function' && (!requirement || typeof requirement !== 'object')) throw new TypeError(`auth.addPolicy('${name}'): requirement must be a function or an object`);
        this._policies.set(name, requirement);
        return this;
    }
    policy(name) {
        const p = this._policies.get(name);
        if (!p) throw new Error(`auth: no authorization policy named '${name}' (registered: ${[...this._policies.keys()].join(', ') || 'none'})`);
        return p;
    }

    anonymous() { return ClaimsPrincipal.anonymous(); }

    // ---- authentication (UseAuthentication / AuthenticateAsync) ----

    /** Pipeline middleware: resolve ctx.user from the default scheme(s). Never blocks. */
    middleware() {
        const self = this;
        return async function authenticationMiddleware(ctx, next) {
            try {
                if (self._schemes.size > 0) await self.authenticate(ctx);
                else ctx.user = ClaimsPrincipal.anonymous();
            } catch (err) {
                ctx.user = ClaimsPrincipal.anonymous();
                logger.warn({ code: 'MC_AUTH_MIDDLEWARE_ERROR', message: err && err.message });
            }
            await next();
        };
    }

    /**
     * Authenticate a request against one or more schemes (first success wins).
     * Sets and returns requestObject.user (anonymous principal when nothing authenticates).
     */
    async authenticate(requestObject, schemeNames) {
        const names = schemeNames ? [].concat(schemeNames) : (this.defaultScheme ? [this.defaultScheme] : []);
        requestObject.__authFailures = [];
        for (const name of names) {
            const scheme = this.scheme(name);
            try {
                const principal = await this._authenticateWith(scheme, requestObject);
                if (principal && principal.isAuthenticated) {
                    requestObject.user = principal;
                    return principal;
                }
            } catch (err) {
                requestObject.__authFailures.push({ scheme: name, code: err && err.code, message: err && err.message });
                logger.info({ code: 'MC_AUTH_FAILED', scheme: name, reason: err && (err.code || err.message) });
            }
        }
        // Explicit scheme(s) that did not authenticate must NOT fall back to a
        // principal another scheme established earlier (ASP.NET AuthenticateAsync(scheme)).
        if (schemeNames) return ClaimsPrincipal.anonymous();
        if (!(requestObject.user instanceof ClaimsPrincipal) || !requestObject.user.isAuthenticated) requestObject.user = ClaimsPrincipal.anonymous();
        return requestObject.user;
    }

    async _authenticateWith(scheme, requestObject) {
        const req = requestObject.request || {};
        if (scheme.type === 'custom') {
            const result = await scheme.authenticate(requestObject, this);
            return result ? ClaimsPrincipal.from(result, scheme.name) : null;
        }
        if (scheme.type === 'bearer') {
            const token = this._bearerToken(scheme, req, requestObject);
            if (!token) return null;
            const key = scheme.keyResolver || scheme.publicKey || scheme.secret;
            const payload = jwt.verify(token, key, { algorithms: scheme.algorithms, issuer: scheme.issuer, audience: scheme.audience, clockToleranceSec: scheme.clockToleranceSec });
            let principal = ClaimsPrincipal.from(payload, scheme.name);
            if (typeof scheme.onAuthenticated === 'function') {
                const replaced = await scheme.onAuthenticated(principal, payload, requestObject);
                if (replaced) principal = ClaimsPrincipal.from(replaced, scheme.name);
            }
            requestObject.__authToken = token;
            return principal;
        }
        if (scheme.type === 'cookie') {
            const raw = this._readCookie(req, scheme.cookieName);
            if (!raw) return null;
            const data = this._openCookie(scheme, raw);
            if (!data) throw new JwtError('bad_signature', 'auth cookie: invalid signature');
            const now = Date.now();
            if (typeof data.exp === 'number' && now > data.exp) throw new JwtError('expired', 'auth cookie: expired');
            const principal = new ClaimsPrincipal(data.c || [], { authenticationType: scheme.name });
            if (scheme.slidingExpiration && typeof data.exp === 'number' && (data.exp - now) < scheme.maxAgeMs / 2) {
                this._writeCookie(scheme, requestObject, principal);   // renew (ASP.NET SlidingExpiration)
            }
            return principal;
        }
        return null;
    }

    _bearerToken(scheme, req, requestObject) {
        const h = req.headers && req.headers[scheme.header];
        if (typeof h === 'string') {
            const m = h.match(/^\s*Bearer\s+(.+?)\s*$/i);
            if (m) return m[1];
        }
        if (scheme.cookieName) { const c = this._readCookie(req, scheme.cookieName); if (c) return c; }
        if (scheme.queryParam && requestObject.requrl && requestObject.requrl.query) {
            const q = requestObject.requrl.query[scheme.queryParam];
            if (typeof q === 'string' && q) return q;
        }
        return null;
    }

    _readCookie(req, name) {
        const header = req && req.headers && req.headers.cookie;
        if (!header) return null;
        try { const parsed = cookie.parse(header); return parsed[name] || null; } catch (_) { return null; }
    }

    _cookieSecrets(scheme) { return [].concat(scheme.secret); }
    _sealCookie(scheme, data) {
        const payload = b64u(JSON.stringify(data));
        const sig = b64u(crypto.createHmac('sha256', this._cookieSecrets(scheme)[0]).update(payload).digest());
        return `${payload}.${sig}`;
    }
    _openCookie(scheme, raw) {
        const i = raw.lastIndexOf('.');
        if (i <= 0) return null;
        const payload = raw.slice(0, i), sig = unb64u(raw.slice(i + 1));
        for (const secret of this._cookieSecrets(scheme)) {
            const expected = crypto.createHmac('sha256', secret).update(payload).digest();
            if (expected.length === sig.length && crypto.timingSafeEqual(expected, sig)) {
                try { return JSON.parse(unb64u(payload).toString('utf8')); } catch (_) { return null; }
            }
        }
        return null;
    }
    _isSecure(scheme, requestObject) {
        if (scheme.secure === 'auto') {
            const req = requestObject && requestObject.request;
            return !!(req && this._master && typeof this._master.isRequestSecure === 'function' && this._master.isRequestSecure(req));
        }
        return !!scheme.secure;
    }
    _appendSetCookie(res, value) {
        if (!res || typeof res.getHeader !== 'function' || typeof res.setHeader !== 'function') return;
        const prev = res.getHeader('Set-Cookie');
        const list = prev === undefined ? [] : [].concat(prev);
        list.push(value);
        res.setHeader('Set-Cookie', list);
    }
    _writeCookie(scheme, requestObject, principal, { maxAgeMs } = {}) {
        const ttl = maxAgeMs || scheme.maxAgeMs;
        const data = { c: principal.claims, iat: Date.now(), exp: Date.now() + ttl };
        const value = this._sealCookie(scheme, data);
        const serialized = cookie.serialize(scheme.cookieName, value, {
            httpOnly: scheme.httpOnly, secure: this._isSecure(scheme, requestObject), sameSite: scheme.sameSite,
            path: scheme.path, domain: scheme.domain, maxAge: Math.floor(ttl / 1000),
        });
        this._appendSetCookie(requestObject.response, serialized);
        return value;
    }

    // ---- sign in / out / tokens (SignInAsync / SignOutAsync / token handler) ----

    /**
     * Establish the principal for the caller. Cookie scheme: writes the signed
     * auth cookie. Bearer scheme: returns an issued token (stateless). Custom:
     * delegates to scheme.signIn. Also sets requestObject.user.
     */
    async signIn(requestObject, principalOrClaims, { scheme: schemeName, ...opts } = {}) {
        const scheme = this.scheme(schemeName || this.defaultScheme);
        const principal = ClaimsPrincipal.from(principalOrClaims, scheme.name);
        if (!principal.claims.length) throw new TypeError('auth.signIn: the principal has no claims (pass { sub, name, roles } or a claims list)');
        requestObject.user = principal;
        if (scheme.type === 'cookie') {
            const maxAgeMs = opts.isPersistent === false ? Math.min(scheme.maxAgeMs, 24 * 3600 * 1000) : (opts.maxAgeMs || scheme.maxAgeMs);
            this._writeCookie(scheme, requestObject, principal, { maxAgeMs });
            // ASP.NET: rotate the session on authentication state changes (fixation)
            try { if (this._master && this._master.session && typeof this._master.session.regenerate === 'function' && requestObject.request && requestObject.request.session) this._master.session.regenerate(requestObject.request, requestObject.response); } catch (_) { /* no sessions */ }
            return principal;
        }
        if (scheme.type === 'bearer') {
            return { principal, token: this.issueToken(principal, { scheme: scheme.name, ...opts }) };
        }
        if (typeof scheme.signIn === 'function') { await scheme.signIn(requestObject, principal, opts); return principal; }
        throw new Error(`auth.signIn: scheme '${scheme.name}' does not support signIn`);
    }

    async signOut(requestObject, { scheme: schemeName } = {}) {
        const scheme = this.scheme(schemeName || this.defaultScheme);
        requestObject.user = ClaimsPrincipal.anonymous();
        if (scheme.type === 'cookie') {
            this._appendSetCookie(requestObject.response, cookie.serialize(scheme.cookieName, '', { httpOnly: scheme.httpOnly, secure: this._isSecure(scheme, requestObject), sameSite: scheme.sameSite, path: scheme.path, domain: scheme.domain, maxAge: 0, expires: new Date(0) }));
            return true;
        }
        if (typeof scheme.signOut === 'function') { await scheme.signOut(requestObject); return true; }
        return true;   // bearer: stateless — the client discards the token
    }

    /** Issue a JWT for a bearer scheme (JwtSecurityTokenHandler). */
    issueToken(principalOrClaims, { scheme: schemeName, expiresIn, ...opts } = {}) {
        const scheme = this.scheme(schemeName || this._firstSchemeOfType('bearer') || this.defaultScheme);
        if (scheme.type !== 'bearer') throw new Error(`auth.issueToken: scheme '${scheme.name}' is not a bearer scheme`);
        const key = scheme.privateKey || scheme.secret;
        if (!key) throw new Error(`auth.issueToken: scheme '${scheme.name}' has no secret/privateKey to sign with`);
        const claims = principalOrClaims instanceof ClaimsPrincipal ? principalOrClaims.claims : ClaimsPrincipal._normalize(principalOrClaims);
        const payload = {};
        for (const c of claims) {
            if (c.type === 'role') { (payload.role = payload.role || []).push(c.value); continue; }
            if (payload[c.type] === undefined) payload[c.type] = c.value;
            else payload[c.type] = [].concat(payload[c.type], c.value);
        }
        return jwt.sign(payload, key, { algorithm: scheme.algorithm, expiresIn: expiresIn || scheme.expiresIn || '1h', issuer: scheme.issuer, audience: scheme.audience, ...opts });
    }
    verifyToken(token, { scheme: schemeName } = {}) {
        const scheme = this.scheme(schemeName || this._firstSchemeOfType('bearer') || this.defaultScheme);
        return jwt.verify(token, scheme.keyResolver || scheme.publicKey || scheme.secret, { algorithms: scheme.algorithms, issuer: scheme.issuer, audience: scheme.audience, clockToleranceSec: scheme.clockToleranceSec });
    }
    _firstSchemeOfType(type) { for (const s of this._schemes.values()) if (s.type === type) return s.name; return null; }

    // ---- authorization ([Authorize], policies) ----

    /**
     * Normalize an authorize specification:
     *   true | 'PolicyName' | { policy, roles: [any], claims: {type: value|[values]} (all), schemes: [...], requireAuthenticated = true, handler(user, ctx) }
     *   false | 'anonymous' | { allowAnonymous: true } -> no requirement
     */
    static normalizeSpec(spec) {
        if (spec === false || spec === 'anonymous' || spec === null || spec === undefined) return null;
        if (spec === true) return { requireAuthenticated: true };
        if (typeof spec === 'string') return { policy: spec, requireAuthenticated: true };
        if (typeof spec === 'function') return { handler: spec, requireAuthenticated: true };
        if (Array.isArray(spec)) return { roles: spec, requireAuthenticated: true };
        if (typeof spec === 'object') {
            if (spec.allowAnonymous) return null;
            return { requireAuthenticated: true, ...spec, roles: spec.roles ? [].concat(spec.roles) : undefined, schemes: spec.schemes ? [].concat(spec.schemes) : undefined };
        }
        throw new TypeError(`auth: invalid authorize specification ${JSON.stringify(spec)}`);
    }

    /** Evaluate a requirement without writing a response. -> { allowed, reason: null | 'unauthenticated' | 'forbidden' } */
    async evaluate(requestObject, spec) {
        const req = AuthenticationService.normalizeSpec(spec);
        if (!req) return { allowed: true, reason: null };
        let user = requestObject.user;
        if (req.schemes || !(user instanceof ClaimsPrincipal)) user = await this.authenticate(requestObject, req.schemes);
        if (req.requireAuthenticated !== false && !user.isAuthenticated) return { allowed: false, reason: 'unauthenticated', user };
        const ok = await this._meets(req, user, requestObject);
        return { allowed: ok, reason: ok ? null : (user.isAuthenticated ? 'forbidden' : 'unauthenticated'), user };
    }

    async _meets(req, user, requestObject) {
        if (req.roles && req.roles.length && !req.roles.some(r => user.isInRole(r))) return false;
        if (req.claims) {
            for (const [type, want] of Object.entries(req.claims)) {
                const ok = want === undefined || want === true ? user.hasClaim(type) : [].concat(want).some(v => user.hasClaim(type, v));
                if (!ok) return false;
            }
        }
        if (req.policy) {
            for (const name of [].concat(req.policy)) {
                const requirement = this.policy(name);
                const ok = typeof requirement === 'function'
                    ? await requirement(user, requestObject, this)
                    : await this._meets(AuthenticationService.normalizeSpec(requirement) || {}, user, requestObject);
                if (!ok) return false;
            }
        }
        if (typeof req.handler === 'function' && !(await req.handler(user, requestObject, this))) return false;
        return true;
    }

    /**
     * Enforce an authorize specification: on failure writes 401 (challenge) or
     * 403 (forbid) and resolves false; resolves true when the request may proceed.
     */
    async enforce(requestObject, spec) {
        const req = AuthenticationService.normalizeSpec(spec);
        if (!req) return true;
        const result = await this.evaluate(requestObject, req);
        if (result.allowed) return true;
        const schemeName = req.schemes && req.schemes[0];
        if (result.reason === 'unauthenticated') await this.challenge(requestObject, schemeName);
        else await this.forbid(requestObject, schemeName);
        return false;
    }

    /** 401 (ASP.NET ChallengeAsync). Cookie schemes in 'web' mode redirect to loginPath?returnUrl=. */
    async challenge(requestObject, schemeName) {
        const res = requestObject.response;
        if (!res || res.headersSent || res._headerSent) return;
        const scheme = this._schemeOrNull(schemeName || this.defaultChallengeScheme);
        if (scheme && scheme.type === 'custom' && typeof scheme.challenge === 'function') return scheme.challenge(requestObject, this);
        if (scheme && scheme.type === 'cookie' && scheme.mode === 'web' && !this._wantsJson(requestObject)) {
            const returnUrl = requestObject.request && requestObject.request.url ? requestObject.request.url : '/';
            const target = `${scheme.loginPath}${scheme.loginPath.includes('?') ? '&' : '?'}${scheme.returnUrlParam}=${encodeURIComponent(returnUrl)}`;
            res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
            res.end();
            return;
        }
        const headers = {};
        if (!scheme || scheme.type === 'bearer') {
            const failed = (requestObject.__authFailures || []).find(f => f.scheme === (scheme ? scheme.name : undefined)) || (requestObject.__authFailures || [])[0];
            headers['WWW-Authenticate'] = failed
                ? `Bearer realm="${this.realm}", error="invalid_token", error_description="${String(failed.message || failed.code || 'invalid token').replace(/"/g, '')}"`
                : `Bearer realm="${this.realm}"`;
        }
        this._problem(requestObject, 401, 'Unauthorized', 'Authentication is required to access this resource.', headers);
    }

    /** 403 (ASP.NET ForbidAsync). */
    async forbid(requestObject, schemeName) {
        const res = requestObject.response;
        if (!res || res.headersSent || res._headerSent) return;
        const scheme = this._schemeOrNull(schemeName || this.defaultChallengeScheme);
        if (scheme && scheme.type === 'custom' && typeof scheme.forbid === 'function') return scheme.forbid(requestObject, this);
        if (scheme && scheme.type === 'cookie' && scheme.mode === 'web' && scheme.accessDeniedPath && !this._wantsJson(requestObject)) {
            res.writeHead(302, { Location: scheme.accessDeniedPath, 'Cache-Control': 'no-store' });
            res.end();
            return;
        }
        this._problem(requestObject, 403, 'Forbidden', 'You do not have permission to access this resource.');
    }

    _schemeOrNull(name) { return name ? (this._schemes.get(name) || null) : null; }
    _wantsJson(requestObject) {
        const accept = requestObject.request && requestObject.request.headers && requestObject.request.headers.accept;
        const xrw = requestObject.request && requestObject.request.headers && requestObject.request.headers['x-requested-with'];
        if (xrw === 'XMLHttpRequest') return true;
        if (!accept) return false;
        return /application\/json/.test(accept) && !/text\/html/.test(accept);
    }
    /** RFC 7807 problem details response. */
    _problem(requestObject, status, title, detail, extraHeaders = {}) {
        const res = requestObject.response;
        const body = JSON.stringify({
            type: PROBLEM_TYPES[status] || 'about:blank',
            title, status, detail,
            instance: requestObject.request && requestObject.request.url ? requestObject.request.url.split('?')[0] : undefined,
        });
        res.writeHead(status, { 'Content-Type': 'application/problem+json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...extraHeaders });
        res.end(body);
        logger.info({ code: status === 401 ? 'MC_AUTH_CHALLENGE' : 'MC_AUTH_FORBID', status, path: requestObject.pathName });
    }
}

// ---------------------------------------------------------------------------
// Controller mixin (registered through master.extendController): this.authorize(),
// this.signIn(), this.signOut(), this.issueToken(), this.challenge(), this.forbid().
// `this.user` is set per request by the router.
// ---------------------------------------------------------------------------

export class MasterAuthActions {
    static bindMaster(master) { MasterAuthActions.__master = master; }
    static _auth() {
        const m = MasterAuthActions.__master;
        if (!m || !m.auth) throw new Error('master.auth is not initialized (call master.setupServer() first)');
        return m.auth;
    }
    /** Enforce an authorize spec inside an action/filter: resolves false (response already written) or true. */
    async authorize(spec = true) { return MasterAuthActions._auth().enforce(this.__requestObject, spec); }
    /** Evaluate without writing a response. */
    async isAuthorized(spec = true) { return (await MasterAuthActions._auth().evaluate(this.__requestObject, spec)).allowed; }
    async signIn(principalOrClaims, opts) {
        const r = await MasterAuthActions._auth().signIn(this.__requestObject, principalOrClaims, opts);
        this.user = this.__requestObject.user;
        return r;
    }
    async signOut(opts) {
        const r = await MasterAuthActions._auth().signOut(this.__requestObject, opts);
        this.user = this.__requestObject.user;
        return r;
    }
    issueToken(principalOrClaims, opts) { return MasterAuthActions._auth().issueToken(principalOrClaims, opts); }
    challenge(scheme) { return MasterAuthActions._auth().challenge(this.__requestObject, scheme); }
    forbid(scheme) { return MasterAuthActions._auth().forbid(this.__requestObject, scheme); }
    currentUser() { return (this.__requestObject && this.__requestObject.user) || ClaimsPrincipal.anonymous(); }
}

/**
 * Resolve the authorize specification a controller class declares for an action:
 *   static authorize = true | 'Policy' | { roles } | { '*': spec, index: false, admin: 'AdminOnly' }
 *   static allowAnonymous = true | ['index', 'show']
 * -> spec, or undefined when nothing is required.
 */
export function resolveControllerAuthorize(Control, action) {
    if (!Control) return undefined;
    const anon = Control.allowAnonymous;
    if (anon === true || (Array.isArray(anon) && anon.includes(action))) return undefined;
    const spec = Control.authorize;
    if (spec === undefined || spec === null || spec === false) return undefined;
    const REQ_KEYS = ['policy', 'roles', 'claims', 'schemes', 'requireAuthenticated', 'handler', 'allowAnonymous'];
    if (spec && typeof spec === 'object' && !Array.isArray(spec) && !REQ_KEYS.some(k => k in spec)) {
        if (action in spec) return spec[action] === false ? undefined : spec[action];
        if ('*' in spec) return spec['*'] === false ? undefined : spec['*'];
        return undefined;
    }
    return spec;
}

export default AuthenticationService;
