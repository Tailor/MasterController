/**
 * MasterErrorRenderer - Professional error page rendering system
 *
 * Inspired by Rails ActionDispatch::ExceptionWrapper and Django error views
 *
 * Features:
 * - Environment-specific rendering (dev vs production)
 * - Dynamic error pages with template data
 * - Multiple error codes (401, 403, 404, 422, 429, 500, 503, etc.)
 * - Content negotiation (HTML vs JSON)
 * - Custom error handlers
 * - Template-based error pages
 *
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');
const { logger } = require('./MasterErrorLogger');

class MasterErrorRenderer {
    constructor() {
        this.errorTemplates = new Map();
        this.customHandlers = new Map();
        this.templateDir = null;
        this.environment = 'development';
    }

    // Lazy-load master to avoid circular dependency (Google-style lazy initialization)
    get _master() {
        if (!this.__masterCache) {
            this.__masterCache = require('../MasterControl');
        }
        return this.__masterCache;
    }

    /**
     * Initialize error renderer
     *
     * @param {Object} options - Configuration options
     * @param {String} options.templateDir - Directory for error templates (default: 'public/errors')
     * @param {String} options.environment - Environment (development, production, test)
     * @param {Boolean} options.showStackTrace - Show stack traces in dev (default: true in dev)
     */
    init(options = {}) {
        this.templateDir = options.templateDir || path.join(this._master.root, 'public/errors');
        this.environment = options.environment || this._master.environmentType || 'development';
        this.showStackTrace = options.showStackTrace !== undefined
            ? options.showStackTrace
            : (this.environment === 'development');

        // Create error templates directory if it doesn't exist
        if (!fs.existsSync(this.templateDir)) {
            fs.mkdirSync(this.templateDir, { recursive: true });
            logger.info({
                code: 'MC_ERROR_RENDERER_DIR_CREATED',
                message: 'Created error templates directory',
                dir: this.templateDir
            });
        }

        // Load error templates
        this._loadTemplates();

        logger.info({
            code: 'MC_ERROR_RENDERER_INIT',
            message: 'Error renderer initialized',
            templateDir: this.templateDir,
            environment: this.environment,
            showStackTrace: this.showStackTrace
        });

        return this;
    }

    /**
     * Render error page
     *
     * @param {Object} ctx - Request context
     * @param {Number} statusCode - HTTP status code
     * @param {Object} errorData - Error data
     * @returns {String} - Rendered HTML or JSON
     */
    render(ctx, statusCode, errorData = {}) {
        const isApiRequest = this._isApiRequest(ctx);

        if (isApiRequest) {
            return this._renderJSON(statusCode, errorData);
        } else {
            return this._renderHTML(ctx, statusCode, errorData);
        }
    }

    /**
     * Send error response
     *
     * @param {Object} ctx - Request context
     * @param {Number} statusCode - HTTP status code
     * @param {Object} errorData - Error data
     */
    send(ctx, statusCode, errorData = {}) {
        const content = this.render(ctx, statusCode, errorData);
        const isApiRequest = this._isApiRequest(ctx);

        if (!ctx.response.headersSent) {
            ctx.response.statusCode = statusCode;
            ctx.response.setHeader('Content-Type', isApiRequest ? 'application/json' : 'text/html');
            ctx.response.end(content);
        }

        // Log error
        logger.error({
            code: errorData.code || 'MC_HTTP_ERROR',
            message: errorData.message || this._getDefaultMessage(statusCode),
            statusCode,
            path: ctx.pathName || ctx.request.url,
            method: ctx.type || ctx.request.method.toLowerCase(),
            stack: errorData.stack
        });
    }

    /**
     * Register custom error handler for specific status code
     *
     * @param {Number} statusCode - HTTP status code
     * @param {Function} handler - Handler function (ctx, errorData) => String
     *
     * @example
     * this._master.errorRenderer.registerHandler(404, (ctx, errorData) => {
     *     return `<html><body>Custom 404: ${errorData.message}</body></html>`;
     * });
     */
    registerHandler(statusCode, handler) {
        if (typeof handler !== 'function') {
            throw new Error('Handler must be a function');
        }

        this.customHandlers.set(statusCode, handler);

        logger.info({
            code: 'MC_ERROR_HANDLER_REGISTERED',
            message: 'Custom error handler registered',
            statusCode
        });

        return this;
    }

    /**
     * Render HTML error page
     *
     * @private
     */
    _renderHTML(ctx, statusCode, errorData) {
        // Check for custom handler
        if (this.customHandlers.has(statusCode)) {
            try {
                return this.customHandlers.get(statusCode)(ctx, errorData);
            } catch (err) {
                logger.error({
                    code: 'MC_ERROR_HANDLER_FAILED',
                    message: 'Custom error handler failed',
                    statusCode,
                    error: err.message
                });
                // Fall through to default rendering
            }
        }

        // Check for template
        const template = this._getTemplate(statusCode);
        if (template) {
            return this._renderTemplate(template, statusCode, errorData);
        }

        // Fallback to default error page
        return this._renderDefaultHTML(statusCode, errorData);
    }

    /**
     * Render JSON error response
     *
     * @private
     */
    _renderJSON(statusCode, errorData) {
        const response = {
            error: this._getDefaultMessage(statusCode),
            statusCode: statusCode,
            code: errorData.code || 'MC_HTTP_ERROR'
        };

        if (errorData.message) {
            response.message = errorData.message;
        }

        if (this.showStackTrace && errorData.stack) {
            response.stack = errorData.stack;
        }

        if (errorData.details) {
            response.details = errorData.details;
        }

        if (errorData.suggestions) {
            response.suggestions = errorData.suggestions;
        }

        return JSON.stringify(response, null, 2);
    }

    /**
     * Render template with data
     *
     * @private
     */
    _renderTemplate(template, statusCode, errorData) {
        let html = template;

        const data = {
            statusCode: statusCode,
            title: this._getDefaultTitle(statusCode),
            message: errorData.message || this._getDefaultMessage(statusCode),
            description: errorData.description || '',
            code: errorData.code || 'MC_HTTP_ERROR',
            stack: this.showStackTrace && errorData.stack ? errorData.stack : null,
            suggestions: errorData.suggestions || [],
            path: errorData.path || '',
            environment: this.environment,
            showStackTrace: this.showStackTrace
        };

        // Simple template rendering (replace {{key}} with values)
        for (const [key, value] of Object.entries(data)) {
            const regex = new RegExp(`{{${key}}}`, 'g');
            html = html.replace(regex, value || '');
        }

        // Handle conditionals {{#if showStackTrace}}...{{/if}}
        html = this._processConditionals(html, data);

        // Handle loops {{#each suggestions}}...{{/each}}
        html = this._processLoops(html, data);

        return html;
    }

    /**
     * Process conditional blocks in template
     *
     * @private
     */
    _processConditionals(html, data) {
        const conditionalRegex = /{{#if\s+(\w+)}}([\s\S]*?){{\/if}}/g;

        return html.replace(conditionalRegex, (match, condition, content) => {
            return data[condition] ? content : '';
        });
    }

    /**
     * Process loop blocks in template
     *
     * @private
     */
    _processLoops(html, data) {
        const loopRegex = /{{#each\s+(\w+)}}([\s\S]*?){{\/each}}/g;

        return html.replace(loopRegex, (match, arrayName, content) => {
            const array = data[arrayName];
            if (!Array.isArray(array)) {
                return '';
            }

            return array.map(item => {
                let itemHtml = content;
                if (typeof item === 'string') {
                    itemHtml = itemHtml.replace(/{{this}}/g, item);
                } else if (typeof item === 'object') {
                    for (const [key, value] of Object.entries(item)) {
                        itemHtml = itemHtml.replace(new RegExp(`{{${key}}}`, 'g'), value);
                    }
                }
                return itemHtml;
            }).join('');
        });
    }

    /**
     * Render default HTML error page
     *
     * @private
     */
    _renderDefaultHTML(statusCode, errorData) {
        const title = this._getDefaultTitle(statusCode);
        const message = errorData.message || this._getDefaultMessage(statusCode);
        const stack = this.showStackTrace && errorData.stack
            ? `<pre style="background: #f5f5f5; padding: 1em; overflow: auto;">${this._escapeHtml(errorData.stack)}</pre>`
            : '';

        const suggestions = errorData.suggestions && errorData.suggestions.length > 0
            ? `<div style="margin-top: 2em;">
                <h3>Suggestions:</h3>
                <ul>
                    ${errorData.suggestions.map(s => `<li>${this._escapeHtml(s)}</li>`).join('')}
                </ul>
               </div>`
            : '';

        return `<!DOCTYPE html>
<html>
<head>
    <title>${title}</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
        body {
            background-color: #f8f9fa;
            color: #212529;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            margin: 0;
            padding: 2em;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
        }
        .error-box {
            background: white;
            border-left: 4px solid #dc3545;
            border-radius: 4px;
            padding: 2em;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        h1 {
            margin: 0 0 0.5em 0;
            color: #dc3545;
            font-size: 2em;
        }
        .status-code {
            font-size: 4em;
            font-weight: bold;
            color: #dc3545;
            margin: 0;
        }
        .message {
            font-size: 1.2em;
            margin: 1em 0;
        }
        .code {
            background: #f8f9fa;
            padding: 0.5em 1em;
            border-radius: 4px;
            font-family: monospace;
            font-size: 0.9em;
            margin: 1em 0;
        }
        pre {
            background: #f5f5f5;
            padding: 1em;
            overflow: auto;
            border-radius: 4px;
        }
        .footer {
            margin-top: 2em;
            text-align: center;
            color: #6c757d;
            font-size: 0.9em;
        }
        ul {
            line-height: 1.6;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="error-box">
            <p class="status-code">${statusCode}</p>
            <h1>${title}</h1>
            <p class="message">${this._escapeHtml(message)}</p>
            ${errorData.code ? `<div class="code">Error Code: ${errorData.code}</div>` : ''}
            ${suggestions}
            ${stack}
        </div>
        <div class="footer">
            <p>MasterController Framework • ${this.environment} environment</p>
        </div>
    </div>
</body>
</html>`;
    }

    /**
     * Load error templates from disk
     *
     * @private
     */
    _loadTemplates() {
        const statusCodes = [400, 401, 403, 404, 405, 422, 429, 500, 502, 503, 504];

        for (const code of statusCodes) {
            const templatePath = path.join(this.templateDir, `${code}.html`);

            if (fs.existsSync(templatePath)) {
                try {
                    const template = fs.readFileSync(templatePath, 'utf8');
                    this.errorTemplates.set(code, template);
                    logger.info({
                        code: 'MC_ERROR_TEMPLATE_LOADED',
                        message: 'Error template loaded',
                        statusCode: code,
                        path: templatePath
                    });
                } catch (err) {
                    logger.error({
                        code: 'MC_ERROR_TEMPLATE_LOAD_FAILED',
                        message: 'Failed to load error template',
                        statusCode: code,
                        error: err.message
                    });
                }
            }
        }
    }

    /**
     * Get template for status code
     *
     * @private
     */
    _getTemplate(statusCode) {
        // Check exact match
        if (this.errorTemplates.has(statusCode)) {
            return this.errorTemplates.get(statusCode);
        }

        // Check category (4xx -> 400, 5xx -> 500)
        const category = Math.floor(statusCode / 100) * 100;
        if (this.errorTemplates.has(category)) {
            return this.errorTemplates.get(category);
        }

        return null;
    }

    /**
     * Check if request is API request
     *
     * @private
     */
    _isApiRequest(ctx) {
        // Check Accept header
        const accept = ctx.request.headers['accept'] || '';
        if (accept.includes('application/json')) {
            return true;
        }

        // Check path
        const path = ctx.pathName || ctx.request.url;
        if (path.startsWith('api/') || path.startsWith('/api/')) {
            return true;
        }

        // Check Content-Type
        const contentType = ctx.request.headers['content-type'] || '';
        if (contentType.includes('application/json')) {
            return true;
        }

        return false;
    }

    /**
     * Get default title for status code
     *
     * @private
     */
    _getDefaultTitle(statusCode) {
        const titles = {
            400: 'Bad Request',
            401: 'Unauthorized',
            403: 'Forbidden',
            404: 'Page Not Found',
            405: 'Method Not Allowed',
            422: 'Unprocessable Entity',
            429: 'Too Many Requests',
            500: 'Internal Server Error',
            502: 'Bad Gateway',
            503: 'Service Unavailable',
            504: 'Gateway Timeout'
        };

        return titles[statusCode] || `Error ${statusCode}`;
    }

    /**
     * Get default message for status code
     *
     * @private
     */
    _getDefaultMessage(statusCode) {
        const messages = {
            400: 'The request could not be understood by the server due to malformed syntax.',
            401: 'You need to be authenticated to access this resource.',
            403: 'You don\'t have permission to access this resource.',
            404: 'The page you were looking for doesn\'t exist.',
            405: 'The method specified in the request is not allowed for this resource.',
            422: 'The request was well-formed but contains invalid data.',
            429: 'Too many requests. Please slow down and try again later.',
            500: 'We\'re sorry, but something went wrong on our end.',
            502: 'The server received an invalid response from the upstream server.',
            503: 'The service is temporarily unavailable. Please try again later.',
            504: 'The server did not receive a timely response from the upstream server.'
        };

        return messages[statusCode] || 'An error occurred while processing your request.';
    }

    /**
     * Escape HTML entities
     *
     * @private
     */
    _escapeHtml(text) {
        if (!text) return '';
        return text
            .toString()
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}

module.exports = { MasterErrorRenderer };

module.exports = MasterErrorRenderer;
