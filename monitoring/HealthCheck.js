/**
 * HealthCheck - Production-ready health monitoring endpoint
 * Version: 1.0.0
 *
 * Provides a /_health endpoint for load balancers, orchestrators (Kubernetes, Docker Swarm),
 * and monitoring tools (Datadog, New Relic, etc.)
 *
 * Usage in MasterControl pipeline:
 *
 *   const { healthCheck } = require('./monitoring/HealthCheck');
 *   master.pipeline.use(healthCheck.middleware());
 *
 * Health check endpoint: GET /_health
 * Returns: { status: 'healthy', uptime, memory, version, timestamp }
 */

const os = require('os');
const { logger } = require('../error/MasterErrorLogger');

class HealthCheck {
  constructor(options = {}) {
    this.options = {
      endpoint: options.endpoint || '/_health',
      includeDetails: options.includeDetails !== false,
      customChecks: options.customChecks || [],
      timeout: options.timeout || 5000, // 5 seconds
      ...options
    };

    this.startTime = Date.now();
    this.version = options.version || require('../package.json').version;
    this.customHealthChecks = [];
  }

  /**
   * Add custom health check function
   * @param {string} name - Name of the health check
   * @param {Function} checkFn - Async function that returns { healthy: boolean, details?: any }
   */
  addCheck(name, checkFn) {
    if (typeof checkFn !== 'function') {
      throw new Error('Health check must be a function');
    }
    this.customHealthChecks.push({ name, checkFn });
  }

  /**
   * Middleware for MasterPipeline
   */
  middleware() {
    const self = this;

    return async (ctx, next) => {
      const requestPath = ctx.request.url.split('?')[0];

      // Only handle health check endpoint
      if (requestPath !== self.options.endpoint) {
        return await next();
      }

      // Log health check request
      logger.debug({
        code: 'MC_HEALTH_CHECK',
        message: 'Health check requested',
        ip: ctx.request.connection.remoteAddress
      });

      try {
        const health = await self.check();

        // Set response headers
        ctx.response.setHeader('Content-Type', 'application/json');
        ctx.response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        ctx.response.setHeader('X-Content-Type-Options', 'nosniff');

        // Set status code based on health
        ctx.response.statusCode = health.status === 'healthy' ? 200 : 503;

        // Send response
        ctx.response.end(JSON.stringify(health, null, 2));

      } catch (error) {
        logger.error({
          code: 'MC_HEALTH_CHECK_ERROR',
          message: 'Health check failed',
          error: error.message,
          stack: error.stack
        });

        // Return unhealthy status
        ctx.response.statusCode = 503;
        ctx.response.setHeader('Content-Type', 'application/json');
        ctx.response.end(JSON.stringify({
          status: 'unhealthy',
          error: error.message,
          timestamp: new Date().toISOString()
        }, null, 2));
      }

      // Don't call next() - this is a terminal endpoint
    };
  }

