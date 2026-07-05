// version 1.0 - Automatic Security Enforcement
// This middleware automatically enforces security best practices
import { logger } from '../error/MasterErrorLogger.js';
import { validateCSRFToken } from './SecurityMiddleware.js';
import { sanitizeObject } from './MasterValidator.js';
import { sanitizeUserHTML } from './MasterSanitizer.js';

class SecurityEnforcement {

	// Master reference is set by MasterControl.setupServer() via bindMaster().
	// This is a static class accessed via MasterAction-like pattern, so we use
	// a static cache rather than constructor injection.
	static __masterCache = null;

	static bindMaster(master) {
		SecurityEnforcement.__masterCache = master;
	}

	static get _master() {
		if (!SecurityEnforcement.__masterCache) {
			throw new Error(
				'SecurityEnforcement._master accessed before MasterControl initialization. ' +
				'Ensure master.start() / setupServer() runs before security checks.'
			);
		}
		return SecurityEnforcement.__masterCache;
	}

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
			// v2.1.0: httpsOnly ALWAYS blocks the request when it isn't secure —
			// prior versions silently fell through when env.server.hostname was
			// unset or 'localhost', which meant a deployment that forgot to set
			// the hostname served credentials over HTTP while believing it was
			// enforcing HTTPS. Now, if we can redirect we do (308, method-
			// preserving); otherwise we return 426 Upgrade Required.
			if (config.httpsOnly && SecurityEnforcement._master.environmentType === 'production') {
				if (!SecurityEnforcement._isSecure(ctx.request)) {
					const clientIp = (SecurityEnforcement._master.getClientIp?.(ctx.request))
						|| ctx.request.connection?.remoteAddress;
					logger.warn({
						code: 'MC_SECURITY_HTTPS_REQUIRED',
						message: 'HTTPS required in production',
						context: { path: ctx.pathName, ip: clientIp }
					});

					const configuredHost = SecurityEnforcement._master.env?.server?.hostname;
					if (configuredHost && configuredHost !== 'localhost') {
						const httpsPort = SecurityEnforcement._master.env?.server?.httpsPort || 443;
						const port = httpsPort === 443 ? '' : `:${httpsPort}`;
						const httpsUrl = `https://${configuredHost}${port}${ctx.request.url}`;

						ctx.response.statusCode = 308;
						ctx.response.setHeader('Location', httpsUrl);
						ctx.response.end();
						return;
					}
					// No configured host to redirect to — refuse the request.
					ctx.response.statusCode = 426;
					ctx.response.setHeader('Content-Type', 'application/json');
					ctx.response.setHeader('Upgrade', 'TLS/1.2, HTTP/1.1');
					ctx.response.setHeader('Connection', 'Upgrade');
					ctx.response.end(JSON.stringify({
						error: 'Upgrade Required',
						message: 'HTTPS is required for this endpoint'
					}));
					return;
				}
			}

			// 2. CSRF Protection (POST, PUT, DELETE, PATCH)
			if (config.csrf && ['post', 'put', 'delete', 'patch'].includes(ctx.type)) {
				// SECURITY (v3.0): match exclude paths at SEGMENT boundary.
				// The previous startsWith without boundary meant `/api/webhook`
				// also exempted `/api/webhookmanage`, `/api/webhook-admin`, etc.
				const isExcluded = config.csrfExcludePaths.some(excludePath => {
					const norm = String(excludePath).replace(/^\/+/, '').replace(/\/+$/, '');
					return ctx.pathName === norm || ctx.pathName.startsWith(norm + '/');
				});

				if (!isExcluded) {
					const token = ctx.request.headers['x-csrf-token'] ||
					             ctx.params?.formData?._csrf ||
					             ctx.params?.query?._csrf;
					// v2.1.0: bind CSRF to the current session id. Without a
					// session, we cannot validate — refuse the request.
					const sessionId = ctx.request.sessionId
						|| ctx.request.session?.id
						|| ctx.session?.id;

					if (!token || !sessionId) {
						logger.warn({
							code: 'MC_SECURITY_CSRF_MISSING',
							message: 'CSRF token or session missing',
							context: {
								path: ctx.pathName, method: ctx.type,
								hasToken: !!token, hasSession: !!sessionId
							}
						});

						ctx.response.statusCode = 403;
						ctx.response.setHeader('Content-Type', 'application/json');
						ctx.response.end(JSON.stringify({
							error: 'CSRF token required',
							message: 'Include X-CSRF-Token header (or _csrf field) and a valid session'
						}));
						return;
					}

					const validation = validateCSRFToken(token, sessionId);
					if (!validation.valid) {
						logger.warn({
							code: 'MC_SECURITY_CSRF_INVALID',
							message: 'CSRF token validation failed',
							context: { path: ctx.pathName, reason: validation.reason }
						});

						ctx.response.statusCode = 403;
						ctx.response.setHeader('Content-Type', 'application/json');
						ctx.response.end(JSON.stringify({
							error: 'Invalid CSRF token',
							message: validation.reason
						}));
						return;
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
			if (typeof next === 'function') await next();
		};
	}

	/**
	 * Check if request is secure (HTTPS)
	 */
	static _isSecure(req) {
		// Prefer the framework's trust-proxy-aware helper. Falls back to the
		// raw checks if the master isn't bound (e.g. unit test).
		const master = SecurityEnforcement.__masterCache;
		if (master && typeof master.isRequestSecure === 'function') {
			return master.isRequestSecure(req);
		}
		// SECURITY: only honor X-Forwarded-Proto when no master is available
		// (e.g. unit test). In normal operation, isRequestSecure gates it on
		// trustedProxies, which prevents X-Forwarded-Proto bypass.
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
export default SecurityEnforcement;
// Self-registration with master.extend() now happens explicitly in
// MasterControl.setupServer() after bindMaster() has been called.
