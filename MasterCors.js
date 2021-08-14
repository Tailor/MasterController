// version 1.3
var master = require('./MasterControl');
	// todo - res.setHeader('Access-Control-Request-Method', '*');
class MasterCors{

	init(options){
		if(options){
			this.options = options;
		}
		else{
			master.error.log("cors options missing", "warn");
		}
	}

	load(params){
		if(params){
			this.response = params.response;
			this.request = params. request;
			this.configureOrigin();
			this.configureMethods()
			this.configureAllowedHeaders();
			this.configureExposeHeaders();
			this.configureCredentials();
			this.configureMaxAge();
		}
		else{
			master.error.log("cors response and requests missing", "warn");
		}
	}

	configureOrigin(){
		// this will set the origin based on the the options value
		if(this.options.origin){
			var originBool = JSON.parse(this.options.origin);
			if(originBool === true){
				this.response.setHeader('Access-Control-Allow-Origin', '*');
			}

			// remove all origins
			if(originBool === false){
				this.response.removeHeader('Access-Control-Allow-Origin');
			}

			if(typeof this.options.origin === 'string'){
				this.response.setHeader('Access-Control-Allow-Origin', this.options.origin);
			}
				
			if(this.options.origin.constructor === Array){
				// loop through list of array and set the once thatis found from the request because you can only setone at a time			
				var requestURL = this.request.url;
				for (const element of this.options.origin) {
					if(element === requestURL){
						this.response.setHeader('Access-Control-Allow-Origin', element);
					}
				}
			
			}

		}
	}

	configureMethods(){
		if(this.options.methods){
			if(this.options.methods.constructor === Array){
				var elements = this.options.methods.join(", ");
				this.response.setHeader('Access-Control-Allow-Methods', elements);
			}
		}
	}

	configureAllowedHeaders(){
		var requestheader = this.request.headers["access-control-request-headers"];
		if(this.options.allowedHeaders){
			var allowedBool = JSON.parse(this.options.allowedHeaders);
			if(allowedBool === true){
				// get Access-Control-Request-Headers 
				this.request.setHeader('Access-Control-Allow-Headers', requestheader);
			}

			// remove all headers
			if(allowedBool === false){
				this.request.removeHeader('Access-Control-Allow-Headers');
			}

			if(this.options.allowedHeaders === 'string'){
				this.request.setHeader('Access-Control-Allow-Headers', this.options.allowedHeaders);
			}
				
			if(this.options.allowedHeaders.constructor === Array){
				var elements = this.options.allowedHeaders.join(", ");
				this.request.setHeader('Access-Control-Allow-Headers', elements);
			}

		}
	}

	configureExposeHeaders(){
		//exposeHeaders
		//Access-Control-Expose-Headers
		if(this.options.exposeHeaders){
			var allowedBool = JSON.parse(this.options.exposeHeaders);
			// remove all headers
			if(allowedBool === false){
				this.response.removeHeader('Access-Control-Expose-Headers');
			}

			if(this.options.exposeHeaders === 'string'){
				this.response.setHeader('Access-Control-Expose-Headers', this.options.exposeHeaders);
			}
				
			if(this.options.exposeHeaders.constructor === Array){
				var elements = this.options.exposeHeaders.join(", ");
				this.response.setHeader('Access-Control-Expose-Headers', elements);
			}

		}
	}

	configureCredentials(){
		if(this.options.credentials){
			var credentialsBool = JSON.parse(this.options.credentials);
			if(typeof credentialsBool === "boolean"){
				this.response.setHeader('Access-Control-Allow-Credentials', credentialsBool);
			}
		}
	}

	configureMaxAge(){
		if(this.options.maxAge){
			var maxAgeNumber = parseInt(this.options.maxAge);
			if(typeof maxAgeNumber === "number"){
				this.response.setHeader('Access-Control-Allow-Max-Age', maxAgeNumber);
			}
		}
	}
}

master.extend({cors: new MasterCors() });