  /**
   * Perform health check
   */
  async check() {
    const startTime = Date.now();

    try {
      // Basic system metrics
      const uptime = process.uptime();
      const memory = process.memoryUsage();
      const cpuUsage = process.cpuUsage();

      // System information
      const systemInfo = {
        platform: process.platform,
        nodeVersion: process.version,
        arch: process.arch,
        cpus: os.cpus().length,
        totalMemory: os.totalmem(),
        freeMemory: os.freemem(),
        loadAverage: os.loadavg()
      };

      // Run custom health checks
      const customChecks = {};
      let allHealthy = true;

      for (const check of this.customHealthChecks) {
        try {
          const result = await Promise.race([
            check.checkFn(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Health check timeout')), this.options.timeout)
            )
          ]);

          customChecks[check.name] = result;

          if (result.healthy === false) {
            allHealthy = false;
          }
        } catch (error) {
          customChecks[check.name] = {
            healthy: false,
            error: error.message
          };
          allHealthy = false;
        }
      }

      // Memory health check (fail if >90% memory used)
      const memoryUsagePercent = (memory.heapUsed / memory.heapTotal) * 100;
      const memoryHealthy = memoryUsagePercent < 90;

      if (!memoryHealthy) {
        allHealthy = false;
        logger.warn({
          code: 'MC_HEALTH_MEMORY_HIGH',
          message: 'Memory usage critically high',
          memoryUsagePercent: memoryUsagePercent.toFixed(2),
          heapUsed: memory.heapUsed,
          heapTotal: memory.heapTotal
        });
      }

      // Build response
      const response = {
        status: allHealthy && memoryHealthy ? 'healthy' : 'degraded',
        uptime: Math.floor(uptime),
        version: this.version,
        timestamp: new Date().toISOString(),
        responseTime: Date.now() - startTime
      };

      // Add detailed metrics if enabled
      if (this.options.includeDetails) {
        response.memory = {
          heapUsed: memory.heapUsed,
          heapTotal: memory.heapTotal,
          rss: memory.rss,
          external: memory.external,
          usagePercent: memoryUsagePercent.toFixed(2)
        };

        response.cpu = {
          user: cpuUsage.user,
          system: cpuUsage.system
        };

        response.system = systemInfo;

        if (Object.keys(customChecks).length > 0) {
          response.checks = customChecks;
        }
      }

      return response;

    } catch (error) {
      logger.error({
        code: 'MC_HEALTH_CHECK_FAILURE',
        message: 'Health check encountered error',
        error: error.message,
        stack: error.stack
      });

      return {
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString(),
        responseTime: Date.now() - startTime
      };
    }
  }

  /**
   * Express/Connect compatible middleware (for compatibility)
   */
  expressMiddleware() {
    const self = this;

    return async (req, res, next) => {
      const requestPath = req.url.split('?')[0];

      if (requestPath !== self.options.endpoint) {
        return next();
      }

      try {
        const health = await self.check();

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.statusCode = health.status === 'healthy' ? 200 : 503;
        res.end(JSON.stringify(health, null, 2));

      } catch (error) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          status: 'unhealthy',
          error: error.message,
          timestamp: new Date().toISOString()
        }, null, 2));
      }
    };
  }

  /**
   * Get uptime in seconds
   */
  getUptime() {
    return Math.floor(process.uptime());
  }

  /**
   * Get memory stats
   */
  getMemory() {
    return process.memoryUsage();
  }

  /**
   * Manual health check (for internal use)
   */
  async isHealthy() {
    const result = await this.check();
    return result.status === 'healthy';
  }
}

// Singleton instance
const healthCheck = new HealthCheck({
  endpoint: '/_health',
  includeDetails: process.env.NODE_ENV !== 'production' // Hide details in production for security
});

/**
 * Example custom health checks
 */

// Database health check example
function createDatabaseCheck(db) {
  return async () => {
    try {
      // Example: Check database connectivity
      await db.ping(); // or db.query('SELECT 1')
      return { healthy: true, details: { connected: true } };
    } catch (error) {
      return { healthy: false, error: error.message };
    }
  };
}

// Redis health check example
function createRedisCheck(redis) {
  return async () => {
    try {
      await redis.ping();
      return { healthy: true, details: { connected: true } };
    } catch (error) {
      return { healthy: false, error: error.message };
    }
  };
}

// API dependency health check example
function createAPIHealthCheck(apiUrl) {
  return async () => {
    try {
      const https = require('https');
      const http = require('http');

      return new Promise((resolve) => {
        const client = apiUrl.startsWith('https') ? https : http;
        const req = client.get(apiUrl, (res) => {
          resolve({
            healthy: res.statusCode >= 200 && res.statusCode < 300,
            details: { statusCode: res.statusCode }
          });
        });

        req.on('error', (error) => {
          resolve({ healthy: false, error: error.message });
        });

        req.setTimeout(3000, () => {
          req.destroy();
          resolve({ healthy: false, error: 'Timeout' });
        });
      });
    } catch (error) {
      return { healthy: false, error: error.message };
    }
  };
}

module.exports = {
  HealthCheck,
  healthCheck,
  createDatabaseCheck,
  createRedisCheck,
  createAPIHealthCheck
};
