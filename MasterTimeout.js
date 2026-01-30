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
 * @version 1.1.0 - FAANG-level refactor with production hardening
 */

const { logger } = require('./error/MasterErrorLogger');

// Configuration Constants
const TIMEOUT_CONFIG = {
    DEFAULT_TIMEOUT: 120000,        // 120 seconds
    MIN_TIMEOUT: 1000,              // 1 second minimum
    MAX_TIMEOUT: 3600000,           // 1 hour maximum
    MAX_ACTIVE_REQUESTS: 10000,     // Prevent memory exhaustion
    HANDLER_TIMEOUT: 5000,          // 5 seconds for custom handlers
    CLEANUP_INTERVAL: 60000,        // Clean up stale requests every minute
    REQUEST_ID_LENGTH: 15           // Length of generated request IDs
};

const HTTP_STATUS = {
    GATEWAY_TIMEOUT: 504,
    INTERNAL_ERROR: 500
};

class MasterTimeout {
    constructor() {
        this.globalTimeout = TIMEOUT_CONFIG.DEFAULT_TIMEOUT;
        this.routeTimeouts = new Map();
        this.activeRequests = new Map();
        this.timeoutHandlers = [];
        this.enabled = true;

        // Metrics tracking
        this.metrics = {
            totalRequests: 0,
            totalTimeouts: 0,
            peakConcurrent: 0,
            totalDuration: 0
        };

        // Start periodic cleanup
        this.cleanupTimer = setInterval(() => {
            this._cleanupStaleRequests();
        }, TIMEOUT_CONFIG.CLEANUP_INTERVAL);

        // Prevent cleanup timer from keeping process alive
        if (this.cleanupTimer.unref) {
            this.cleanupTimer.unref();
        }
    }

    // Lazy-load master to avoid circular dependency (Google-style lazy initialization)
    get _master() {
        if (!this.__masterCache) {
            this.__masterCache = require('./MasterControl');
        }
        return this.__masterCache;
    }

