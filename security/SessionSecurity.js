// version 1.0.1
// MasterController Session Security - Secure cookie handling, session fixation prevention

/**
 * Secure session handling for MasterController
 * Prevents: Session fixation, session hijacking, cookie theft
 */

import crypto from 'node:crypto';
import { logger } from '../error/MasterErrorLogger.js';

// Session store (use Redis in production)
const sessionStore = new Map();

/**
 * Parse a single cookie value by name from a Cookie header.
 *
 * SECURITY: anchored on cookie-boundary (start-of-string or "; "), so a
 * malicious sibling cookie like `Xmc_session=evil` cannot shadow `mc_session=`.
 * The previous regex-based parser was vulnerable to substring matching, which
 * enabled trivial session-fixation by an attacker who could set sibling cookies
 * (subdomain XSS, public Wi-Fi MITM on HTTP). The cookie name is matched
 * exactly via parse-and-compare, never interpolated into a regex (which would
 * have allowed regex injection via dotted custom cookie names).
 *
 * @param {string|undefined} header - Raw Cookie header value
 * @param {string} name - Exact cookie name to look up
 * @returns {string|null}
 */
function __parseCookieByName(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return part.slice(idx + 1).trim();
  }
  return null;
}

/**
 * Set-Cookie writer that preserves existing cookies on the response.
 *
 * SECURITY: res.setHeader('Set-Cookie', str) replaces any prior Set-Cookie
 * value. If middleware A sets a CSRF cookie and middleware B sets a session
 * cookie via plain setHeader, A's cookie is silently dropped — and the user
 * is silently logged out. This helper appends instead.
 *
 * @param {http.ServerResponse} res
 * @param {string} cookieString - Full cookie string (already formatted)
 */
function __appendSetCookie(res, cookieString) {
  if (!res || typeof res.setHeader !== 'function') return;
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', [cookieString]);
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookieString]);
  } else {
    res.setHeader('Set-Cookie', [existing, cookieString]);
  }
}

// v2.1.0: cookie name / attribute-value validators.
//
// RFC 6265 token: only ASCII visible chars minus separators. This is stricter
// than "no CRLF", intentionally — the previous code interpolated caller-
// supplied strings straight into a Set-Cookie header, so `sid\r\nSet-Cookie:
// admin=1` was a response-splitting hole. Rejecting anything outside the RFC
// token set closes the family of encoding tricks that also work.
const __COOKIE_NAME_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;
function __assertCookieName(name) {
  if (typeof name !== 'string' || name.length === 0 || !__COOKIE_NAME_RE.test(name)) {
    throw new Error(`Invalid cookie name: control characters, CRLF, or RFC 6265 separators are not permitted. Got: ${JSON.stringify(name)}`);
  }
}

