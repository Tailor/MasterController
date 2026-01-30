/**
 * RedisRateLimiter - Distributed rate limiting for horizontal scaling
 * Version: 1.0.0
 *
 * Implements rate limiting across multiple MasterController instances using Redis.
 * Essential for Fortune 500 load-balanced deployments to prevent API abuse.
 *
 * Installation:
 *   npm install ioredis --save
 *
 * Usage:
 *
 *   const Redis = require('ioredis');
 *   const { RedisRateLimiter } = require('./security/adapters/RedisRateLimiter');
 *
 *   const redis = new Redis({ host: 'localhost', port: 6379 });
 *
 *   const rateLimiter = new RedisRateLimiter(redis, {
 *     points: 100,          // Number of requests
 *     duration: 60,         // Per 60 seconds
 *     blockDuration: 300    // Block for 5 minutes on exceed
 *   });
 *
 *   // In MasterPipeline middleware:
 *   const allowed = await rateLimiter.consume(ctx.request.connection.remoteAddress);
 *   if (!allowed) {
 *     ctx.response.statusCode = 429;
 *     ctx.response.end('Too Many Requests');
 *     return;
 *   }
 *
 * Features:
 * - Token bucket algorithm with Redis
 * - Distributed rate limiting across instances
 * - Per-IP, per-user, or custom key limiting
 * - Automatic cleanup of expired keys
 * - Configurable block duration on limit exceed
 */

const { logger } = require('../../error/MasterErrorLogger');

class RedisRateLimiter {
  constructor(redisClient, options = {}) {
    if (!redisClient) {
      throw new Error('RedisRateLimiter requires a Redis client (ioredis)');
    }

    this.redis = redisClient;
    this.options = {
      prefix: options.prefix || 'mastercontroller:ratelimit:',
      points: options.points || 100,           // Max requests
      duration: options.duration || 60,        // Time window in seconds
      blockDuration: options.blockDuration || 0, // Block duration on exceed (0 = no block)
      execEvenly: options.execEvenly || false, // Spread requests evenly over duration
      ...options
    };

    logger.info({
      code: 'MC_RATELIMIT_REDIS_INIT',
      message: 'Redis rate limiter initialized',
      points: this.options.points,
      duration: this.options.duration
    });
  }

  /**
   * Generate Redis key for rate limit
   */
  _getKey(identifier) {
    return `${this.options.prefix}${identifier}`;
  }

  /**
   * Generate block key
   */
  _getBlockKey(identifier) {
    return `${this.options.prefix}block:${identifier}`;
  }

