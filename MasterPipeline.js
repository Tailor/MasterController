// MasterPipeline - Middleware Pipeline System
// version 1.0

const { logger } = require('./error/MasterErrorLogger');

class MasterPipeline {
    constructor() {
        this.middleware = [];
        this.errorHandlers = [];
    }

    /**
     * Use: Add middleware that processes request/response
     *
     * Middleware signature: async (ctx, next) => { await next(); }
     * - ctx: Request context { request, response, params, state, ... }
     * - next: Function to call next middleware in chain
     *
     * Example:
     *   master.use(async (ctx, next) => {
     *       console.log('Before');
     *       await next();
     *       console.log('After');
     *   });
     *
     * @param {Function} middleware - Middleware function
     * @returns {MasterPipeline} - For chaining
     */
    use(middleware) {
        if (typeof middleware !== 'function') {
            throw new Error('Middleware must be a function');
        }

        this.middleware.push({
            type: 'use',
            handler: middleware,
            path: null
        });

        return this; // Chainable
    }

    /**
     * Run: Add terminal middleware that ends the pipeline
     *
     * Terminal middleware signature: async (ctx) => { ... send response ... }
     * - Does NOT call next()
     * - Must send response
     *
     * Example:
     *   master.run(async (ctx) => {
     *       ctx.response.end('Hello World');
     *   });
     *
     * @param {Function} middleware - Terminal middleware function
     * @returns {MasterPipeline} - For chaining
     */
    run(middleware) {
        if (typeof middleware !== 'function') {
            throw new Error('Terminal middleware must be a function');
        }

        this.middleware.push({
            type: 'run',
            handler: middleware,
            path: null
        });

        return this; // Chainable
    }

    /**
     * Map: Conditionally execute middleware based on path
     *
     * Map signature: (path, configure)
     * - path: String or RegExp to match request path
     * - configure: Function that receives a branch pipeline
     *
     * Example:
     *   master.map('/api/*', (api) => {
     *       api.use(authMiddleware);
     *       api.use(jsonMiddleware);
     *   });
     *
     * @param {String|RegExp} path - Path pattern to match
     * @param {Function} configure - Function to configure branch pipeline
     * @returns {MasterPipeline} - For chaining
     */
    map(path, configure) {
        if (typeof configure !== 'function') {
            throw new Error('Map configuration must be a function');
        }

        // Create sub-pipeline for this branch
        const branch = new MasterPipeline();
        configure(branch);

        // Wrap branch in conditional middleware
        const conditionalMiddleware = async (ctx, next) => {
            const requestPath = ctx.pathName || ctx.request.url;

            if (this._pathMatches(requestPath, path)) {
                // Execute branch pipeline
                await branch.execute(ctx);
                // After branch completes, continue main pipeline
                await next();
            } else {
                // Skip branch, continue main pipeline
                await next();
            }
        };

        this.middleware.push({
            type: 'map',
            handler: conditionalMiddleware,
            path: path
        });

        return this; // Chainable
    }

    /**
     * UseError: Add error handling middleware
     *
     * Error middleware signature: async (error, ctx, next) => { }
     * - error: The caught error
     * - ctx: Request context
     * - next: Pass to next error handler or rethrow
     *
     * Example:
     *   master.useError(async (err, ctx, next) => {
     *       if (err.statusCode === 404) {
     *           ctx.response.statusCode = 404;
     *           ctx.response.end('Not Found');
     *       } else {
     *           await next(); // Pass to next error handler
     *       }
     *   });
     *
     * @param {Function} handler - Error handler function
     * @returns {MasterPipeline} - For chaining
     */
    useError(handler) {
        if (typeof handler !== 'function') {
            throw new Error('Error handler must be a function');
        }

        this.errorHandlers.push(handler);
        return this; // Chainable
    }

    /**
     * Execute: Run the middleware pipeline for a request
     *
     * Called internally by the framework for each request
     *
     * @param {Object} context - Request context
     */
    async execute(context) {
        let index = 0;

        // Create the next function for middleware chain
        const next = async () => {
            // If we've run all middleware, we're done
            if (index >= this.middleware.length) {
                return;
            }

            const current = this.middleware[index++];

            try {
                if (current.type === 'run') {
                    // Terminal middleware - don't pass next
                    await current.handler(context);
                } else {
                    // Regular middleware - pass next
                    await current.handler(context, next);
                }
            } catch (error) {
                // Error occurred, run error handlers
                await this._handleError(error, context);
            }
        };

        // Start the pipeline
        await next();
    }

