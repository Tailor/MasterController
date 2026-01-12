/**
 * MasterTimeout - Professional timeout system for MasterController
 *
 * Provides per-request timeout tracking with configurable options:
 * - Global timeout (all requests)
 * - Route-specific timeouts
 * - Controller-level timeouts
 * - Graceful cleanup on timeout
 * - Detailed timeout logging
 *
 * Inspired by Rails ActionController::Timeout and Django MIDDLEWARE_TIMEOUT
 *
 * @version 1.0.0
 */

const { logger } = require('./error/MasterErrorLogger');

class MasterTimeout {
    constructor() {
        this.globalTimeout = 120000; // 120 seconds default
        this.routeTimeouts = new Map();
        this.activeRequests = new Map();
        this.timeoutHandlers = [];
        this.enabled = true;
    }

    /**
     * Initialize timeout system
     *
     * @param {Object} options - Configuration options
     * @param {Number} options.globalTimeout - Default timeout in ms (default: 120000)
     * @param {Boolean} options.enabled - Enable/disable timeouts (default: true)
     * @param {Function} options.onTimeout - Custom timeout handler
     */
    init(options = {}) {
        if (options.globalTimeout) {
            this.globalTimeout = options.globalTimeout;
        }

        if (options.enabled !== undefined) {
            this.enabled = options.enabled;
        }

        if (options.onTimeout && typeof options.onTimeout === 'function') {
            this.timeoutHandlers.push(options.onTimeout);
        }

        logger.info({
            code: 'MC_TIMEOUT_INIT',
            message: 'Timeout system initialized',
            globalTimeout: this.globalTimeout,
            enabled: this.enabled
        });

        return this;
    }

    /**
     * Set timeout for specific route pattern
     *
     * @param {String} routePattern - Route pattern (e.g., '/api/*', '/admin/reports')
     * @param {Number} timeout - Timeout in milliseconds
     *
     * @example
     * master.timeout.setRouteTimeout('/api/*', 30000); // 30 seconds for APIs
     * master.timeout.setRouteTimeout('/admin/reports', 300000); // 5 minutes for reports
     */
    setRouteTimeout(routePattern, timeout) {
        if (typeof timeout !== 'number' || timeout <= 0) {
            throw new Error('Timeout must be a positive number in milliseconds');
        }

        this.routeTimeouts.set(routePattern, timeout);

        logger.info({
            code: 'MC_TIMEOUT_ROUTE_SET',
            message: 'Route timeout configured',
            routePattern,
            timeout
        });

        return this;
    }

    /**
     * Get timeout for request based on route
     * Priority: Route-specific > Global
     *
     * @param {String} path - Request path
     * @returns {Number} - Timeout in milliseconds
     */
    getTimeoutForPath(path) {
        // Check route-specific timeouts
        for (const [pattern, timeout] of this.routeTimeouts.entries()) {
            if (this._pathMatches(path, pattern)) {
                return timeout;
            }
        }

        // Return global timeout
        return this.globalTimeout;
    }

    /**
     * Start timeout tracking for request
     *
     * @param {Object} ctx - Request context
     * @returns {String} - Request ID
     */
    startTracking(ctx) {
        if (!this.enabled) {
            return null;
        }

        const requestId = this._generateRequestId();
        const timeout = this.getTimeoutForPath(ctx.pathName || ctx.request.url);
        const startTime = Date.now();

        const timer = setTimeout(() => {
            this._handleTimeout(requestId, ctx, startTime);
        }, timeout);

        this.activeRequests.set(requestId, {
            timer,
            timeout,
            startTime,
            path: ctx.pathName || ctx.request.url,
            method: ctx.type || ctx.request.method.toLowerCase()
        });

        // Attach cleanup to response finish
        ctx.response.once('finish', () => {
            this.stopTracking(requestId);
        });

        ctx.response.once('close', () => {
            this.stopTracking(requestId);
        });

        return requestId;
    }

    /**
     * Stop timeout tracking for request
     *
     * @param {String} requestId - Request ID
     */
    stopTracking(requestId) {
        const tracked = this.activeRequests.get(requestId);

        if (tracked) {
            clearTimeout(tracked.timer);
            this.activeRequests.delete(requestId);
        }
    }