// Cookie attribute values (Path, Domain, SameSite): reject any control or
// CRLF character. We don't apply the full RFC 6265 grammar here because
// different attribute values have different allowed sets — but every one of
// them forbids CR, LF, and NUL, so this is a hard floor.
function __assertCookieAttrValue(attrName, value) {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${attrName} value: must be a string`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F;,]/.test(value)) {
    throw new Error(`Invalid ${attrName} value: control character, CRLF, ';' or ',' is not permitted`);
  }
}

class SessionSecurity {
  constructor(options = {}) {
    this.cookieName = options.cookieName || 'mc_session';
    this.secret = options.secret || this._generateSecret();
    this.maxAge = options.maxAge || 86400000; // 24 hours
    this.httpOnly = options.httpOnly !== false;
    this.secure = options.secure !== false; // Only send over HTTPS
    this.sameSite = options.sameSite || 'strict'; // 'strict', 'lax', or 'none'
    this.rolling = options.rolling !== false; // Extend expiry on each request
    this.regenerateInterval = options.regenerateInterval || 3600000; // 1 hour
    this.domain = options.domain || null;
    this.path = options.path || '/';

    // Session fingerprinting (disabled by default like ASP.NET Core)
    this.useFingerprint = options.useFingerprint === true;

    // Start cleanup interval
    this._startCleanup();
  }

  /**
   * Session middleware
   */
  middleware() {
    const self = this;

    // Return pipeline-compatible (ctx, next) middleware.
    // MasterPipeline.execute() calls handler(ctx, next), not handler(req, res, next).
    return async (ctx, next) => {
      const req = ctx.request;
      const res = ctx.response;

      // Parse session from cookie
      const sessionId = self._parseCookie(req);

      if (sessionId) {
        // Load existing session
        const session = sessionStore.get(sessionId);

        if (session && self._isSessionValid(session, req)) {
          // Check if session needs regeneration
          if (self._shouldRegenerate(session)) {
            req.session = await self._regenerateSession(sessionId, session, res, req);
          } else {
            // Use existing session
            req.session = session.data;
            req.sessionId = sessionId;

            // Update last access time
            session.lastAccess = Date.now();

            // Extend expiry if rolling
            if (self.rolling) {
              session.expiry = Date.now() + self.maxAge;
              self._setCookie(res, sessionId);
            }
          }
        } else {
          // Invalid or expired session
          if (session) {
            sessionStore.delete(sessionId);
            logger.warn({
              code: 'MC_SECURITY_SESSION_INVALID',
              message: 'Invalid session detected',
              sessionId: sessionId.substring(0, 10) + '...'
            });
          }

          // Create new session
          req.session = await self._createSession(req, res);
        }
      } else {
        // No session cookie, create new session
        req.session = await self._createSession(req, res);
      }

      // Save session on response
      if (typeof res?.end === 'function') {
        const originalEnd = res.end;
        res.end = (...args) => {
          self._saveSession(req);
          originalEnd.apply(res, args);
        };
      }

      if (typeof next === 'function') {
        await next();
      }
    };
  }

  /**
   * Create new session
   */
  async _createSession(req, res) {
    const sessionId = this._generateSessionId();
    const fingerprint = this.useFingerprint ? this._generateFingerprint(req) : null;

    const sessionData = {
      id: sessionId,
      data: {},
      createdAt: Date.now(),
      lastAccess: Date.now(),
      expiry: Date.now() + this.maxAge,
      fingerprint,
      regeneratedAt: Date.now()
    };

    sessionStore.set(sessionId, sessionData);

    // Set cookie
    this._setCookie(res, sessionId);

    req.sessionId = sessionId;

    return sessionData.data;
  }

  /**
   * Rotate the session ID, preserving data. Call this AFTER any
   * authentication state change (login, role escalation, password change)
   * to defend against session fixation.
   *
   *   master.session.regenerate(ctx.request, ctx.response);
   *
   * @param {Object} req - request (must have req.sessionId from middleware)
   * @param {Object} res - response (new cookie will be appended)
   * @returns {string|null} The new session ID, or null if no session existed
   */
  regenerate(req, res) {
    if (!req || !req.sessionId) return null;
    const old = sessionStore.get(req.sessionId);
    if (!old) return null;

    const newSessionId = this._generateSessionId();
    const newSession = {
      id: newSessionId,
      data: { ...old.data },
      createdAt: old.createdAt,
      lastAccess: Date.now(),
      expiry: Date.now() + this.maxAge,
      fingerprint: old.fingerprint,
      regeneratedAt: Date.now()
    };

    sessionStore.delete(req.sessionId);
    sessionStore.set(newSessionId, newSession);
    req.sessionId = newSessionId;
    req.session = newSession.data;
    this._setCookie(res, newSessionId);

    logger.info({
      code: 'MC_SECURITY_SESSION_REGENERATED_EXPLICIT',
      message: 'Session ID rotated (explicit regenerate call)'
    });
    return newSessionId;
  }

  /**
   * Regenerate session (prevent session fixation)
   * Used internally by middleware on a time-based interval.
   */
  async _regenerateSession(oldSessionId, oldSession, res, req) {
    const newSessionId = this._generateSessionId();

    // Copy session data to new session
    const newSession = {
      id: newSessionId,
      data: { ...oldSession.data },
      createdAt: oldSession.createdAt,
      lastAccess: Date.now(),
      expiry: Date.now() + this.maxAge,
      fingerprint: oldSession.fingerprint,
      regeneratedAt: Date.now()
    };

    // Delete old session
    sessionStore.delete(oldSessionId);

    // Store new session
    sessionStore.set(newSessionId, newSession);

    // BUG FIX (v3.0): update req.sessionId so subsequent _saveSession writes
    // to the new session, not the deleted old one (which silently lost data).
    if (req) req.sessionId = newSessionId;

    // Update cookie
    this._setCookie(res, newSessionId);

    logger.info({
      code: 'MC_SECURITY_SESSION_REGENERATED',
      message: 'Session regenerated',
      oldSessionId: oldSessionId.substring(0, 10) + '...',
      newSessionId: newSessionId.substring(0, 10) + '...'
    });

    return newSession.data;
  }

  /**
   * Save session data
   */
  _saveSession(req) {
    if (!req.sessionId) return;

    const session = sessionStore.get(req.sessionId);
    if (session) {
      session.data = req.session;
      session.lastAccess = Date.now();
    }
  }

  /**
   * Check if session is valid
   */
  _isSessionValid(session, req) {
    // Check expiry
    if (Date.now() > session.expiry) {
      return false;
    }

    // Check fingerprint
    if (this.useFingerprint && session.fingerprint) {
      const currentFingerprint = this._generateFingerprint(req);
      if (currentFingerprint !== session.fingerprint) {
        logger.warn({
          code: 'MC_SECURITY_SESSION_HIJACK_ATTEMPT',
          message: 'Session hijacking attempt detected',
          sessionId: session.id.substring(0, 10) + '...',
          expectedFingerprint: session.fingerprint,
          actualFingerprint: currentFingerprint
        });
        return false;
      }
    }

    return true;
  }

  /**
   * Check if session should be regenerated
   */
  _shouldRegenerate(session) {
    const age = Date.now() - session.regeneratedAt;
    return age > this.regenerateInterval;
  }

  /**
   * Generate session ID
   */
  _generateSessionId() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Generate secret for signing
   */
  _generateSecret() {
    return crypto.randomBytes(64).toString('hex');
  }

  /**
   * Generate fingerprint for session hijacking detection
   */
  _generateFingerprint(req) {
    const headers = req?.headers || {};
    const components = [
      headers['user-agent'] || '',
      headers['accept-language'] || '',
      req?.connection?.remoteAddress || '',
      // Don't include Accept-Encoding (changes too often)
    ];

    return crypto
      .createHash('sha256')
      .update(components.join('|'))
      .digest('hex');
  }

  /**
   * Parse session cookie from request
   */
  _parseCookie(req) {
    return __parseCookieByName(req?.headers?.cookie, this.cookieName);
  }

  /**
   * Set session cookie
   */
  _setCookie(res, sessionId) {
    const options = [
      `${this.cookieName}=${sessionId}`,
      `Max-Age=${Math.floor(this.maxAge / 1000)}`,
      `Path=${this.path}`
    ];

    if (this.domain) {
      options.push(`Domain=${this.domain}`);
    }

    if (this.httpOnly) {
      options.push('HttpOnly');
    }

    if (this.secure) {
      options.push('Secure');
    }

    if (this.sameSite) {
      options.push(`SameSite=${this.sameSite}`);
    }

    __appendSetCookie(res, options.join('; '));
  }

  /**
   * Destroy session
   */
  destroySession(req, res) {
    if (req.sessionId) {
      sessionStore.delete(req.sessionId);

      // Clear cookie
      const options = [
        `${this.cookieName}=`,
        'Max-Age=0',
        `Path=${this.path}`
      ];

      if (this.domain) {
        options.push(`Domain=${this.domain}`);
      }

      __appendSetCookie(res, options.join('; '));

      req.session = null;
      req.sessionId = null;

      logger.info({
        code: 'MC_SECURITY_SESSION_DESTROYED',
        message: 'Session destroyed'
      });
    }
  }

  /**
   * Get session by ID
   */
  getSession(sessionId) {
    const session = sessionStore.get(sessionId);
    return session ? session.data : null;
  }

  /**
   * Update session expiry
   */
  touch(sessionId) {
    const session = sessionStore.get(sessionId);
    if (session) {
      session.lastAccess = Date.now();
      session.expiry = Date.now() + this.maxAge;
    }
  }

  /**
   * Cleanup expired sessions
   */
  _startCleanup() {
    this._cleanupInterval = setInterval(() => {
      const now = Date.now();
      let cleaned = 0;

      for (const [sessionId, session] of sessionStore.entries()) {
        if (now > session.expiry) {
          sessionStore.delete(sessionId);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        logger.info({
          code: 'MC_SECURITY_SESSION_CLEANUP',
          message: `Cleaned up ${cleaned} expired sessions`,
          context: { totalSessions: sessionStore.size }
        });
      }
    }, 60000);
    // v2.1.0: don't keep the process alive for this timer.
    if (this._cleanupInterval.unref) this._cleanupInterval.unref();
  }

  stop() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
  }

  /**
   * Get session store size (for monitoring)
   */
  getSessionCount() {
    return sessionStore.size;
  }

  /**
   * Clear all sessions (for testing)
   */
  clearAllSessions() {
    const count = sessionStore.size;
    sessionStore.clear();
    logger.warn({
      code: 'MC_SECURITY_ALL_SESSIONS_CLEARED',
      message: `Cleared all ${count} sessions`
    });
  }
}

// Create singleton instance
const session = new SessionSecurity();

/**
 * Factory functions
 */

function createSessionMiddleware(options = {}) {
  const instance = new SessionSecurity(options);
  return instance.middleware();
}

function destroySession(req, res) {
  return session.destroySession(req, res);
}

/**
 * Security best practices for sessions
 */

const SESSION_BEST_PRACTICES = {
  production: {
    secure: true,
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 3600000, // 1 hour
    regenerateInterval: 900000, // 15 minutes
    useFingerprint: true
  },
  development: {
    secure: false, // Allow HTTP in dev
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 86400000, // 24 hours
    regenerateInterval: 3600000, // 1 hour
    useFingerprint: true
  }
};

// Create MasterController-compatible wrapper
class MasterSessionSecurity {
  constructor(master) {
    // Constructor injection (replaces previous lazy require pattern)
    this._master = master;
    this._instance = null;
    this._options = {};
  }

  /**
   * Initialize session security (Rails/Django style)
   * Auto-registers with middleware pipeline
   */
  init(options = {}) {
    this._options = options;
    this._instance = new SessionSecurity(options);

    // Auto-register with pipeline if available
    if (this._master && this._master.pipeline) {
      this._master.pipeline.use(this._instance.middleware());
    }

    return this;
  }

  /**
   * Get middleware function
   */
  middleware() {
    if (!this._instance) {
      this.init();
    }
    return this._instance.middleware();
  }

  /**
   * Destroy session
   */
  destroy(req, res) {
    if (!this._instance) {
      throw new Error('SessionSecurity not initialized. Call master.session.init() first.');
    }
    return this._instance.destroySession(req, res);
  }

  /**
   * Rotate session ID (session-fixation defense — call after login).
   *   master.session.regenerate(ctx.request, ctx.response);
   */
  regenerate(req, res) {
    if (!this._instance) {
      throw new Error('SessionSecurity not initialized. Call master.session.init() first.');
    }
    return this._instance.regenerate(req, res);
  }

  /**
   * Get session by ID
   */
  getSession(sessionId) {
    if (!this._instance) {
      throw new Error('SessionSecurity not initialized. Call master.session.init() first.');
    }
    return this._instance.getSession(sessionId);
  }

  /**
   * Touch session (extend expiry)
   */
  touch(sessionId) {
    if (!this._instance) {
      throw new Error('SessionSecurity not initialized. Call master.session.init() first.');
    }
    return this._instance.touch(sessionId);
  }

  /**
   * Get session count (monitoring)
   */
  getSessionCount() {
    if (!this._instance) {
      throw new Error('SessionSecurity not initialized. Call master.session.init() first.');
    }
    return this._instance.getSessionCount();
  }

  /**
   * Clear all sessions (testing only)
   */
  clearAllSessions() {
    if (!this._instance) {
      throw new Error('SessionSecurity not initialized. Call master.session.init() first.');
    }
    return this._instance.clearAllSessions();
  }

  /**
   * Get recommended settings for environment
   */
  getBestPractices(env) {
    return SESSION_BEST_PRACTICES[env] || SESSION_BEST_PRACTICES.development;
  }

  /**
   * BACKWARD COMPATIBILITY: Cookie methods for legacy API
   * These methods provide compatibility with pre-v1.3.2 session API
   */

  /**
   * Get cookie from request
   * @param {Object} request - HTTP request object
   * @param {String} name - Cookie name
   * @returns {String|null} - Cookie value or null
   */
  getCookie(request, name) {
    const raw = __parseCookieByName(request?.headers?.cookie, name);
    if (raw == null) return null;
    try {
      return decodeURIComponent(raw);
    } catch (_) {
      return raw; // malformed encoding — return raw rather than throwing
    }
  }

  /**
   * Set cookie in response
   * @param {Object} response - HTTP response object
   * @param {String} name - Cookie name
   * @param {String} value - Cookie value
   * @param {Object} options - Cookie options
   * @param {Number} options.maxAge - Max age in seconds
   * @param {String} options.path - Cookie path (default: '/')
   * @param {String} options.domain - Cookie domain
   * @param {Boolean} options.secure - Secure flag (default: false)
   * @param {Boolean} options.httpOnly - HttpOnly flag (default: true)
   * @param {String} options.sameSite - SameSite attribute (default: 'lax')
   */
  setCookie(response, name, value, options = {}) {
    // v2.1.0 hardening: validate every attacker-influenced piece of the
    // Set-Cookie header before serialising. Prior versions interpolated
    // name / Path / Domain verbatim, so a controller that fed a request-
    // derived string into any of them could inject arbitrary headers via
    // CRLF (response splitting).
    __assertCookieName(name);
    const path = options.path || '/';
    __assertCookieAttrValue('Path', path);
    if (options.domain) __assertCookieAttrValue('Domain', options.domain);
    if (options.sameSite) __assertCookieAttrValue('SameSite', options.sameSite);

    // __Host- prefix: browsers silently drop the cookie unless
    // Secure=true, Path=/, and no Domain. Enforce these at write time so a
    // misconfigured caller fails loudly instead of shipping a broken cookie.
    if (typeof name === 'string' && name.startsWith('__Host-')) {
      if (!options.secure) {
        throw new Error(`__Host- prefixed cookie '${name}' requires secure: true`);
      }
      if (path !== '/') {
        throw new Error(`__Host- prefixed cookie '${name}' requires path: '/'`);
      }
      if (options.domain) {
        throw new Error(`__Host- prefixed cookie '${name}' must not set Domain`);
      }
    }
    if (typeof name === 'string' && name.startsWith('__Secure-') && !options.secure) {
      throw new Error(`__Secure- prefixed cookie '${name}' requires secure: true`);
    }

    const cookieOptions = [];

    cookieOptions.push(`${name}=${encodeURIComponent(value)}`);

    if (options.maxAge) {
      cookieOptions.push(`Max-Age=${options.maxAge}`);
    }

    cookieOptions.push(`Path=${path}`);

    if (options.domain) {
      cookieOptions.push(`Domain=${options.domain}`);
    }

    if (options.httpOnly !== false) {
      cookieOptions.push('HttpOnly');
    }

    if (options.secure) {
      cookieOptions.push('Secure');
    }

    if (options.sameSite) {
      cookieOptions.push(`SameSite=${options.sameSite}`);
    } else {
      cookieOptions.push('SameSite=Lax');
    }

    __appendSetCookie(response, cookieOptions.join('; '));
  }

  /**
   * Delete cookie from response
   * @param {Object} response - HTTP response object
   * @param {String} name - Cookie name
   * @param {Object} options - Cookie options (path, domain)
   */
  deleteCookie(response, name, options = {}) {
    const cookieOptions = [
      `${name}=`,
      'Max-Age=0',
      `Path=${options.path || '/'}`
    ];

    if (options.domain) {
      cookieOptions.push(`Domain=${options.domain}`);
    }

    __appendSetCookie(response, cookieOptions.join('; '));
  }
}

// Note: Auto-registration with MasterController happens in init() to avoid circular dependency
// This is called when master.session.init() is invoked in config.js

export { SessionSecurity,
  MasterSessionSecurity,
  session,
  createSessionMiddleware,
  destroySession,
  SESSION_BEST_PRACTICES };