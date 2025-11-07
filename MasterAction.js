
// version 0.0.22

var master = require('./MasterControl');
var fileserver = require('fs');
var toolClass =  require('./MasterTools');
var tempClass =  require('./MasterTemplate');
// Templating helpers
var temp = new tempClass();
var tools = new toolClass();

// Node utils
var path = require('path');

// Vanilla Web Components SSR runtime (LinkeDOM) - executes connectedCallback() and upgrades
const compileWebComponentsHTML = require('./ssr/runtime-ssr.cjs');

// Enhanced error handling
const { handleTemplateError, sendErrorResponse } = require('./MasterBackendErrorHandler');
const { safeReadFile } = require('./MasterErrorMiddleware');
const { logger } = require('./MasterErrorLogger');

// Security - CSRF, validation, sanitization
const { generateCSRFToken, validateCSRFToken } = require('./SecurityMiddleware');
const { validator, validateRequestBody, sanitizeObject } = require('./MasterValidator');
const { sanitizeUserHTML, escapeHTML } = require('./MasterSanitizer');

class MasterAction{
	
	getView(location, data){
		var actionUrl =  master.root + location;
		const fileResult = safeReadFile(fileserver, actionUrl);

		if (!fileResult.success) {
			const error = handleTemplateError(fileResult.error.originalError, actionUrl, data);
			throw error;
		}

		try {
			return temp.htmlBuilder(fileResult.content, data);
		} catch (error) {
			const mcError = handleTemplateError(error, actionUrl, data);
			throw mcError;
		}
	}


	returnJson(data){
		var json = JSON.stringify(data);
		if (!this.__response._headerSent) {
			this.__response.writeHead(200, {'Content-Type': 'application/json'});
			this.__response.end(json);
		}
	}

	// location starts from the view folder. Ex: partialViews/fileName.html
	returnPartialView(location, data){
		var actionUrl = master.root + location;
		var getAction = fileserver.readFileSync(actionUrl, 'utf8');
		if(master.overwrite.isTemplate){
			return master.overwrite.templateRender( data, "returnPartialView");
		}
		else{
			return temp.htmlBuilder(getAction, data);
		}
	}

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

		var requestObj = {
			toController : namespace,
			toAction : action,
			type : type,
			params : data
		}
		if(components){
			var resp = this.__requestObject.response;
			var req = this.__requestObject.request;
			master.router.currentRoute = {root : `${master.root}/components/${namespace}`, toController : namespace, toAction : action, response : resp, request: req };
		}else{
			master.router.currentRoute = {root : `${master.root}/${namespace}`, toController : namespace, toAction : action, response : resp, request: req };
		}
		

