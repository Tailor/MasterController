/**
 * RedisCSRFStore - Distributed CSRF token storage for horizontal scaling
 * Version: 1.0.0
 *
 * Stores CSRF tokens in Redis to enable token validation across multiple
 * MasterController instances in load-balanced deployments.
 *
 * Installation:
 *   npm install ioredis --save
 *
 * Usage:
 *
 *   const Redis = require('ioredis');
 *   const { RedisCSRFStore } = require('./security/adapters/RedisCSRFStore');
 *
 *   const redis = new Redis({ host: 'localhost', port: 6379 });
 *
 *   const csrfStore = new RedisCSRFStore(redis, {
 *     ttl: 3600  // 1 hour token lifetime
 *   });
 *
 *   // Use with MasterController CSRF middleware
 *   master.csrf.setStore(csrfStore);
 *
 * Features:
 * - Distributed CSRF token validation
 * - Automatic token expiration
 * - Per-session token storage
 * - Token rotation support
 * - Graceful degradation
 */

const crypto = require('crypto');
const { logger } = require('../../error/MasterErrorLogger');

class RedisCSRFStore {
  constructor(redisClient, options = {}) {
    if (!redisClient) {
      throw new Error('RedisCSRFStore requires a Redis client (ioredis)');
    }

    this.redis = redisClient;
    this.options = {
      prefix: options.prefix || 'mastercontroller:csrf:',
      ttl: options.ttl || 3600, // 1 hour default
      tokenLength: options.tokenLength || 32,
      ...options
    };

    logger.info({
      code: 'MC_CSRF_REDIS_INIT',
      message: 'Redis CSRF store initialized',
      prefix: this.options.prefix,
      ttl: this.options.ttl
    });
  }

  /**
   * Generate Redis key for CSRF token
   */
  _getKey(sessionId) {
    return `${this.options.prefix}${sessionId}`;
  }

  /**
   * Generate Redis key for token-to-session mapping
   */
  _getTokenKey(token) {
    return `${this.options.prefix}token:${token}`;
  }

  /**
   * Generate cryptographically secure token
   */
  _generateToken() {
    return crypto.randomBytes(this.options.tokenLength).toString('hex');
  }