    /**
     * Handle request timeout
     *
     * @private
     */
    _handleTimeout(requestId, ctx, startTime) {
        const tracked = this.activeRequests.get(requestId);

        if (!tracked) {
            return; // Already cleaned up
        }

        const duration = Date.now() - startTime;

        // Log timeout
        logger.error({
            code: 'MC_REQUEST_TIMEOUT',
            message: 'Request timeout exceeded',
            requestId,
            path: tracked.path,
            method: tracked.method,
            timeout: tracked.timeout,
            duration
        });

        // Call custom handlers
        for (const handler of this.timeoutHandlers) {
            try {
                handler(ctx, {
                    requestId,
                    path: tracked.path,
                    method: tracked.method,
                    timeout: tracked.timeout,
                    duration
                });
            } catch (err) {
                logger.error({
                    code: 'MC_TIMEOUT_HANDLER_ERROR',
                    message: 'Timeout handler threw error',
                    error: err.message
                });
            }
        }

        // Send timeout response if not already sent
        if (!ctx.response.headersSent) {
            ctx.response.statusCode = 504; // Gateway Timeout
            ctx.response.setHeader('Content-Type', 'application/json');
            ctx.response.end(JSON.stringify({
                error: 'Request Timeout',
                message: 'The server did not receive a complete request within the allowed time',
                code: 'MC_REQUEST_TIMEOUT',
                timeout: tracked.timeout
            }));
        }

        // Cleanup
        this.stopTracking(requestId);
    }

    /**
     * Get middleware function for pipeline
     *
     * @returns {Function} - Middleware function
     */
    middleware() {
        const $that = this;

        return async (ctx, next) => {
            if (!$that.enabled) {
                await next();
                return;
            }

            const requestId = $that.startTracking(ctx);
            ctx.requestId = requestId;

            try {
                await next();
            } catch (err) {
                // Stop tracking on error
                $that.stopTracking(requestId);
                throw err;
            }
        };
    }

    /**
     * Disable timeouts (useful for debugging)
     */
    disable() {
        this.enabled = false;
        logger.info({
            code: 'MC_TIMEOUT_DISABLED',
            message: 'Timeout system disabled'
        });
    }

    /**
     * Enable timeouts
     */
    enable() {
        this.enabled = true;
        logger.info({
            code: 'MC_TIMEOUT_ENABLED',
            message: 'Timeout system enabled'
        });
    }

    /**
     * Get current timeout statistics
     *
     * @returns {Object} - Timeout stats
     */
    getStats() {
        return {
            enabled: this.enabled,
            globalTimeout: this.globalTimeout,
            routeTimeouts: Array.from(this.routeTimeouts.entries()).map(([pattern, timeout]) => ({
                pattern,
                timeout
            })),
            activeRequests: this.activeRequests.size,
            requests: Array.from(this.activeRequests.entries()).map(([id, data]) => ({
                requestId: id,
                path: data.path,
                method: data.method,
                timeout: data.timeout,
                elapsed: Date.now() - data.startTime,
                remaining: data.timeout - (Date.now() - data.startTime)
            }))
        };
    }

    /**
     * Check if path matches pattern
     *
     * @private
     */
    _pathMatches(path, pattern) {
        if (typeof pattern === 'string') {
            // Normalize paths
            const normalizedPath = '/' + path.replace(/^\/|\/$/g, '');
            const normalizedPattern = '/' + pattern.replace(/^\/|\/$/g, '');

            // Wildcard support
            if (normalizedPattern.endsWith('/*')) {
                const prefix = normalizedPattern.slice(0, -2);
                return normalizedPath === prefix || normalizedPath.startsWith(prefix + '/');
            }

            // Exact match
            return normalizedPath === normalizedPattern;
        }

        if (pattern instanceof RegExp) {
            return pattern.test(path);
        }

        return false;
    }

    /**
     * Generate unique request ID
     *
     * @private
     */
    _generateRequestId() {
        return `req_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
    }
}

// Export for MasterControl to register (prevents circular dependency)
module.exports = { MasterTimeout };
