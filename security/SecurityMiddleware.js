// version 1.0.1
// MasterController Security Middleware - CSRF, Headers, Rate Limiting, CORS

/**
 * Security middleware for MasterController
 * Provides: CSRF protection, Security headers, Rate limiting, CORS
 */

const crypto = require('crypto');
const { logger } = require('../error/MasterErrorLogger');

// Rate limiting store
const rateLimitStore = new Map();

// CSRF token store (use Redis in production)
const csrfTokenStore = new Map();

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
      return next();
    }

    // Apply standard security headers
    for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
      if (value === '') {
        res.removeHeader(header);
      } else {
        res.setHeader(header, value);
      }
    }

    // Apply HSTS only in production over HTTPS
    const isProduction = process.env.NODE_ENV === 'production';
    const isHTTPS = req.connection.encrypted || req.headers['x-forwarded-proto'] === 'https';

    if (isProduction && isHTTPS) {
      for (const [header, value] of Object.entries(HSTS_HEADER)) {
        res.setHeader(header, value);
      }
    }

    next();
  }

  /**
   * CORS middleware
   */
  corsMiddleware(req, res, next) {
    if (!this.corsEnabled) {
      return next();
    }

    const origin = req.headers.origin;

    // Check if origin is allowed
    if (this.corsOrigins.includes('*') || this.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
      res.setHeader('Access-Control-Allow-Methods', this.corsMethods.join(', '));
      res.setHeader('Access-Control-Allow-Headers', this.corsHeaders.join(', '));
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
    }

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    next();
  }

  /**
   * Rate limiting middleware
   */
  rateLimitMiddleware(req, res, next) {
    if (!this.rateLimitEnabled) {
      return next();
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

    next();
  }

  /**
   * CSRF protection middleware
   */
  csrfMiddleware(req, res, next) {
    if (!this.csrfEnabled) {
      return next();
    }

    // Skip CSRF for safe methods
    const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
    if (safeMethods.includes(req.method)) {
      return next();
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

    // Token valid, continue
    next();
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
   * Validate CSRF token manually
   */
  validateCSRFToken(token) {
    const storedToken = csrfTokenStore.get(token);

    if (!storedToken) {
      return { valid: false, reason: 'Token not found' };
    }

    if (Date.now() > storedToken.expiry) {
      csrfTokenStore.delete(token);
      return { valid: false, reason: 'Token expired' };
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
    // Check for forwarded IP (behind proxy/load balancer)
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      return forwarded.split(',')[0].trim();
    }

    // Check for real IP header
    if (req.headers['x-real-ip']) {
      return req.headers['x-real-ip'];
    }

    // Fall back to connection remote address
    return req.connection.remoteAddress || req.socket.remoteAddress || 'unknown';
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

module.exports = {
  SecurityMiddleware,
  security,
  securityHeaders,
  cors,
  rateLimit,
  csrf,
  generateCSRFToken,
  validateCSRFToken,
  SECURITY_HEADERS
};
