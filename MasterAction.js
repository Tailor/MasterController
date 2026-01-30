
// version 0.0.23

const toolClass =  require('./MasterTools');
const tools = new toolClass();
// View templating removed - handled by view engine (e.g., MasterView)

// Node utils
const path = require('path');

// SSR runtime removed - handled by view engine

// Enhanced error handling
const { handleTemplateError, sendErrorResponse } = require('./error/MasterBackendErrorHandler');
const { safeReadFile } = require('./error/MasterErrorMiddleware');
const { logger } = require('./error/MasterErrorLogger');

// Security - CSRF, validation, sanitization
const { generateCSRFToken, validateCSRFToken } = require('./security/SecurityMiddleware');
const { validator, validateRequestBody, sanitizeObject } = require('./security/MasterValidator');
const { sanitizeUserHTML, escapeHTML } = require('./security/MasterSanitizer');

// HTTP Status Code Constants
const HTTP_STATUS = {
	OK: 200,
	REDIRECT: 302,
	BAD_REQUEST: 400,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	PAYLOAD_TOO_LARGE: 413,
	INTERNAL_ERROR: 500
};

class MasterAction{

	// Maximum response size (10MB default)
	static MAX_RESPONSE_SIZE = 10 * 1024 * 1024;

	// Lazy-load master to avoid circular dependency
	// Static getter ensures single instance (Singleton pattern - Google style)
	static get _master() {
		if (!MasterAction.__masterCache) {
			MasterAction.__masterCache = require('./MasterControl');
		}
		return MasterAction.__masterCache;
	}

	// getView() removed - handled by view engine (register via master.useView())

	/**
	 * Check if response is ready for writing (headers not sent)
	 * @private
	 * @returns {boolean} True if safe to write response
	 */
	_isResponseReady() {
		// Try primary response object first
		if (this.__response) {
			return !this.__response._headerSent && !this.__response.headersSent;
		}
		// Try request object response
		if (this.__requestObject && this.__requestObject.response) {
			const resp = this.__requestObject.response;
			return !resp._headerSent && !resp.headersSent;
		}
		// No response object yet (early lifecycle)
		return true;
	}

	/**
	 * Returns a JSON response to the client
	 * @param {Object|Array|string|number|boolean} data - Data to serialize as JSON
	 * @returns {void}
	 * @throws {Error} If JSON serialization fails or response already sent
	 * @example
	 * this.returnJson({ success: true, data: users });
	 */
	returnJson(data){
		try {
			if (!this._isResponseReady()) {
				logger.warn({
					code: 'MC_WARN_HEADERS_SENT',
					message: 'Attempted to send JSON but headers already sent'
				});
				return;
			}

			// Detect circular references
			const seen = new WeakSet();
			const json = JSON.stringify(data, (key, value) => {
				if (typeof value === 'object' && value !== null) {
					if (seen.has(value)) {
						return '[Circular Reference]';
					}
					seen.add(value);
				}
				return value;
			});

			// Check response size
			const byteSize = Buffer.byteLength(json, 'utf8');
			if (byteSize > MasterAction.MAX_RESPONSE_SIZE) {
				logger.error({
					code: 'MC_ERR_RESPONSE_TOO_LARGE',
					message: 'JSON response exceeds maximum size',
					size: byteSize,
					maxSize: MasterAction.MAX_RESPONSE_SIZE
				});
				this.returnError(HTTP_STATUS.PAYLOAD_TOO_LARGE, 'Response payload too large');
				return;
			}

			this.__response.writeHead(HTTP_STATUS.OK, {
				'Content-Type': 'application/json',
				'Content-Length': byteSize
			});
			this.__response.end(json);
		} catch (error) {
			logger.error({
				code: 'MC_ERR_JSON_SEND',
				message: 'Failed to send JSON response',
				error: error.message,
				stack: error.stack
			});

			// Attempt to send error response if possible
			if (this._isResponseReady()) {
				this.returnError(HTTP_STATUS.INTERNAL_ERROR, 'Internal server error');
			}
		}
	}

	// returnPartialView() removed - handled by view engine (register via master.useView())

	/**
	 * Redirects to the previous page (HTTP referer) with fallback
	 * @param {string} [fallback='/'] - Fallback URL if referer is invalid
	 * @returns {void}
	 * @security Only allows same-origin redirects to prevent open redirect attacks
	 * @example
	 * this.redirectBack('/home'); // Fallback to /home if referer invalid
	 */
	redirectBack(fallback){
		const referer = this.__requestObject.request.headers.referer || "";

		// Validate referer is same-origin or allowed domain
		if (referer && this._isValidRedirectUrl(referer)) {
			this.redirectTo(referer);
		} else if (fallback !== undefined) {
			this.redirectTo(fallback);
		} else {
			this.redirectTo("/");
		}
	}

