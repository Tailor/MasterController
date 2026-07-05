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

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../error/MasterErrorLogger.js';
import https from 'node:https';
import http from 'node:http';

// Resolve package.json version at module load time (replaces CJS require('../package.json'))
const __pkgFilename = fileURLToPath(import.meta.url);
const __pkgDir = path.dirname(path.dirname(__pkgFilename));
let __pkgVersion = 'unknown';
try {
  __pkgVersion = JSON.parse(fs.readFileSync(path.join(__pkgDir, 'package.json'), 'utf8')).version;
} catch (_) { /* ignore */ }

class HealthCheck {
  constructor(options = {}) {
    this.options = {
      endpoint: options.endpoint || '/_health',
      includeDetails: options.includeDetails !== false,
      customChecks: options.customChecks || [],
      timeout: options.timeout || 5000, // 5 seconds
      // v2.1.1: opt-in to expose the framework version. Prior versions
      // leaked it unconditionally, letting anyone with `curl` pin the
      // running mastercontroller version + known CVEs against it.
      exposeVersion: options.exposeVersion === true,
      // v2.1.1: authorize hook. If set, the middleware calls
      // authorize(ctx) → boolean and returns 403 when false. Recommended
      // default is to allow only internal networks (loopback + RFC 1918).
      // Left unset = current behavior (open access) for backward compat,
      // but the middleware WARN-logs an unauthenticated scrape once so
      // ops notice the exposure.
      authorize: typeof options.authorize === 'function' ? options.authorize : null,
      // v2.1.1: cache last-successful check result for `cacheTtl` ms so a
      // flood of /_health probes doesn't amplify into downstream work
      // (DB pings, upstream HTTPS checks, etc.).
      cacheTtl: options.cacheTtl !== undefined ? options.cacheTtl : 5000,
      ...options
    };

    this.startTime = Date.now();
    this.version = options.version || __pkgVersion;
    this.customHealthChecks = [];
    // Cache slot for the last successful check response.
    this._cachedResult = null;
    this._cachedAt = 0;
    this._loggedOpenAccessWarning = false;
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
        if (typeof next === 'function') return next();
        return;
      }

      // v2.1.1: authorize gate
      if (self.options.authorize) {
        let allowed = false;
        try { allowed = !!self.options.authorize(ctx); } catch (_) { allowed = false; }
        if (!allowed) {
          ctx.response.statusCode = 403;
          ctx.response.setHeader('Content-Type', 'application/json');
          ctx.response.end(JSON.stringify({ error: 'Forbidden' }));
          return;
        }
      } else if (!self._loggedOpenAccessWarning) {
        self._loggedOpenAccessWarning = true;
        logger.warn({
          code: 'MC_HEALTH_UNAUTHENTICATED',
          message: 'Health endpoint is open to any client. Configure `authorize` to restrict scrapers.'
        });
      }

      // Log health check request
      logger.debug({
        code: 'MC_HEALTH_CHECK',
        message: 'Health check requested'
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
    // v2.1.1: serve from cache if within TTL. `cacheTtl: 0` disables.
    if (this.options.cacheTtl > 0 && this._cachedResult
        && (Date.now() - this._cachedAt) < this.options.cacheTtl) {
      return this._cachedResult;
    }
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
        timestamp: new Date().toISOString(),
        responseTime: Date.now() - startTime
      };
      // v2.1.1: version is opt-in only. Prior versions leaked it
      // unconditionally, letting unauthenticated clients pin the running
      // mastercontroller version and target known CVEs against it.
      if (this.options.exposeVersion) {
        response.version = this.version;
      }

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

      // Populate cache for subsequent scrapes.
      if (this.options.cacheTtl > 0) {
        this._cachedResult = response;
        this._cachedAt = Date.now();
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
        if (typeof next === 'function') return next();
        return;
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

export { HealthCheck,
  healthCheck,
  createDatabaseCheck,
  createRedisCheck,
  createAPIHealthCheck };