		master.router._call(requestObj);
	}
	
	// this will allow static pages without master view
	returnViewWithoutMaster(location, data){
		var masterView = null;
		this.params = this.params === undefined ? {} : this.params;
		this.params = tools.combineObjects(data, this.params);
		var func = master.viewList;
        this.params = tools.combineObjects(this.params, func);
    // Prefer page.js module if present (no legacy .html file)
    try {
      const controller = this.__currentRoute.toController;
      const action = this.__currentRoute.toAction;
      const pageModuleAbs = path.join(master.root, 'app/views', controller, action, 'page.js');
      if (fileserver.existsSync(pageModuleAbs)) {
        if (this._renderPageModule(controller, action, data)) { return; }
      }
    } catch (_) {}

		var actionUrl = (location === undefined) ? this.__currentRoute.root + "/app/views/" +  this.__currentRoute.toController + "/" +  this.__currentRoute.toAction + ".html" : master.root + location;
		var actionView = fileserver.readFileSync(actionUrl, 'utf8');
		if(master.overwrite.isTemplate){
			masterView = master.overwrite.templateRender(data, "returnViewWithoutMaster");
		}
		else{
			masterView = temp.htmlBuilder(actionView, data);	
		}
		if (!this.__requestObject.response._headerSent) {
			const send = (htmlOut) => {
				try {
					this.__requestObject.response.writeHead(200, {'Content-Type': 'text/html'});
					this.__requestObject.response.end(htmlOut);
				} catch (e) {
					// Fallback in case of double send
				}
			};
			try {
				Promise.resolve(compileWebComponentsHTML(masterView))
					.then(send)
					.catch(() => send(masterView));
			} catch (_) {
				send(masterView);
			}
		}
	}

	returnViewWithoutEngine(location){
		var actionUrl =  master.root + location;
		var masterView = fileserver.readFileSync(actionUrl, 'utf8');
		if (!this.__requestObject.response._headerSent) {
			this.__requestObject.response.writeHead(200, {'Content-Type': 'text/html'});
			this.__requestObject.response.end(masterView);
		}
	}

	returnReact(data, location){
		
			var masterView = null;
			data = data === undefined ? {} : data;
			this.params = this.params === undefined ? {} : this.params;
			this.params = tools.combineObjects(data, this.params);
			var func = master.viewList;
			this.params = tools.combineObjects(this.params, func);
			var html = master.reactView.compile(this.__currentRoute.toController, this.__currentRoute.toAction, this.__currentRoute.root);
		
	}

	returnView(data, location){
		
		var masterView = null;
		data = data === undefined ? {} : data;
		this.params = this.params === undefined ? {} : this.params;
        this.params = tools.combineObjects(data, this.params);
        var func = master.viewList;
        this.params = tools.combineObjects(this.params, func);
    // Prefer page.js module if present (no legacy .html file)
    try {
      const controller = this.__currentRoute.toController;
      const action = this.__currentRoute.toAction;
      const pageModuleAbs = path.join(master.root, 'app/views', controller, action, 'page.js');
      if (fileserver.existsSync(pageModuleAbs)) {
        if (this._renderPageModule(controller, action, data)) { return; }
      }
    } catch (_) {}

		var viewUrl = (location === undefined || location === "" || location === null) ? this.__currentRoute.root + "/app/views/" + this.__currentRoute.toController + "/" +  this.__currentRoute.toAction + ".html" : master.root + location;
		var viewFile = fileserver.readFileSync(viewUrl,'utf8');
		var masterFile = fileserver.readFileSync(this.__currentRoute.root + "/app/views/layouts/master.html", 'utf8');
		if(master.overwrite.isTemplate){
			masterView = master.overwrite.templateRender(this.params, "returnView");
		}
		else{
			var childView = temp.htmlBuilder(viewFile, this.params);
			this.params.yield = childView;
			masterView = temp.htmlBuilder(masterFile, this.params);
		}
		
		if (!this.__response._headerSent) {
			const send = (htmlOut) => {
				try {
					this.__response.writeHead(200, {'Content-Type': 'text/html'});
					this.__response.end(htmlOut);
				} catch (e) {
					// Fallback in case of double send
				}
			};
			try {
				Promise.resolve(compileWebComponentsHTML(masterView))
					.then(send)
					.catch(() => send(masterView));
			} catch (_) {
				send(masterView);
			}
		}
		
	}

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

  // Render using a page.js Web Component module when present
  _renderPageModule(controller, action, data) {
    try {
      const pageModuleAbs = path.join(master.root, 'app/views', controller, action, 'page.js');
      const layoutModuleAbs = path.join(master.root, 'app/views', 'layouts', 'master.js');
      const stylesPath = '/app/assets/stylesheets/output.css';
      const pageTag = `home-${action}-page`;

      const htmlDoc =
`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>${controller}/${action}</title>
    <link rel="stylesheet" href="${stylesPath}"/>
  </head>
  <body class="geist-variable antialiased">
    <root-layout>
      <${pageTag}></${pageTag}>
    </root-layout>
    <script type="module" src="/app/views/layouts/master.js"></script>
    <script type="module" src="/app/views/${controller}/${action}/page.js"></script>
  </body>
</html>`;

      const send = (htmlOut) => {
        try {
          const res = this.__response || (this.__requestObject && this.__requestObject.response);
          if (res && !res._headerSent) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(htmlOut);
          }
        } catch (_) {}
      };

      Promise
        .resolve(require('./ssr/runtime-ssr.cjs')(htmlDoc, [layoutModuleAbs, pageModuleAbs]))
        .then(send)
        .catch(() => send(htmlDoc));
    } catch (e) {
      // Fallback to legacy view if something goes wrong
      console.warn('[SSR] _renderPageModule failed:', e && e.message);
      return false;
    }
    return true;
  }

  // Delegate to standard Enhance-based SSR only
  returnWebComponent(data) {
    this.returnView(data);
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
   */
  requireHTTPS() {
    if (!this.isSecure()) {
      logger.warn({
        code: 'MC_SECURITY_HTTPS_REQUIRED',
        message: 'HTTPS required but request is HTTP',
        path: this.__requestObject.pathName
      });

      const httpsUrl = `https://${this.__requestObject.request.headers.host}${this.__requestObject.pathName}`;
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


master.extendController(MasterAction);