	/**
	 * Validate URL is safe for redirect (same-origin only)
	 * @private
	 * @param {string} url - URL to validate
	 * @returns {boolean} True if URL is safe for redirect
	 */
	_isValidRedirectUrl(url) {
		try {
			const urlObj = new URL(url, `http://${this.__requestObject.request.headers.host}`);
			const requestHost = this.__requestObject.request.headers.host;

			// Only allow same-origin redirects
			return urlObj.host === requestHost;
		} catch (e) {
			return false;
		}
	}

	/**
	 * Validate URL is safe and properly formatted for redirect
	 * @private
	 * @param {string} url - URL to validate
	 * @throws {Error} If URL is invalid or dangerous
	 */
	_validateRedirectUrl(url) {
		if (!url || typeof url !== 'string') {
			throw new Error('Invalid redirect URL: must be non-empty string');
		}

		// Prevent protocol-relative URLs (//evil.com)
		if (url.startsWith('//')) {
			throw new Error('Invalid redirect URL: protocol-relative URLs not allowed');
		}

		// Prevent javascript: or data: URLs
		if (/^(javascript|data|vbscript|file):/i.test(url)) {
			throw new Error('Invalid redirect URL: dangerous protocol detected');
		}

		return true;
	}

	/**
	 * Redirects to another route via HTTP 302
	 * @param {string} url - Target URL path
	 * @param {Object} [obj={}] - Optional parameters (id goes to path, others to query string)
	 * @returns {void}
	 * @security All parameters are URL-encoded to prevent injection
	 * @example
	 * this.redirectTo('/users', { id: 5, filter: 'active' }); // → /users/5?filter=active
	 */
	redirectTo(url, obj = {}) {
		try {
			this._validateRedirectUrl(url);

			const parseUrl = url.replace(/\/$/, "");
			const queryParams = [];
			let idParam = null;

			for (const key in obj) {
				if (obj.hasOwnProperty(key)) {
					// Encode all values to prevent injection
					const encodedValue = encodeURIComponent(String(obj[key]));

					if (key === "id") {
						idParam = encodedValue;
					} else {
						queryParams.push(`${encodeURIComponent(key)}=${encodedValue}`);
					}
				}
			}

			let finalUrl = parseUrl;
			if (idParam) {
				finalUrl = `${finalUrl}/${idParam}`;
			}
			if (queryParams.length > 0) {
				finalUrl = `${finalUrl}?${queryParams.join('&')}`;
			}

			if (this._isResponseReady()) {
				this.__requestObject.response.writeHead(HTTP_STATUS.REDIRECT, {
					'Location': finalUrl
				});
				this.__requestObject.response.end();
			}
		} catch (error) {
			logger.error({
				code: 'MC_ERR_INVALID_REDIRECT',
				message: error.message,
				url
			});
			this.returnError(HTTP_STATUS.BAD_REQUEST, 'Invalid redirect URL');
		}
	}
	

	/**
	 * Internal redirect to another controller action (no HTTP redirect)
	 * @param {string} namespace - Controller name
	 * @param {string} action - Action/method name
	 * @param {string} type - Request type (GET, POST, etc.)
	 * @param {Object} data - Parameters to pass
	 * @param {boolean} [components=false] - Whether this is a component controller
	 * @returns {void}
	 * @example
	 * this.redirectToAction('users', 'show', 'GET', { id: 5 });
	 */
	redirectToAction(namespace, action, type, data, components){
		// FIXED: Declare variables before if/else to avoid undefined reference
		const resp = this.__requestObject.response;
		const req = this.__requestObject.request;

		const requestObj = {
			toController : namespace,
			toAction : action,
			type : type,
			params : data
		};

		if(components){
			MasterAction._master.router.currentRoute = {
				root : `${MasterAction._master.root}/components/${namespace}`,
				toController : namespace,
				toAction : action,
				response : resp,
				request: req
			};
		}else{
			MasterAction._master.router.currentRoute = {
				root : `${MasterAction._master.root}/${namespace}`,
				toController : namespace,
				toAction : action,
				response : resp,
				request: req
			};
		}

		MasterAction._master.router._call(requestObj);
	}
	
