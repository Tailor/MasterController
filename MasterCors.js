// version 0.0.3 - robust origin handling (all envs), creds-safe reflection, function origins, extended Vary

const { logger } = require('./error/MasterErrorLogger');

// HTTP Status Code Constants
const HTTP_STATUS = {
	NO_CONTENT: 204,
	BAD_REQUEST: 400
};

// CORS Header Name Constants
const CORS_HEADERS = {
	ALLOW_ORIGIN: 'Access-Control-Allow-Origin',
	ALLOW_METHODS: 'Access-Control-Allow-Methods',
	ALLOW_HEADERS: 'Access-Control-Allow-Headers',
	ALLOW_CREDENTIALS: 'Access-Control-Allow-Credentials',
	MAX_AGE: 'Access-Control-Max-Age',
	EXPOSE_HEADERS: 'Access-Control-Expose-Headers',
	REQUEST_HEADERS: 'Access-Control-Request-Headers',
	REQUEST_METHOD: 'Access-Control-Request-Method',
	VARY: 'Vary'
};

// todo - res.setHeader('Access-Control-Request-Method', '*');
class MasterCors{

	// Lazy-load master to avoid circular dependency (Google-style lazy initialization)
	get _master() {
		if (!this.__masterCache) {
			this.__masterCache = require('./MasterControl');
		}
		return this.__masterCache;
	}

	init(options){
		if(options){
			this.options = options;
		}
		else{
			logger.warn({
				code: 'MC_CORS_OPTIONS_MISSING',
				message: 'CORS options missing'
			});
		}

		// Auto-register with pipeline if available
		if (this._master.pipeline) {
			this._master.pipeline.use(this.middleware());
		}

		return this; // Chainable
	}

	load(params){
		if(params){
			this.response = params.response;
			this.request = params.request;
			// Always signal that response may vary by Origin and requested headers/method
			try {
				this.response.setHeader('Vary', 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method');
			} catch(error) {
				logger.warn({
					code: 'MC_CORS_VARY_HEADER_FAILED',
					message: 'Failed to set Vary header',
					error: error.message
				});
			}
			this.configureOrigin();
			this.configureMethods()
			this.configureAllowedHeaders();
			this.configureExposeHeaders();
			this.configureCredentials();
			this.configureMaxAge();
		}
		else{
			logger.warn({
				code: 'MC_CORS_PARAMS_MISSING',
				message: 'CORS response and request params missing'
			});
		}
	}

	setHeader(header, value){
		this.response.setHeader(header, value);
	}

	removeHeader(header){
		this.response.removeHeader(header);
	}

	configureOrigin(){
		// this will set the origin based on the the options value
		if(this.options.origin){
			
			if(typeof this.options.origin === 'string'){
				this.setHeader('access-control-allow-origin', this.options.origin);
			}

			if(this.options.origin === true){
				// If credentials are enabled, reflect request origin per spec
				const requestOrigin =this.request.headers.origin;
				if (this.options.credentials === true && requestOrigin) {
					this.setHeader('access-control-allow-origin', requestOrigin);
				} else {
					this.setHeader('access-control-allow-origin', '*');
				}
			}

			// remove all origins
			if(this.options.origin === false){
				this.removeHeader('access-control-allow-origin');
			}
				
			if(Array.isArray(this.options.origin)){
				// Get the origin from the incoming request
				const requestOrigin =this.request.headers.origin;
				
				// Check if the request origin is in our allowed list
				if(requestOrigin && this.options.origin.includes(requestOrigin)){
					this.setHeader('access-control-allow-origin', requestOrigin);
				}
				// If no specific origin matches, don't set the header
			}

			// Function predicate support: (origin, req) => boolean|string
			if (typeof this.options.origin === 'function'){
				try {
					const requestOrigin = this.request.headers.origin;
					const res = this.options.origin(requestOrigin, this.request);
					if (res === true && requestOrigin){
						this.setHeader('access-control-allow-origin', requestOrigin);
					}
					else if (typeof res === 'string' && res){
						this.setHeader('access-control-allow-origin', res);
					}
				} catch(error) {
					logger.error({
						code: 'MC_CORS_ORIGIN_FUNCTION_ERROR',
						message: 'Error in origin function predicate',
						error: error.message,
						stack: error.stack
					});
				}
			}

		}
	}

	configureMethods(){
		if(this.options.methods){
			if(Array.isArray(this.options.methods)){
				const elements =this.options.methods.join(", ");
				this.setHeader('access-control-allow-methods', elements);
			}
		}
	}

	configureAllowedHeaders(){
		const requestheader =this.request.headers["access-control-request-headers"];
		const $that =this;
		if(this.options.allowedHeaders){

			if($that.options.allowedHeaders === true){
				// get Access-Control-Request-Headers
				$that.request.headers['access-control-allow-headers'] = requestheader;
				this.setHeader("access-control-allow-headers", "*");
			}

			// remove all headers
			if($that.options.allowedHeaders === false){
				delete $that.request.headers['access-control-allow-headers'];
				this.removeHeader("access-control-allow-headers", "*");
			}

			if(typeof $that.options.allowedHeaders === 'string'){
				$that.request.headers['access-control-allow-headers'] = $that.options.allowedHeaders;
				this.setHeader("access-control-allow-headers", $that.options.allowedHeaders);
			}
				
			if(Array.isArray($that.options.allowedHeaders)){
				const elements =$that.options.allowedHeaders.join(", ");
				$that.request.headers['access-control-allow-headers'] = elements;
				this.setHeader("access-control-allow-headers", elements);
			}

		}
	}

	configureExposeHeaders(){
		//exposeHeaders
		//Access-Control-Expose-Headers
		if(this.options.exposeHeaders){

			// remove all headers
			if(this.options.exposeHeaders === false){
				this.removeHeader('access-control-expose-headers');
			}

			if(typeof this.options.exposeHeaders === 'string'){
				this.setHeader('access-control-expose-headers', this.options.exposeHeaders);
			}
				
			if(Array.isArray(this.options.exposeHeaders)){
				const elements =this.options.exposeHeaders.join(", ");
				this.setHeader('access-control-expose-headers', elements);
			}

		}
	}

	configureCredentials(){
		if(this.options.credentials){
			if(typeof this.options.credentials === "boolean"){
				this.setHeader('access-control-allow-credentials', this.options.credentials);
			}
		}
	}

	configureMaxAge(){
		if(this.options.maxAge){
			if(typeof this.options.maxAge === "number"){
				this.setHeader('access-control-allow-max-age', this.options.maxAge);
			}
		}
	}

	/**
	 * Get CORS middleware for the pipeline
	 * Handles both preflight OPTIONS requests and regular requests
	 */
	middleware() {
		const $that =this;

		return async (ctx, next) => {
			// Handle preflight OPTIONS request
			if (ctx.type === 'options') {
				$that.load({ request: ctx.request, response: ctx.response });
				ctx.response.statusCode = 204;
				ctx.response.end();
				return; // Terminal - don't call next()
			}

			// Regular request - apply CORS headers
			$that.load({ request: ctx.request, response: ctx.response });
			await next();
		};
	}
}

module.exports = { MasterCors };