  /**
   * Create new CSRF token for session
   */
  async create(sessionId) {
    try {
      const token = this._generateToken();
      const key = this._getKey(sessionId);
      const tokenKey = this._getTokenKey(token);

      // Store session -> token mapping
      await this.redis.setex(key, this.options.ttl, token);

      // Store token -> session mapping (for validation)
      await this.redis.setex(tokenKey, this.options.ttl, sessionId);

      logger.debug({
        code: 'MC_CSRF_TOKEN_CREATED',
        message: 'CSRF token created',
        sessionId: sessionId
      });

      return token;

    } catch (error) {
      logger.error({
        code: 'MC_CSRF_CREATE_ERROR',
        message: 'Failed to create CSRF token',
        sessionId: sessionId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Get CSRF token for session (or create if doesn't exist)
   */
  async get(sessionId) {
    try {
      const key = this._getKey(sessionId);
      const token = await this.redis.get(key);

      if (token) {
        logger.debug({
          code: 'MC_CSRF_TOKEN_RETRIEVED',
          message: 'CSRF token retrieved',
          sessionId: sessionId
        });
        return token;
      }

      // No token exists, create new one
      return await this.create(sessionId);

    } catch (error) {
      logger.error({
        code: 'MC_CSRF_GET_ERROR',
        message: 'Failed to get CSRF token',
        sessionId: sessionId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Validate CSRF token
   */
  async validate(sessionId, token) {
    try {
      if (!token || !sessionId) {
        return false;
      }

      const tokenKey = this._getTokenKey(token);
      const storedSessionId = await this.redis.get(tokenKey);

      if (!storedSessionId) {
        logger.warn({
          code: 'MC_CSRF_TOKEN_NOT_FOUND',
          message: 'CSRF token not found or expired',
          sessionId: sessionId
        });
        return false;
      }

      // Verify token belongs to this session
      if (storedSessionId !== sessionId) {
        logger.error({
          code: 'MC_CSRF_TOKEN_MISMATCH',
          message: 'CSRF token session mismatch - possible attack',
          sessionId: sessionId,
          tokenSession: storedSessionId
        });
        return false;
      }

      logger.debug({
        code: 'MC_CSRF_TOKEN_VALID',
        message: 'CSRF token validated',
        sessionId: sessionId
      });

      return true;

    } catch (error) {
      logger.error({
        code: 'MC_CSRF_VALIDATE_ERROR',
        message: 'Failed to validate CSRF token',
        sessionId: sessionId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Invalidate CSRF token
   */
  async invalidate(sessionId) {
    try {
      const key = this._getKey(sessionId);
      const token = await this.redis.get(key);

      if (token) {
        const tokenKey = this._getTokenKey(token);
        await this.redis.del(tokenKey);
      }

      await this.redis.del(key);

      logger.debug({
        code: 'MC_CSRF_TOKEN_INVALIDATED',
        message: 'CSRF token invalidated',
        sessionId: sessionId
      });

      return true;

    } catch (error) {
      logger.error({
        code: 'MC_CSRF_INVALIDATE_ERROR',
        message: 'Failed to invalidate CSRF token',
        sessionId: sessionId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Rotate CSRF token (invalidate old, create new)
   * Used after sensitive operations or periodically for security
   */
  async rotate(sessionId) {
    try {
      // Invalidate old token
      await this.invalidate(sessionId);

      // Create new token
      const newToken = await this.create(sessionId);

      logger.info({
        code: 'MC_CSRF_TOKEN_ROTATED',
        message: 'CSRF token rotated',
        sessionId: sessionId
      });

      return newToken;

    } catch (error) {
      logger.error({
        code: 'MC_CSRF_ROTATE_ERROR',
        message: 'Failed to rotate CSRF token',
        sessionId: sessionId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Refresh token TTL without changing the token
   */
  async refresh(sessionId) {
    try {
      const key = this._getKey(sessionId);
      const token = await this.redis.get(key);

      if (!token) {
        // No token exists, create new one
        return await this.create(sessionId);
      }

      // Refresh both mappings
      await this.redis.expire(key, this.options.ttl);

      const tokenKey = this._getTokenKey(token);
      await this.redis.expire(tokenKey, this.options.ttl);

      logger.debug({
        code: 'MC_CSRF_TOKEN_REFRESHED',
        message: 'CSRF token TTL refreshed',
        sessionId: sessionId
      });

      return token;

    } catch (error) {
      logger.error({
        code: 'MC_CSRF_REFRESH_ERROR',
        message: 'Failed to refresh CSRF token',
        sessionId: sessionId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Middleware factory for CSRF protection
   */
  middleware(options = {}) {
    const self = this;
    const {
      ignoreMethods = ['GET', 'HEAD', 'OPTIONS'],
      tokenHeader = 'x-csrf-token',
      tokenField = '_csrf',
      errorMessage = 'Invalid CSRF token'
    } = options;

    return async (ctx, next) => {
      try {
        // Get session ID from context
        const sessionId = ctx.session?.id || ctx.sessionId;

        if (!sessionId) {
          logger.warn({
            code: 'MC_CSRF_NO_SESSION',
            message: 'CSRF check skipped - no session ID',
            path: ctx.request.url
          });
          return await next();
        }

        // Skip CSRF check for safe methods
        const method = ctx.request.method.toUpperCase();
        if (ignoreMethods.includes(method)) {
          // Ensure token exists for this session
          await self.get(sessionId);
          return await next();
        }

        // Get token from request (header or body)
        const token = ctx.request.headers[tokenHeader.toLowerCase()]
          || ctx.body?.[tokenField]
          || ctx.query?.[tokenField];

        if (!token) {
          logger.warn({
            code: 'MC_CSRF_TOKEN_MISSING',
            message: 'CSRF token missing in request',
            sessionId: sessionId,
            path: ctx.request.url
          });

          ctx.response.statusCode = 403;
          ctx.response.setHeader('Content-Type', 'application/json');
          ctx.response.end(JSON.stringify({
            error: 'Forbidden',
            message: 'CSRF token required'
          }));
          return;
        }

        // Validate token
        const valid = await self.validate(sessionId, token);

        if (!valid) {
          logger.error({
            code: 'MC_CSRF_VALIDATION_FAILED',
            message: 'CSRF token validation failed',
            sessionId: sessionId,
            path: ctx.request.url,
            ip: ctx.request.connection.remoteAddress
          });

          ctx.response.statusCode = 403;
          ctx.response.setHeader('Content-Type', 'application/json');
          ctx.response.end(JSON.stringify({
            error: 'Forbidden',
            message: errorMessage
          }));
          return;
        }

        // Token valid, continue pipeline
        await next();

      } catch (error) {
        logger.error({
          code: 'MC_CSRF_MIDDLEWARE_ERROR',
          message: 'CSRF middleware error',
          error: error.message
        });

        // On error, deny for security (fail closed)
        ctx.response.statusCode = 500;
        ctx.response.end('Internal Server Error');
      }
    };
  }

  /**
   * Get CSRF token for use in templates/frontend
   */
  async getTokenForTemplate(sessionId) {
    return await this.get(sessionId);
  }

  /**
   * Cleanup expired tokens (maintenance task)
   * Note: Redis automatically expires keys, but this can be used for manual cleanup
   */
  async cleanup() {
    try {
      // Redis handles expiration automatically with TTL
      // This method is here for compatibility/manual cleanup if needed

      logger.info({
        code: 'MC_CSRF_CLEANUP',
        message: 'CSRF token cleanup completed (Redis auto-expires)'
      });

      return true;

    } catch (error) {
      logger.error({
        code: 'MC_CSRF_CLEANUP_ERROR',
        message: 'Failed to cleanup CSRF tokens',
        error: error.message
      });
      return false;
    }
  }
}

module.exports = {
  RedisCSRFStore
};