	// returnViewWithoutMaster() removed - handled by view engine (register via master.useView())

	// returnViewWithoutEngine() removed - handled by view engine (register via master.useView())

	// returnReact() removed - handled by view engine (register via master.useView())

	// returnView() removed - handled by view engine (register via master.useView())

	/**
	 * Close HTTP response with specified content
	 * @param {Object} response - HTTP response object
	 * @param {number} code - HTTP status code
	 * @param {Object} content - Content configuration with type property
	 * @param {string} end - Response body content
	 * @returns {void}
	 * @example
	 * this.close(response, 200, { type: { 'Content-Type': 'text/html' } }, '<h1>Hello</h1>');
	 */
	close(response, code, content, end){
		response.writeHead(code, content.type);
		response.end(end);
	}

	/**
	 * Utility method to check if response is ready for writing
	 * @returns {boolean} True if safe to continue, false if response already sent
	 * @deprecated Use _isResponseReady() instead
	 */
	waitUntilReady(){
		return this._isResponseReady();
	}

	/**
	 * Safe version of returnJson that checks readiness first
	 * @param {Object|Array|string|number|boolean} data - Data to serialize as JSON
	 * @returns {boolean} True if sent successfully, false if headers already sent
	 * @example
	 * if (!this.safeReturnJson({ data })) { logger.warn('Response already sent'); }
	 */
	safeReturnJson(data){
		if (this.waitUntilReady()) {
			this.returnJson(data);
			return true;
		}
		logger.warn({
			code: 'MC_WARN_SAFE_RETURN_JSON_FAILED',
			message: 'Attempted to send JSON response but headers already sent'
		});
		return false;
	}

  // _renderPageModule() removed - handled by view engine (register via master.useView())

  // returnWebComponent() removed - handled by view engine (register via master.useView())

  // ==================== Observability Methods ====================