    /**
     * Handle errors through error handler chain
     *
     * @param {Error} error - The error that occurred
     * @param {Object} context - Request context
     */
    async _handleError(error, context) {
        let errorIndex = 0;

        const nextError = async () => {
            if (errorIndex >= this.errorHandlers.length) {
                // No more error handlers, log and send generic error
                logger.error({
                    code: 'MC_ERR_UNHANDLED',
                    message: 'Unhandled error in middleware pipeline',
                    error: error.message,
                    stack: error.stack
                });

                if (!context.response.headersSent) {
                    context.response.statusCode = 500;
                    context.response.end('Internal Server Error');
                }
                return;
            }

            const handler = this.errorHandlers[errorIndex++];

            try {
                await handler(error, context, nextError);
            } catch (handlerError) {
                // Error in error handler
                logger.error({
                    code: 'MC_ERR_ERROR_HANDLER_FAILED',
                    message: 'Error handler threw an error',
                    error: handlerError.message
                });
                await nextError();
            }
        };

        await nextError();
    }

    /**
     * Check if request path matches the map path pattern
     *
     * @param {String} requestPath - The request path
     * @param {String|RegExp} pattern - The pattern to match
     * @returns {Boolean} - True if matches
     */
    _pathMatches(requestPath, pattern) {
        // Normalize paths (ensure leading slash)
        requestPath = '/' + requestPath.replace(/^\/|\/$/g, '');

        if (typeof pattern === 'string') {
            pattern = '/' + pattern.replace(/^\/|\/$/g, '');

            // Wildcard support: /api/* matches /api/users, /api/posts, etc.
            if (pattern.endsWith('/*')) {
                const prefix = pattern.slice(0, -2);
                return requestPath === prefix || requestPath.startsWith(prefix + '/');
            }

            // Exact or prefix match
            return requestPath === pattern || requestPath.startsWith(pattern + '/');
        }

        if (pattern instanceof RegExp) {
            return pattern.test(requestPath);
        }

        return false;
    }

    /**
     * Discover and load middleware from folders
     *
     * @param {String|Object} options - Folder path or options object
     */
    discoverMiddleware(options) {
        const fs = require('fs');
        const path = require('path');

        const folders = typeof options === 'string'
            ? [options]
            : (options.folders || ['middleware']);

        folders.forEach(folder => {
            const dir = path.join(master.root, folder);
            if (!fs.existsSync(dir)) {
                console.warn(`[Middleware] Folder not found: ${folder}`);
                return;
            }

            const files = fs.readdirSync(dir)
                .filter(file => file.endsWith('.js'))
                .sort(); // Alphabetical order

            files.forEach(file => {
                try {
                    const middlewarePath = path.join(dir, file);
                    const middleware = require(middlewarePath);

                    // Support two patterns:
                    // Pattern 1: module.exports = async (ctx, next) => {}
                    if (typeof middleware === 'function') {
                        this.use(middleware);
                    }
                    // Pattern 2: module.exports = { register: (master) => {} }
                    else if (middleware.register && typeof middleware.register === 'function') {
                        middleware.register(master);
                    }
                    else {
                        console.warn(`[Middleware] Invalid export in ${folder}/${file}`);
                        return;
                    }

                    console.log(`[Middleware] Loaded: ${folder}/${file}`);
                } catch (err) {
                    console.error(`[Middleware] Failed to load ${folder}/${file}:`, err.message);
                }
            });
        });
    }

    /**
     * Clear all middleware (useful for testing)
     */
    clear() {
        this.middleware = [];
        this.errorHandlers = [];
    }

    /**
     * Inspect pipeline (for debugging)
     *
     * @returns {Object} - Pipeline information
     */
    inspect() {
        return {
            middlewareCount: this.middleware.length,
            errorHandlerCount: this.errorHandlers.length,
            middleware: this.middleware.map((m, i) => ({
                index: i,
                type: m.type,
                path: m.path,
                name: m.handler.name || 'anonymous'
            }))
        };
    }
}

// Export for MasterControl to register (prevents circular dependency)
module.exports = { MasterPipeline };
