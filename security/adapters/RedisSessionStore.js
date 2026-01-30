/**
 * RedisSessionStore - Redis-based session storage for horizontal scaling
 * Version: 1.0.0
 *
 * Enables distributed session management across multiple MasterController instances.
 * Essential for load-balanced, horizontally scaled Fortune 500 deployments.
 *
 * Installation:
 *   npm install ioredis --save
 *
 * Usage:
 *
 *   const Redis = require('ioredis');
 *   const { RedisSessionStore } = require('./security/adapters/RedisSessionStore');
 *
 *   const redis = new Redis({
 *     host: 'localhost',
 *     port: 6379,
 *     // For production clusters:
 *     // cluster: [{ host: 'node1', port: 6379 }, { host: 'node2', port: 6379 }]
 *   });
 *
 *   const sessionStore = new RedisSessionStore(redis, {
 *     prefix: 'sess:',
 *     ttl: 86400 // 24 hours
 *   });
 *
 *   // Replace default session storage
 *   master.session.setStore(sessionStore);
 *
 * Features:
 * - Session sharing across multiple app instances
 * - Automatic TTL and expiration
 * - Session locking for race condition prevention
 * - Graceful degradation if Redis unavailable
 * - Connection pooling and retry logic
 */

const { logger } = require('../../error/MasterErrorLogger');

class RedisSessionStore {
  constructor(redisClient, options = {}) {
    if (!redisClient) {
      throw new Error('RedisSessionStore requires a Redis client (ioredis)');
    }

    this.redis = redisClient;
    this.options = {
      prefix: options.prefix || 'mastercontroller:session:',
      ttl: options.ttl || 86400, // 24 hours default
      scanCount: options.scanCount || 100,
      enableLocking: options.enableLocking !== false, // Session locking enabled by default
      lockTimeout: options.lockTimeout || 10000, // 10 seconds
      serializer: options.serializer || JSON,
      ...options
    };

    // Track connection status
    this.connected = false;

    // Setup Redis event handlers
    this._setupEventHandlers();

    logger.info({
      code: 'MC_SESSION_REDIS_INIT',
      message: 'Redis session store initialized',
      prefix: this.options.prefix,
      ttl: this.options.ttl
    });
  }

  /**
   * Setup Redis event handlers
   */
  _setupEventHandlers() {
    this.redis.on('connect', () => {
      this.connected = true;
      logger.info({
        code: 'MC_SESSION_REDIS_CONNECTED',
        message: 'Redis session store connected'
      });
    });

    this.redis.on('error', (err) => {
      logger.error({
        code: 'MC_SESSION_REDIS_ERROR',
        message: 'Redis session store error',
        error: err.message
      });
    });

    this.redis.on('close', () => {
      this.connected = false;
      logger.warn({
        code: 'MC_SESSION_REDIS_DISCONNECTED',
        message: 'Redis session store disconnected'
      });
    });
  }

  /**
   * Generate Redis key for session ID
   */
  _getKey(sessionId) {
    return `${this.options.prefix}${sessionId}`;
  }

  /**
   * Generate lock key for session ID
   */
  _getLockKey(sessionId) {
    return `${this.options.prefix}lock:${sessionId}`;
  }