  /**
   * Get or generate request ID for tracing
   * @returns {string} Unique request identifier
   * @example
   * const reqId = this.getRequestId(); // req_1234567890_abc123
   */
  getRequestId() {
    if (!this.__requestId) {
      this.__requestId = this.__requestObject?.headers?.['x-request-id'] ||
                        `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    return this.__requestId;
  }

  /**
   * Record timing metric for observability
   * @param {string} metric - Metric name
   * @param {number} duration - Duration in milliseconds
   * @returns {void}
   * @example
   * const start = Date.now();
   * // ... do work ...
   * this.recordTiming('db_query', Date.now() - start);
   */
  recordTiming(metric, duration) {
    logger.info({
      code: 'MC_METRIC_TIMING',
      metric,
      duration,
      requestId: this.getRequestId(),
      path: this.__requestObject?.pathName
    });
  }

  /**
   * Check if request should be rate limited
   * @returns {boolean} True if request allowed
   * @example
   * if (!this.checkRateLimit()) {
   *   return this.returnError(429, 'Too many requests');
   * }
   */
  checkRateLimit() {
    // Hook for rate limiting middleware
    if (MasterAction._master.rateLimiter) {
      const clientIp = this.__requestObject?.request?.headers?.['x-forwarded-for'] ||
                      this.__requestObject?.request?.connection?.remoteAddress;
      return MasterAction._master.rateLimiter.check(clientIp, this.__requestObject?.pathName);
    }
    return true;
  }

  // ==================== Security Methods ====================

  /**
   * Generate CSRF token for forms
   * Usage: const token = this.generateCSRFToken();
   */
  generateCSRFToken() {
    const sessionId = this.__requestObject && this.__requestObject.session ? this.__requestObject.session.id : null;
    return generateCSRFToken(sessionId);
  }

  /**
   * Validate CSRF token from request
   * Usage: if (!this.validateCSRF()) { return this.returnError(403, 'Invalid CSRF token'); }
   */
  validateCSRF(token = null) {
    // Get token from parameter, header, or body
    const csrfToken = token ||
                      this.__requestObject.headers['x-csrf-token'] ||
                      (this.__requestObject.body && this.__requestObject.body._csrf) ||
                      this.params._csrf;

    if (!csrfToken) {
      logger.warn({
        code: 'MC_SECURITY_CSRF_MISSING',
        message: 'CSRF token missing in request',
        path: this.__requestObject.pathName
      });
      return false;
    }

    const validation = validateCSRFToken(csrfToken);

    if (!validation.valid) {
      logger.warn({
        code: 'MC_SECURITY_CSRF_INVALID',
        message: 'CSRF token validation failed',
        path: this.__requestObject.pathName,
        reason: validation.reason
      });
      return false;
    }

    return true;
  }

  /**
   * Validate request body against schema
   * Usage: const result = this.validateRequest({ email: { type: 'email' }, age: { type: 'integer', min: 18 } });
   */
  validateRequest(schema = {}) {
    const body = this.__requestObject.body || this.params || {};
    const result = validateRequestBody(body, schema);

    if (!result.valid) {
      logger.warn({
        code: 'MC_VALIDATION_REQUEST_FAILED',
        message: 'Request validation failed',
        path: this.__requestObject.pathName,
        errors: result.errors
      });
    }

    return result;
  }

  /**
   * Sanitize user input (HTML)
   * Usage: const clean = this.sanitizeInput(userInput);
   */
  sanitizeInput(input) {
    if (typeof input === 'string') {
      return sanitizeUserHTML(input);
    } else if (typeof input === 'object' && input !== null) {
      return sanitizeObject(input);
    }
    return input;
  }

  /**
   * Escape HTML for display
   * Usage: const safe = this.escapeHTML(userContent);
   */
  escapeHTML(text) {
    return escapeHTML(text);
  }

  /**
   * Validate single field
   * Usage: const result = this.validate(email, { type: 'email' });
   */
  validate(value, rules = {}) {
    switch (rules.type) {
      case 'string':
        return validator.validateString(value, rules);
      case 'integer':
        return validator.validateInteger(value, rules);
      case 'email':
        return validator.validateEmail(value, rules);
      case 'url':
        return validator.validateURL(value, rules);
      case 'uuid':
        return validator.validateUUID(value, rules);
      default:
        return { valid: true, value };
    }
  }

  /**
   * Check if request is secure (HTTPS)
   */
  isSecure() {
    const req = this.__requestObject.request || this.__requestObject;
    return req.connection.encrypted || req.headers['x-forwarded-proto'] === 'https';
  }

  /**
   * Require HTTPS for this action
   * Usage: if (!this.requireHTTPS()) return;
   * FIXED: Uses configured hostname, not unvalidated Host header
   */
  requireHTTPS() {
    if (!this.isSecure()) {
      logger.warn({
        code: 'MC_SECURITY_HTTPS_REQUIRED',
        message: 'HTTPS required but request is HTTP',
        path: this.__requestObject.pathName
      });

      // SECURITY FIX: Never use Host header from request (open redirect vulnerability)
      // Use configured hostname instead
      const configuredHost = MasterAction._master.env?.server?.hostname || 'localhost';
      const httpsPort = MasterAction._master.env?.server?.httpsPort || 443;
      const port = httpsPort === 443 ? '' : `:${httpsPort}`;

      // Validate configured host exists
      if (!configuredHost || configuredHost === 'localhost') {
        logger.error({
          code: 'MC_CONFIG_MISSING_HOSTNAME',
          message: 'requireHTTPS called but no hostname configured in MasterAction._master.env.server.hostname'
        });
        this.returnError(HTTP_STATUS.INTERNAL_ERROR, 'Server misconfiguration');
        return false;
      }

      const httpsUrl = `https://${configuredHost}${port}${this.__requestObject.pathName}`;
      this.redirectTo(httpsUrl);
      return false;
    }
    return true;
  }

  /**
   * Return error response with proper status
   * @param {number} statusCode - HTTP status code
   * @param {string} message - Error message
   * @param {Object} [details={}] - Additional error details
   * @returns {void}
   * @example
   * this.returnError(400, 'Invalid input');
   */
  returnError(statusCode, message, details = {}) {
    if (this._isResponseReady()) {
      const res = this.__response || (this.__requestObject && this.__requestObject.response);

      const errorResponse = {
        error: true,
        statusCode,
        message,
        timestamp: new Date().toISOString(),
        path: this.__requestObject?.pathName,
        method: this.__requestObject?.request?.method,
        ...details
      };

      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(errorResponse));

      // Log error for monitoring
      logger.error({
        code: 'MC_ERR_CLIENT_ERROR',
        statusCode,
        message,
        path: errorResponse.path,
        method: errorResponse.method
      });
    }
  }

}

// Export for MasterControl and register after event loop (prevents circular dependency)
// This is the Lazy Registration pattern used by Spring Framework, Angular, Google Guice
module.exports = MasterAction;

// Use setImmediate to register after master is fully loaded
setImmediate(() => {
	const master = require('./MasterControl');
	if (master && master.extendController) {
		master.extendController(MasterAction);
	}
});
