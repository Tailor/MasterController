
// version 0.0.23

var fileserver = require('fs');
var toolClass =  require('./MasterTools');
var tools = new toolClass();
// View templating removed - handled by view engine (e.g., MasterView)

// Node utils
var path = require('path');

// SSR runtime removed - handled by view engine

// Enhanced error handling
const { handleTemplateError, sendErrorResponse } = require('./error/MasterBackendErrorHandler');
const { safeReadFile } = require('./error/MasterErrorMiddleware');
const { logger } = require('./error/MasterErrorLogger');

// Security - CSRF, validation, sanitization
const { generateCSRFToken, validateCSRFToken } = require('./security/SecurityMiddleware');
const { validator, validateRequestBody, sanitizeObject } = require('./security/MasterValidator');
const { sanitizeUserHTML, escapeHTML } = require('./security/MasterSanitizer');

class MasterAction{

	// Lazy-load master to avoid circular dependency
	// Static getter ensures single instance (Singleton pattern - Google style)
	static get _master() {
		if (!MasterAction.__masterCache) {
			MasterAction.__masterCache = require('./MasterControl');
		}
		return MasterAction.__masterCache;
	}

	// getView() removed - handled by view engine (register via master.useView())


	returnJson(data){
		try {
			const json = JSON.stringify(data);
			// FIXED: Check both _headerSent and headersSent for compatibility
			if (!this.__response._headerSent && !this.__response.headersSent) {
				this.__response.writeHead(200, {'Content-Type': 'application/json'});
				this.__response.end(json);
			} else {
				logger.warn({
					code: 'MC_WARN_HEADERS_SENT',
					message: 'Attempted to send JSON but headers already sent'
				});
			}
		} catch (error) {
			logger.error({
				code: 'MC_ERR_JSON_SEND',
				message: 'Failed to send JSON response',
				error: error.message,
				stack: error.stack
			});
		}
	}

	// returnPartialView() removed - handled by view engine (register via master.useView())

	redirectBack(fallback){
		if(fallback === undefined){
			var backUrl = this.__requestObject.request.headers.referer === "" ? "/" : this.__requestObject.request.headers.referer
			this.redirectTo(backUrl);
		}
		else{
			this.redirectTo(fallback);
		}
	}

	// redirects to another controller =  does not reload the page
	redirectTo(url, obj){

		var parseUrl = url.replace(/\/$/, ""); // /board/

		var queryString = "/?";
		var objCounter = 0;
		for (var key in obj) {
			if (obj.hasOwnProperty(key)) {
				if(key === "id"){
					parseUrl = parseUrl + "/" + obj[key]; // /board/5
				}else{
					objCounter++;
					if(objCounter > 1){
						queryString = queryString + "&";
					}
					queryString = queryString + key + "=" + obj[key]; //?james=dfdfd&queryString
				}
				 //?james=dfdfd&rih=sdsd&
			}
		};

		var doneParsedUrl = objCounter >= 1 ? parseUrl + queryString : parseUrl; // /boards?james=dfdfd&rih=sdsd&

		if (!this.__requestObject.response._headerSent) {
			this.__requestObject.response.writeHead(302, {
				'Location': doneParsedUrl
				//add other headers here...
			});
			this.__requestObject.response.end();
		}

	}
	

	// redirects to another action inside the same controller = does not reload the page
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

	close(response, code, content, end){
		response.writeHead(code, content.type);
		response.end(end);
	}

	// Utility method to check if response is ready for writing
	// Returns true if safe to continue, false if response already sent
	waitUntilReady(){
		// Check the primary response object first (matches existing returnJson pattern)
		if (this.__response) {
			return !this.__response._headerSent;
		}
		// Check request object response as fallback (matches existing redirectTo pattern)
		if (this.__requestObject && this.__requestObject.response) {
			return !this.__requestObject.response._headerSent;
		}
		// If neither exists, assume it's safe to continue (early in request lifecycle)
		return true;
	}

  // Enhanced returnJson that checks readiness first
	safeReturnJson(data){
		if (this.waitUntilReady()) {
			this.returnJson(data);
			return true;
		}
		console.warn('Attempted to send JSON response but headers already sent');
		return false;
	}

  // _renderPageModule() removed - handled by view engine (register via master.useView())

  // returnWebComponent() removed - handled by view engine (register via master.useView())

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
        this.returnError(500, 'Server misconfiguration');
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
   * Usage: this.returnError(400, 'Invalid input');
   */
  returnError(statusCode, message, details = {}) {
    const res = this.__response || (this.__requestObject && this.__requestObject.response);

    if (res && !res._headerSent) {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: true,
        statusCode,
        message,
        ...details
      }));
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
