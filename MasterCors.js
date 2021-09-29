// version 1.1.6
var master = require('./MasterControl');
var tools =  require('./MasterTools');

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

	setHeader(header, value){
		this.response.setHeader(header, value);
	}

	removeHeader(header){
		this.response.removeHeader(header);
	}

	configureOrigin(){
		// this will set the origin based on the the options value
		if(this.options.origin){
			var originBool = JSON.parse(this.options.origin);
			if(originBool === true){
				this.setHeader('access-control-allow-origin', '*');
			}

			// remove all origins
			if(originBool === false){
				this.removeHeader('access-control-allow-origin');
			}

			if(typeof this.options.origin === 'string'){
				this.setHeader('access-control-allow-arigin', this.options.origin);
			}
				
			if(this.options.origin.constructor === Array){
				// loop through list of array and set the once thatis found from the request because you can only setone at a time			
				var requestURL = this.request.url;
				for (const element of this.options.origin) {
					if(element === requestURL){
						this.setHeader('access-control-allow-arigin', element);
					}
				}
			
			}

		}
	}

	configureMethods(){
		if(this.options.methods){
			if(this.options.methods.constructor === Array){
				var elements = this.options.methods.join(", ");
				this.setHeader('access-control-allow-methods', elements);
			}
		}
	}

	configureAllowedHeaders(){
		var requestheader = this.request.headers["access-control-request-headers"];
		var $that = this;
		if(this.options.allowedHeaders){
			var allowedBool = JSON.parse($that.options.allowedHeaders);
			if(allowedBool === true){
				// get Access-Control-Request-Headers

				$that.request.headers['access-control-allow-headers'] = requestheader;
				this.setHeader("access-control-allow-headers", "*");
			}

			// remove all headers
			if(allowedBool === false){
				delete $that.request.headers['access-control-allow-headers'];
				this.removeHeader("access-control-allow-headers", "*");
			}

			if($that.options.allowedHeaders === 'string'){
				$that.request.headers['access-control-allow-headers'] = $that.options.allowedHeaders;
				this.setHeader("access-control-allow-headers", $that.options.allowedHeaders);
			}
				
			if($that.options.allowedHeaders.constructor === Array){
				var elements = $that.options.allowedHeaders.join(", ");
				$that.request.headers['access-control-allow-headers'] = elements;
				this.setHeader("access-control-allow-headers", elements);
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
				this.removeHeader('access-control-expose-headers');
			}

			if(this.options.exposeHeaders === 'string'){
				this.setHeader('access-control-expose-headers', this.options.exposeHeaders);
			}
				
			if(this.options.exposeHeaders.constructor === Array){
				var elements = this.options.exposeHeaders.join(", ");
				this.setHeader('access-control-expose-headers', elements);
			}

		}
	}

	configureCredentials(){
		if(this.options.credentials){
			var credentialsBool = JSON.parse(this.options.credentials);
			if(typeof credentialsBool === "boolean"){
				this.setHeader('access-control-allow-credentials', credentialsBool);
			}
		}
	}

	configureMaxAge(){
		if(this.options.maxAge){
			var maxAgeNumber = parseInt(this.options.maxAge);
			if(typeof maxAgeNumber === "number"){
				this.setHeader('access-control-allow-max-age', maxAgeNumber);
			}
		}
	}
}

master.extend({cors: new MasterCors() });