  /**
   * Get session data
   */
  async get(sessionId) {
    try {
      const key = this._getKey(sessionId);
      const data = await this.redis.get(key);

      if (!data) {
        return null;
      }

      // Deserialize session data
      const session = this.options.serializer.parse(data);

      logger.debug({
        code: 'MC_SESSION_REDIS_GET',
        message: 'Session retrieved from Redis',
        sessionId: sessionId
      });

      return session;

    } catch (error) {
      logger.error({
        code: 'MC_SESSION_REDIS_GET_ERROR',
        message: 'Failed to get session from Redis',
        sessionId: sessionId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Set session data with TTL
   */
  async set(sessionId, sessionData, ttl = null) {
    try {
      const key = this._getKey(sessionId);
      const expiry = ttl || this.options.ttl;

      // Serialize session data
      const serialized = this.options.serializer.stringify(sessionData);

      // Set with expiry
      await this.redis.setex(key, expiry, serialized);

      logger.debug({
        code: 'MC_SESSION_REDIS_SET',
        message: 'Session saved to Redis',
        sessionId: sessionId,
        ttl: expiry
      });

      return true;

    } catch (error) {
      logger.error({
        code: 'MC_SESSION_REDIS_SET_ERROR',
        message: 'Failed to set session in Redis',
        sessionId: sessionId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Update session data and refresh TTL
   */
  async update(sessionId, sessionData, ttl = null) {
    return await this.set(sessionId, sessionData, ttl);
  }

  /**
   * Delete session
   */
  async destroy(sessionId) {
    try {
      const key = this._getKey(sessionId);
      await this.redis.del(key);

      // Also delete lock if exists
      if (this.options.enableLocking) {
        const lockKey = this._getLockKey(sessionId);
        await this.redis.del(lockKey);
      }

      logger.debug({
        code: 'MC_SESSION_REDIS_DESTROY',
        message: 'Session destroyed',
        sessionId: sessionId
      });

      return true;

    } catch (error) {
      logger.error({
        code: 'MC_SESSION_REDIS_DESTROY_ERROR',
        message: 'Failed to destroy session',
        sessionId: sessionId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Refresh session TTL without modifying data
   */
  async touch(sessionId, ttl = null) {
    try {
      const key = this._getKey(sessionId);
      const expiry = ttl || this.options.ttl;

      await this.redis.expire(key, expiry);

      logger.debug({
        code: 'MC_SESSION_REDIS_TOUCH',
        message: 'Session TTL refreshed',
        sessionId: sessionId,
        ttl: expiry
      });

      return true;

    } catch (error) {
      logger.error({
        code: 'MC_SESSION_REDIS_TOUCH_ERROR',
        message: 'Failed to touch session',
        sessionId: sessionId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Acquire lock on session (prevents race conditions)
   */
  async acquireLock(sessionId, timeout = null) {
    if (!this.options.enableLocking) {
      return true; // Locking disabled
    }

    try {
      const lockKey = this._getLockKey(sessionId);
      const lockTimeout = timeout || this.options.lockTimeout;
      const lockValue = `${Date.now()}-${Math.random()}`; // Unique lock value

      // Try to set lock with NX (only if not exists)
      const acquired = await this.redis.set(
        lockKey,
        lockValue,
        'PX', // Milliseconds
        lockTimeout,
        'NX' // Only set if not exists
      );

      if (acquired === 'OK') {
        logger.debug({
          code: 'MC_SESSION_LOCK_ACQUIRED',
          message: 'Session lock acquired',
          sessionId: sessionId
        });
        return lockValue; // Return lock value for release
      }

      logger.warn({
        code: 'MC_SESSION_LOCK_FAILED',
        message: 'Failed to acquire session lock',
        sessionId: sessionId
      });
      return null;

    } catch (error) {
      logger.error({
        code: 'MC_SESSION_LOCK_ERROR',
        message: 'Error acquiring session lock',
        sessionId: sessionId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Release lock on session
   */
  async releaseLock(sessionId, lockValue) {
    if (!this.options.enableLocking || !lockValue) {
      return true;
    }

    try {
      const lockKey = this._getLockKey(sessionId);

      // Use Lua script to ensure we only delete our own lock
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;

      const result = await this.redis.eval(script, 1, lockKey, lockValue);

      if (result === 1) {
        logger.debug({
          code: 'MC_SESSION_LOCK_RELEASED',
          message: 'Session lock released',
          sessionId: sessionId
        });
        return true;
      }

      logger.warn({
        code: 'MC_SESSION_LOCK_RELEASE_FAILED',
        message: 'Lock value mismatch or already released',
        sessionId: sessionId
      });
      return false;

    } catch (error) {
      logger.error({
        code: 'MC_SESSION_LOCK_RELEASE_ERROR',
        message: 'Error releasing session lock',
        sessionId: sessionId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Get all session IDs (for admin/debugging)
   * WARNING: Can be slow on large datasets - use with caution
   */
  async getAllSessions() {
    try {
      const sessions = [];
      const pattern = `${this.options.prefix}*`;

      // Use SCAN for non-blocking iteration
      let cursor = '0';
      do {
        const [newCursor, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          this.options.scanCount
        );

        cursor = newCursor;

        // Filter out lock keys
        const sessionKeys = keys.filter(k => !k.includes(':lock:'));

        for (const key of sessionKeys) {
          const sessionId = key.replace(this.options.prefix, '');
          sessions.push(sessionId);
        }

      } while (cursor !== '0');

      logger.debug({
        code: 'MC_SESSION_REDIS_GET_ALL',
        message: 'Retrieved all session IDs',
        count: sessions.length
      });

      return sessions;

    } catch (error) {
      logger.error({
        code: 'MC_SESSION_REDIS_GET_ALL_ERROR',
        message: 'Failed to get all sessions',
        error: error.message
      });
      return [];
    }
  }

  /**
   * Get session count
   */
  async getSessionCount() {
    try {
      const sessions = await this.getAllSessions();
      return sessions.length;
    } catch (error) {
      logger.error({
        code: 'MC_SESSION_REDIS_COUNT_ERROR',
        message: 'Failed to count sessions',
        error: error.message
      });
      return 0;
    }
  }

  /**
   * Clear all sessions (for testing/maintenance)
   */
  async clearAll() {
    try {
      const sessions = await this.getAllSessions();

      for (const sessionId of sessions) {
        await this.destroy(sessionId);
      }

      logger.info({
        code: 'MC_SESSION_REDIS_CLEAR_ALL',
        message: 'All sessions cleared',
        count: sessions.length
      });

      return sessions.length;

    } catch (error) {
      logger.error({
        code: 'MC_SESSION_REDIS_CLEAR_ALL_ERROR',
        message: 'Failed to clear all sessions',
        error: error.message
      });
      return 0;
    }
  }

  /**
   * Check if store is connected and healthy
   */
  isHealthy() {
    return this.connected;
  }

  /**
   * Close Redis connection
   */
  async close() {
    try {
      await this.redis.quit();
      logger.info({
        code: 'MC_SESSION_REDIS_CLOSED',
        message: 'Redis session store closed'
      });
    } catch (error) {
      logger.error({
        code: 'MC_SESSION_REDIS_CLOSE_ERROR',
        message: 'Error closing Redis connection',
        error: error.message
      });
    }
  }
}

module.exports = {
  RedisSessionStore
};
