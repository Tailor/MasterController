// version 1.0.1
// MasterController Session Security - Secure cookie handling, session fixation prevention

/**
 * Secure session handling for MasterController
 * Prevents: Session fixation, session hijacking, cookie theft
 */

const crypto = require('crypto');
const { logger } = require('../error/MasterErrorLogger');

// Session store (use Redis in production)
const sessionStore = new Map();

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

    // Session fingerprinting
    this.useFingerprint = options.useFingerprint !== false;

    // Start cleanup interval
    this._startCleanup();
  }

  /**
   * Session middleware
   */
  middleware() {
    return async (req, res, next) => {
      // Parse session from cookie
      const sessionId = this._parseCookie(req);

      if (sessionId) {
        // Load existing session
        const session = sessionStore.get(sessionId);

        if (session && this._isSessionValid(session, req)) {
          // Check if session needs regeneration
          if (this._shouldRegenerate(session)) {
            req.session = await this._regenerateSession(sessionId, session, res);
          } else {
            // Use existing session
            req.session = session.data;
            req.sessionId = sessionId;

            // Update last access time
            session.lastAccess = Date.now();

            // Extend expiry if rolling
            if (this.rolling) {
              session.expiry = Date.now() + this.maxAge;
              this._setCookie(res, sessionId);
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
          req.session = await this._createSession(req, res);
        }
      } else {
        // No session cookie, create new session
        req.session = await this._createSession(req, res);
      }

      // Save session on response
      const originalEnd = res.end;
      res.end = (...args) => {
        this._saveSession(req);
        originalEnd.apply(res, args);
      };

      next();
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
   * Regenerate session (prevent session fixation)
   */
  async _regenerateSession(oldSessionId, oldSession, res) {
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
    const components = [
      req.headers['user-agent'] || '',
      req.headers['accept-language'] || '',
      req.connection.remoteAddress || '',
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
    const cookies = req.headers.cookie;
    if (!cookies) return null;

    const match = cookies.match(new RegExp(`${this.cookieName}=([^;]+)`));
    return match ? match[1] : null;
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

    res.setHeader('Set-Cookie', options.join('; '));
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

      res.setHeader('Set-Cookie', options.join('; '));

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
    setInterval(() => {
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
          totalSessions: sessionStore.size
        });
      }
    }, 60000); // Run every minute
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

module.exports = {
  SessionSecurity,
  session,
  createSessionMiddleware,
  destroySession,
  SESSION_BEST_PRACTICES
};