  /**
   * Consume points (check if request is allowed)
   * Returns object with: { allowed, remaining, resetAt }
   */
  async consume(identifier, points = 1) {
    try {
      const key = this._getKey(identifier);
      const blockKey = this._getBlockKey(identifier);
      const now = Date.now();

      // Check if identifier is blocked
      const blockExpiry = await this.redis.get(blockKey);
      if (blockExpiry && parseInt(blockExpiry) > now) {
        logger.debug({
          code: 'MC_RATELIMIT_BLOCKED',
          message: 'Request blocked due to rate limit',
          identifier: identifier,
          blockedUntil: new Date(parseInt(blockExpiry)).toISOString()
        });

        return {
          allowed: false,
          remaining: 0,
          resetAt: parseInt(blockExpiry),
          blocked: true
        };
      }

      // Use Lua script for atomic rate limiting
      const script = `
        local key = KEYS[1]
        local points = tonumber(ARGV[1])
        local duration = tonumber(ARGV[2])
        local max_points = tonumber(ARGV[3])
        local now = tonumber(ARGV[4])

        -- Get current counter
        local current = redis.call('GET', key)
        local ttl = redis.call('TTL', key)

        if current == false then
          -- First request, initialize counter
          redis.call('SETEX', key, duration, points)
          return {max_points - points, now + (duration * 1000)}
        else
          current = tonumber(current)

          if current + points <= max_points then
            -- Allow request
            redis.call('INCRBY', key, points)
            local remaining = max_points - (current + points)
            local reset_at = now + (ttl * 1000)
            return {remaining, reset_at}
          else
            -- Deny request (over limit)
            local reset_at = now + (ttl * 1000)
            return {0, reset_at}
          end
        end
      `;

      const result = await this.redis.eval(
        script,
        1,
        key,
        points,
        this.options.duration,
        this.options.points,
        now
      );

      const remaining = result[0];
      const resetAt = result[1];
      const allowed = remaining >= 0;

      if (!allowed) {
        // Over limit - create block if configured
        if (this.options.blockDuration > 0) {
          const blockUntil = now + (this.options.blockDuration * 1000);
          await this.redis.setex(
            blockKey,
            this.options.blockDuration,
            blockUntil.toString()
          );

          logger.warn({
            code: 'MC_RATELIMIT_EXCEEDED_BLOCKED',
            message: 'Rate limit exceeded, identifier blocked',
            identifier: identifier,
            blockDuration: this.options.blockDuration,
            blockedUntil: new Date(blockUntil).toISOString()
          });
        } else {
          logger.warn({
            code: 'MC_RATELIMIT_EXCEEDED',
            message: 'Rate limit exceeded',
            identifier: identifier
          });
        }
      }

      return {
        allowed: allowed,
        remaining: Math.max(0, remaining),
        resetAt: resetAt,
        blocked: false
      };

    } catch (error) {
      logger.error({
        code: 'MC_RATELIMIT_ERROR',
        message: 'Rate limit check failed',
        identifier: identifier,
        error: error.message
      });

      // On error, allow request (fail open for availability)
      return {
        allowed: true,
        remaining: this.options.points,
        resetAt: Date.now() + (this.options.duration * 1000),
        error: true
      };
    }
  }

  /**
   * Consume multiple points at once
   */
  async consumePoints(identifier, points) {
    return await this.consume(identifier, points);
  }

  /**
   * Get current rate limit status without consuming
   */
  async get(identifier) {
    try {
      const key = this._getKey(identifier);
      const blockKey = this._getBlockKey(identifier);
      const now = Date.now();

      // Check if blocked
      const blockExpiry = await this.redis.get(blockKey);
      if (blockExpiry && parseInt(blockExpiry) > now) {
        return {
          consumed: this.options.points,
          remaining: 0,
          resetAt: parseInt(blockExpiry),
          blocked: true
        };
      }

      // Get current consumption
      const consumed = await this.redis.get(key);
      const ttl = await this.redis.ttl(key);

      if (!consumed) {
        return {
          consumed: 0,
          remaining: this.options.points,
          resetAt: now + (this.options.duration * 1000),
          blocked: false
        };
      }

      const remaining = Math.max(0, this.options.points - parseInt(consumed));
      const resetAt = now + (ttl * 1000);

      return {
        consumed: parseInt(consumed),
        remaining: remaining,
        resetAt: resetAt,
        blocked: false
      };

    } catch (error) {
      logger.error({
        code: 'MC_RATELIMIT_GET_ERROR',
        message: 'Failed to get rate limit status',
        identifier: identifier,
        error: error.message
      });

      return {
        consumed: 0,
        remaining: this.options.points,
        resetAt: Date.now() + (this.options.duration * 1000),
        error: true
      };
    }
  }