    /**
     * Initialize timeout system
     *
     * @param {Object} options - Configuration options
     * @param {Number} options.globalTimeout - Default timeout in ms (default: 120000)
     * @param {Boolean} options.enabled - Enable/disable timeouts (default: true)
     * @param {Function} options.onTimeout - Custom timeout handler
     * @throws {TypeError} If options is not an object
     * @throws {Error} If globalTimeout is out of valid range
     * @throws {TypeError} If enabled is not a boolean
     * @throws {TypeError} If onTimeout is not a function
     */
    init(options = {}) {
        // Input validation
        if (typeof options !== 'object' || options === null) {
            throw new TypeError('Options must be an object');
        }

        if (options.globalTimeout !== undefined) {
            if (typeof options.globalTimeout !== 'number' || isNaN(options.globalTimeout)) {
                throw new TypeError('globalTimeout must be a number');
            }

            if (options.globalTimeout < TIMEOUT_CONFIG.MIN_TIMEOUT ||
                options.globalTimeout > TIMEOUT_CONFIG.MAX_TIMEOUT) {
                throw new Error(
                    `globalTimeout must be between ${TIMEOUT_CONFIG.MIN_TIMEOUT}ms and ${TIMEOUT_CONFIG.MAX_TIMEOUT}ms`
                );
            }

            this.globalTimeout = options.globalTimeout;
        }

        if (options.enabled !== undefined) {
            if (typeof options.enabled !== 'boolean') {
                throw new TypeError('enabled must be a boolean');
            }
            this.enabled = options.enabled;
        }

        if (options.onTimeout !== undefined) {
            if (typeof options.onTimeout !== 'function') {
                throw new TypeError('onTimeout must be a function');
            }
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
     * @param {String|RegExp} routePattern - Route pattern (e.g., '/api/*', '/admin/reports')
     * @param {Number} timeout - Timeout in milliseconds
     * @throws {TypeError} If routePattern is not string or RegExp
     * @throws {Error} If routePattern is empty
     * @throws {TypeError} If timeout is not a number
     * @throws {Error} If timeout is out of valid range
     *
     * @example
     * this._master.timeout.setRouteTimeout('/api/*', 30000); // 30 seconds for APIs
     * this._master.timeout.setRouteTimeout('/admin/reports', 300000); // 5 minutes for reports
     */
    setRouteTimeout(routePattern, timeout) {
        // Validate routePattern
        if (typeof routePattern !== 'string' && !(routePattern instanceof RegExp)) {
            throw new TypeError('Route pattern must be a string or RegExp');
        }

        if (typeof routePattern === 'string' && (!routePattern || routePattern.trim() === '')) {
            throw new Error('Route pattern cannot be empty');
        }

        // Validate timeout
        if (typeof timeout !== 'number' || isNaN(timeout)) {
            throw new TypeError('Timeout must be a number');
        }

        if (timeout < TIMEOUT_CONFIG.MIN_TIMEOUT || timeout > TIMEOUT_CONFIG.MAX_TIMEOUT) {
            throw new Error(
                `Timeout must be between ${TIMEOUT_CONFIG.MIN_TIMEOUT}ms and ${TIMEOUT_CONFIG.MAX_TIMEOUT}ms`
            );
        }

        this.routeTimeouts.set(routePattern, timeout);

        logger.info({
            code: 'MC_TIMEOUT_ROUTE_SET',
            message: 'Route timeout configured',
            routePattern: routePattern.toString(),
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
        // Validate input
        if (typeof path !== 'string') {
            logger.warn({
                code: 'MC_TIMEOUT_INVALID_PATH',
                message: 'Invalid path provided to getTimeoutForPath',
                path
            });
            return this.globalTimeout;
        }

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
     * @returns {String|null} - Request ID or null if disabled/error
     * @throws {TypeError} If ctx is not an object
     * @throws {Error} If ctx.response is missing
     * @throws {Error} If max active requests exceeded
     */
    startTracking(ctx) {
        if (!this.enabled) {
            return null;
        }

        // Input validation
        if (!ctx || typeof ctx !== 'object') {
            throw new TypeError('Context must be an object');
        }

        if (!ctx.response || typeof ctx.response !== 'object') {
            throw new Error('Context must have a response object');
        }

        // Check max active requests (DoS protection)
        if (this.activeRequests.size >= TIMEOUT_CONFIG.MAX_ACTIVE_REQUESTS) {
            logger.error({
                code: 'MC_TIMEOUT_MAX_REQUESTS',
                message: 'Maximum active requests exceeded',
                current: this.activeRequests.size,
                max: TIMEOUT_CONFIG.MAX_ACTIVE_REQUESTS
            });
            throw new Error(`Maximum active requests (${TIMEOUT_CONFIG.MAX_ACTIVE_REQUESTS}) exceeded`);
        }

        const requestId = this._generateRequestId();
        const path = ctx.pathName || (ctx.request && ctx.request.url) || '/';
        const timeout = this.getTimeoutForPath(path);
        const startTime = Date.now();

        const timer = setTimeout(() => {
            this._handleTimeout(requestId, ctx, startTime);
        }, timeout);

        this.activeRequests.set(requestId, {
            timer,
            timeout,
            startTime,
            path,
            method: ctx.type || (ctx.request && ctx.request.method.toLowerCase()) || 'unknown'
        });

        // Update metrics
        this.metrics.totalRequests++;
        if (this.activeRequests.size > this.metrics.peakConcurrent) {
            this.metrics.peakConcurrent = this.activeRequests.size;
        }

        // Attach cleanup to response finish (with error handling)
        try {
            ctx.response.once('finish', () => {
                this.stopTracking(requestId);
            });

            ctx.response.once('close', () => {
                this.stopTracking(requestId);
            });
        } catch (err) {
            logger.warn({
                code: 'MC_TIMEOUT_LISTENER_ATTACH_FAILED',
                message: 'Failed to attach response listeners',
                requestId,
                error: err.message
            });
        }

        return requestId;
    }

    /**
     * Stop timeout tracking for request
     *
     * @param {String} requestId - Request ID
     * @returns {Boolean} - True if request was found and stopped
     * @throws {TypeError} If requestId is not a string
     */
    stopTracking(requestId) {
        // Input validation
        if (typeof requestId !== 'string' || !requestId) {
            throw new TypeError('Request ID must be a non-empty string');
        }

        // Race condition protection: check if request still exists
        const tracked = this.activeRequests.get(requestId);

        if (tracked) {
            clearTimeout(tracked.timer);

            // Update metrics
            const duration = Date.now() - tracked.startTime;
            this.metrics.totalDuration += duration;

            this.activeRequests.delete(requestId);
            return true;
        }

        return false;
    }

    /**
     * Handle request timeout
     *
     * @private
     * @param {String} requestId - Request ID
     * @param {Object} ctx - Request context
     * @param {Number} startTime - Request start timestamp
     */
    _handleTimeout(requestId, ctx, startTime) {
        // Race condition protection: check if request still exists
        const tracked = this.activeRequests.get(requestId);

        if (!tracked) {
            return; // Already cleaned up
        }

        const duration = Date.now() - startTime;

        // Update metrics
        this.metrics.totalTimeouts++;

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

        // Call custom handlers with their own timeout protection
        for (const handler of this.timeoutHandlers) {
            this._executeHandlerWithTimeout(handler, ctx, {
                requestId,
                path: tracked.path,
                method: tracked.method,
                timeout: tracked.timeout,
                duration
            });
        }

        // Send timeout response if not already sent
        try {
            if (ctx.response && !ctx.response.headersSent) {
                ctx.response.statusCode = HTTP_STATUS.GATEWAY_TIMEOUT;
                ctx.response.setHeader('Content-Type', 'application/json');
                ctx.response.end(JSON.stringify({
                    error: 'Request Timeout',
                    message: 'The server did not receive a complete request within the allowed time',
                    code: 'MC_REQUEST_TIMEOUT',
                    timeout: tracked.timeout,
                    path: tracked.path
                }));
            }
        } catch (err) {
            logger.error({
                code: 'MC_TIMEOUT_RESPONSE_FAILED',
                message: 'Failed to send timeout response',
                requestId,
                error: err.message
            });
        }

        // Cleanup
        try {
            this.stopTracking(requestId);
        } catch (err) {
            // If stopTracking throws (invalid requestId), just delete directly
            this.activeRequests.delete(requestId);
        }
    }

    /**
     * Execute custom handler with timeout protection
     *
     * @private
     * @param {Function} handler - Custom timeout handler
     * @param {Object} ctx - Request context
     * @param {Object} info - Timeout information
     */
    _executeHandlerWithTimeout(handler, ctx, info) {
        let handlerCompleted = false;

        const handlerTimer = setTimeout(() => {
            if (!handlerCompleted) {
                logger.error({
                    code: 'MC_TIMEOUT_HANDLER_TIMEOUT',
                    message: 'Timeout handler exceeded maximum execution time',
                    maxTime: TIMEOUT_CONFIG.HANDLER_TIMEOUT
                });
            }
        }, TIMEOUT_CONFIG.HANDLER_TIMEOUT);

        try {
            const result = handler(ctx, info);

            // If handler returns a promise, handle it
            if (result && typeof result.then === 'function') {
                result
                    .then(() => {
                        handlerCompleted = true;
                        clearTimeout(handlerTimer);
                    })
                    .catch(err => {
                        handlerCompleted = true;
                        clearTimeout(handlerTimer);
                        logger.error({
                            code: 'MC_TIMEOUT_HANDLER_ERROR',
                            message: 'Timeout handler promise rejected',
                            error: err.message
                        });
                    });
            } else {
                handlerCompleted = true;
                clearTimeout(handlerTimer);
            }
        } catch (err) {
            handlerCompleted = true;
            clearTimeout(handlerTimer);
            logger.error({
                code: 'MC_TIMEOUT_HANDLER_ERROR',
                message: 'Timeout handler threw error',
                error: err.message
            });
        }
    }

    /**
     * Clean up stale requests that somehow weren't cleaned up properly
     *
     * @private
     */
    _cleanupStaleRequests() {
        const now = Date.now();
        let cleanedCount = 0;

        for (const [requestId, tracked] of this.activeRequests.entries()) {
            const elapsed = now - tracked.startTime;

            // If request has been active for more than 2x its timeout, force cleanup
            if (elapsed > tracked.timeout * 2) {
                logger.warn({
                    code: 'MC_TIMEOUT_STALE_REQUEST',
                    message: 'Cleaning up stale request',
                    requestId,
                    elapsed,
                    timeout: tracked.timeout
                });

                clearTimeout(tracked.timer);
                this.activeRequests.delete(requestId);
                cleanedCount++;
            }
        }

        if (cleanedCount > 0) {
            logger.info({
                code: 'MC_TIMEOUT_CLEANUP',
                message: 'Stale requests cleaned up',
                count: cleanedCount
            });
        }
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

            let requestId = null;

            try {
                requestId = $that.startTracking(ctx);
                ctx.requestId = requestId;

                await next();
            } catch (err) {
                // Stop tracking on error (with error handling)
                if (requestId) {
                    try {
                        $that.stopTracking(requestId);
                    } catch (stopErr) {
                        logger.warn({
                            code: 'MC_TIMEOUT_STOP_FAILED',
                            message: 'Failed to stop tracking on error',
                            requestId,
                            error: stopErr.message
                        });
                    }
                }
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
     * Shutdown timeout system and clean up all resources
     *
     * @returns {Object} - Cleanup statistics
     */
    shutdown() {
        logger.info({
            code: 'MC_TIMEOUT_SHUTDOWN',
            message: 'Shutting down timeout system',
            activeRequests: this.activeRequests.size
        });

        // Clear cleanup timer
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }

        // Clear all active request timers
        let clearedCount = 0;
        for (const [requestId, tracked] of this.activeRequests.entries()) {
            clearTimeout(tracked.timer);
            clearedCount++;
        }

        // Clear all tracked requests
        this.activeRequests.clear();

        // Clear handlers
        const handlerCount = this.timeoutHandlers.length;
        this.timeoutHandlers = [];

        const stats = {
            clearedRequests: clearedCount,
            clearedHandlers: handlerCount,
            finalMetrics: { ...this.metrics }
        };

        logger.info({
            code: 'MC_TIMEOUT_SHUTDOWN_COMPLETE',
            message: 'Timeout system shutdown complete',
            ...stats
        });

        return stats;
    }

    /**
     * Get current timeout statistics and metrics
     *
     * @returns {Object} - Comprehensive timeout stats
     */
    getStats() {
        const now = Date.now();
        const activeRequests = Array.from(this.activeRequests.entries()).map(([id, data]) => ({
            requestId: id,
            path: data.path,
            method: data.method,
            timeout: data.timeout,
            elapsed: now - data.startTime,
            remaining: Math.max(0, data.timeout - (now - data.startTime))
        }));

        return {
            enabled: this.enabled,
            globalTimeout: this.globalTimeout,
            routeTimeouts: Array.from(this.routeTimeouts.entries()).map(([pattern, timeout]) => ({
                pattern: pattern.toString(),
                timeout
            })),
            activeRequests: this.activeRequests.size,
            maxActiveRequests: TIMEOUT_CONFIG.MAX_ACTIVE_REQUESTS,
            requests: activeRequests,

            // Metrics
            metrics: {
                totalRequests: this.metrics.totalRequests,
                totalTimeouts: this.metrics.totalTimeouts,
                timeoutRate: this.metrics.totalRequests > 0
                    ? (this.metrics.totalTimeouts / this.metrics.totalRequests * 100).toFixed(2) + '%'
                    : '0%',
                peakConcurrent: this.metrics.peakConcurrent,
                averageResponseTime: this.metrics.totalRequests > 0
                    ? Math.round(this.metrics.totalDuration / this.metrics.totalRequests)
                    : 0
            },

            // Configuration
            config: {
                minTimeout: TIMEOUT_CONFIG.MIN_TIMEOUT,
                maxTimeout: TIMEOUT_CONFIG.MAX_TIMEOUT,
                handlerTimeout: TIMEOUT_CONFIG.HANDLER_TIMEOUT,
                cleanupInterval: TIMEOUT_CONFIG.CLEANUP_INTERVAL
            }
        };
    }

    /**
     * Check if path matches pattern with enhanced wildcard support
     *
     * @private
     * @param {String} path - Request path
     * @param {String|RegExp} pattern - Pattern to match
     * @returns {Boolean} - True if path matches pattern
     */
    _pathMatches(path, pattern) {
        if (typeof pattern === 'string') {
            // Normalize paths (remove leading/trailing slashes)
            const normalizedPath = '/' + path.replace(/^\/|\/$/g, '');
            const normalizedPattern = '/' + pattern.replace(/^\/|\/$/g, '');

            // Exact match
            if (normalizedPath === normalizedPattern) {
                return true;
            }

            // Wildcard support: /api/* matches /api/users, /api/posts, etc.
            if (normalizedPattern.endsWith('/*')) {
                const prefix = normalizedPattern.slice(0, -2);
                return normalizedPath === prefix || normalizedPath.startsWith(prefix + '/');
            }

            // Multiple wildcards: /api/*/posts matches /api/v1/posts, /api/v2/posts
            if (normalizedPattern.includes('*')) {
                const regexPattern = normalizedPattern
                    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')  // Escape special chars
                    .replace(/\*/g, '[^/]+');                // * matches any segment
                const regex = new RegExp('^' + regexPattern + '$');
                return regex.test(normalizedPath);
            }

            // Prefix match (for backwards compatibility)
            return normalizedPath.startsWith(normalizedPattern + '/');
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
     * @returns {String} - Unique request ID
     */
    _generateRequestId() {
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, TIMEOUT_CONFIG.REQUEST_ID_LENGTH);
        return `req_${timestamp}_${random}`;
    }
}

// Export for MasterControl to register (prevents circular dependency)
module.exports = { MasterTimeout };
