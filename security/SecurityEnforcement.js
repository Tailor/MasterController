// version 1.0 - Automatic Security Enforcement
// This middleware automatically enforces security best practices
var master = require('../MasterControl');
const { logger } = require('../error/MasterErrorLogger');
const { validateCSRFToken } = require('./SecurityMiddleware');
const { sanitizeObject } = require('./MasterValidator');
const { sanitizeUserHTML } = require('./MasterSanitizer');

class SecurityEnforcement {

	/**
	 * Initialize automatic security enforcement
	 * Call this in config/initializers/config.js:
	 * master.security.enforce({ csrf: true, sanitizeInputs: true, httpsOnly: true });
	 */
	static init(options = {}) {
		const config = {
			// Auto-enforce CSRF on POST/PUT/DELETE
			csrf: options.csrf !== false, // Default: true

			// Auto-sanitize all request inputs
			sanitizeInputs: options.sanitizeInputs !== false, // Default: true

			// Require HTTPS in production
			httpsOnly: options.httpsOnly !== false, // Default: true

			// Auto-escape template output (future enhancement)
			autoEscape: options.autoEscape !== false, // Default: true

			// Excluded paths (no CSRF check)
			csrfExcludePaths: options.csrfExcludePaths || ['/api/webhook'],

			// Allowed origins for CORS
			allowedOrigins: options.allowedOrigins || [],

			...options
		};

		logger.info({
			code: 'MC_SECURITY_ENFORCEMENT_INIT',
			message: 'Security enforcement initialized',
			config: {
				csrf: config.csrf,
				sanitizeInputs: config.sanitizeInputs,
				httpsOnly: config.httpsOnly
			}
		});

		return config;
	}

	/**
	 * Get enforcement middleware for pipeline
	 * Automatically validates CSRF, sanitizes inputs, enforces HTTPS
	 */
	static middleware(config = {}) {
		return async (ctx, next) => {
			// 1. HTTPS Enforcement (Production only)
			if (config.httpsOnly && master.environmentType === 'production') {
				if (!SecurityEnforcement._isSecure(ctx.request)) {
					logger.warn({
						code: 'MC_SECURITY_HTTPS_REQUIRED',
						message: 'HTTPS required in production',
						path: ctx.pathName,
						ip: ctx.request.connection.remoteAddress
					});

					const configuredHost = master.env?.server?.hostname;
					if (configuredHost && configuredHost !== 'localhost') {
						const httpsPort = master.env?.server?.httpsPort || 443;
						const port = httpsPort === 443 ? '' : `:${httpsPort}`;
						const httpsUrl = `https://${configuredHost}${port}${ctx.request.url}`;

						ctx.response.statusCode = 301;
						ctx.response.setHeader('Location', httpsUrl);
						ctx.response.end();
						return; // Don't call next()
					}
				}
			}

			// 2. CSRF Protection (POST, PUT, DELETE, PATCH)
			if (config.csrf && ['post', 'put', 'delete', 'patch'].includes(ctx.type)) {
				// Check if path is excluded
				const isExcluded = config.csrfExcludePaths.some(excludePath => {
					return ctx.pathName.startsWith(excludePath.replace(/^\//, ''));
				});

				if (!isExcluded) {
					const token = ctx.request.headers['x-csrf-token'] ||
					             ctx.params?.formData?._csrf ||
					             ctx.params?.query?._csrf;

					if (!token) {
						logger.warn({
							code: 'MC_SECURITY_CSRF_MISSING',
							message: 'CSRF token missing',
							path: ctx.pathName,
							method: ctx.type,
							ip: ctx.request.connection.remoteAddress
						});

						ctx.response.statusCode = 403;
						ctx.response.setHeader('Content-Type', 'application/json');
						ctx.response.end(JSON.stringify({
							error: 'CSRF token required',
							message: 'Include X-CSRF-Token header or _csrf field in request'
						}));
						return; // Don't call next()
					}

					const validation = validateCSRFToken(token);
					if (!validation.valid) {
						logger.warn({
							code: 'MC_SECURITY_CSRF_INVALID',
							message: 'CSRF token validation failed',
							path: ctx.pathName,
							reason: validation.reason,
							ip: ctx.request.connection.remoteAddress
						});

						ctx.response.statusCode = 403;
						ctx.response.setHeader('Content-Type', 'application/json');
						ctx.response.end(JSON.stringify({
							error: 'Invalid CSRF token',
							message: validation.reason
						}));
						return; // Don't call next()
					}
				}
			}

			// 3. Input Sanitization (All methods)
			if (config.sanitizeInputs && ctx.params) {
				try {
					// Sanitize all input objects
					if (ctx.params.formData) {
						ctx.params.formData = SecurityEnforcement._sanitizeInputs(ctx.params.formData);
					}
					if (ctx.params.query) {
						ctx.params.query = SecurityEnforcement._sanitizeInputs(ctx.params.query);
					}
					if (ctx.params.body) {
						ctx.params.body = SecurityEnforcement._sanitizeInputs(ctx.params.body);
					}

					logger.debug({
						code: 'MC_SECURITY_SANITIZED',
						message: 'Inputs sanitized',
						path: ctx.pathName
					});
				} catch (error) {
					logger.error({
						code: 'MC_SECURITY_SANITIZE_ERROR',
						message: 'Failed to sanitize inputs',
						error: error.message,
						path: ctx.pathName
					});
				}
			}

			// 4. Security Headers
			SecurityEnforcement._applySecurityHeaders(ctx.response);

			// Continue to next middleware
			await next();
		};
	}

	/**
	 * Check if request is secure (HTTPS)
	 */
	static _isSecure(req) {
		return req.connection.encrypted ||
		       req.headers['x-forwarded-proto'] === 'https';
	}

	/**
	 * Sanitize user inputs recursively
	 */
	static _sanitizeInputs(obj) {
		if (typeof obj !== 'object' || obj === null) {
			return obj;
		}

		// Handle arrays
		if (Array.isArray(obj)) {
			return obj.map(item => SecurityEnforcement._sanitizeInputs(item));
		}

		// Handle objects
		const sanitized = {};
		for (const [key, value] of Object.entries(obj)) {
			if (typeof value === 'string') {
				// Sanitize HTML in string values
				sanitized[key] = sanitizeUserHTML(value);
			} else if (typeof value === 'object' && value !== null) {
				// Recursively sanitize nested objects
				sanitized[key] = SecurityEnforcement._sanitizeInputs(value);
			} else {
				// Keep other types as-is
				sanitized[key] = value;
			}
		}

		return sanitized;
	}

	/**
	 * Apply security headers to response
	 */
	static _applySecurityHeaders(response) {
		if (response.headersSent || response._headerSent) {
			return;
		}

		// XSS Protection
		response.setHeader('X-XSS-Protection', '1; mode=block');

		// Clickjacking Protection
		response.setHeader('X-Frame-Options', 'SAMEORIGIN');

		// MIME Sniffing Protection
		response.setHeader('X-Content-Type-Options', 'nosniff');

		// Referrer Policy
		response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

		// Content Security Policy (basic)
		response.setHeader('Content-Security-Policy', "default-src 'self'");

		// Feature Policy / Permissions Policy
		response.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
	}
}

// Export for use in config
module.exports = SecurityEnforcement;

// Also extend master object
master.extend('securityEnforcement', SecurityEnforcement);