  /**
   * Reset rate limit for identifier
   */
  async reset(identifier) {
    try {
      const key = this._getKey(identifier);
      const blockKey = this._getBlockKey(identifier);

      await this.redis.del(key);
      await this.redis.del(blockKey);

      logger.debug({
        code: 'MC_RATELIMIT_RESET',
        message: 'Rate limit reset',
        identifier: identifier
      });

      return true;

    } catch (error) {
      logger.error({
        code: 'MC_RATELIMIT_RESET_ERROR',
        message: 'Failed to reset rate limit',
        identifier: identifier,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Block identifier for specified duration (seconds)
   */
  async block(identifier, duration = null) {
    try {
      const blockKey = this._getBlockKey(identifier);
      const blockDuration = duration || this.options.blockDuration;
      const blockUntil = Date.now() + (blockDuration * 1000);

      await this.redis.setex(
        blockKey,
        blockDuration,
        blockUntil.toString()
      );

      logger.info({
        code: 'MC_RATELIMIT_MANUAL_BLOCK',
        message: 'Identifier manually blocked',
        identifier: identifier,
        duration: blockDuration,
        blockedUntil: new Date(blockUntil).toISOString()
      });

      return true;

    } catch (error) {
      logger.error({
        code: 'MC_RATELIMIT_BLOCK_ERROR',
        message: 'Failed to block identifier',
        identifier: identifier,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Unblock identifier
   */
  async unblock(identifier) {
    try {
      const blockKey = this._getBlockKey(identifier);
      await this.redis.del(blockKey);

      logger.info({
        code: 'MC_RATELIMIT_UNBLOCK',
        message: 'Identifier unblocked',
        identifier: identifier
      });

      return true;

    } catch (error) {
      logger.error({
        code: 'MC_RATELIMIT_UNBLOCK_ERROR',
        message: 'Failed to unblock identifier',
        identifier: identifier,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Check if identifier is blocked
   */
  async isBlocked(identifier) {
    try {
      const blockKey = this._getBlockKey(identifier);
      const blockExpiry = await this.redis.get(blockKey);

      if (blockExpiry && parseInt(blockExpiry) > Date.now()) {
        return {
          blocked: true,
          blockedUntil: parseInt(blockExpiry)
        };
      }

      return {
        blocked: false,
        blockedUntil: null
      };

    } catch (error) {
      logger.error({
        code: 'MC_RATELIMIT_IS_BLOCKED_ERROR',
        message: 'Failed to check block status',
        identifier: identifier,
        error: error.message
      });
      return {
        blocked: false,
        blockedUntil: null,
        error: true
      };
    }
  }

  /**
   * Middleware factory for MasterPipeline
   */
  middleware(options = {}) {
    const self = this;
    const keyGenerator = options.keyGenerator || ((ctx) => {
      // Default: use IP address
      return ctx.request.connection.remoteAddress || 'unknown';
    });

    return async (ctx, next) => {
      try {
        const identifier = keyGenerator(ctx);
        const result = await self.consume(identifier);

        // Add rate limit headers to response
        ctx.response.setHeader('X-RateLimit-Limit', self.options.points);
        ctx.response.setHeader('X-RateLimit-Remaining', result.remaining);
        ctx.response.setHeader('X-RateLimit-Reset', new Date(result.resetAt).toISOString());

        if (!result.allowed) {
          // Rate limit exceeded
          ctx.response.statusCode = 429;
          ctx.response.setHeader('Content-Type', 'application/json');
          ctx.response.setHeader('Retry-After', Math.ceil((result.resetAt - Date.now()) / 1000));

          const errorResponse = {
            error: 'Too Many Requests',
            message: 'Rate limit exceeded',
            limit: self.options.points,
            resetAt: new Date(result.resetAt).toISOString()
          };

          if (result.blocked) {
            errorResponse.blocked = true;
            errorResponse.message = 'Rate limit exceeded. Temporarily blocked.';
          }

          ctx.response.end(JSON.stringify(errorResponse, null, 2));
          return; // Don't call next()
        }

        // Request allowed, continue pipeline
        await next();

      } catch (error) {
        logger.error({
          code: 'MC_RATELIMIT_MIDDLEWARE_ERROR',
          message: 'Rate limit middleware error',
          error: error.message
        });

        // On error, allow request (fail open)
        await next();
      }
    };
  }
}

module.exports = {
  RedisRateLimiter
};
