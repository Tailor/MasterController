// version 0.0.1
var master = require('mastercontroller');

class TemplateOverwrite{

	#templateFunc;
	#isTemplate = false;

	// Lazy-load master to avoid circular dependency (Google-style lazy initialization)
	get _master() {
		if (!this.__masterCache) {
			this.__masterCache = require('./MasterControl');
		}
		return this.__masterCache;
	}

	get isTemplate(){
		return this.#isTemplate;
	}

    template(func){
		this.#isTemplate = true;
		this.#templateFunc = func === undefined ? null : func;
	}

	templateRender(data, type){
		if(this.#templateFunc){
			return this.#templateFunc(data, type);
		}
		else{
			console.log("cannot call template render when no function has been declared. ")
		}
	}

    close(response, code, content, end){
		response.writeHead(code, content.type);
		response.end(end);
	}
}

module.exports = { TemplateOverwrite };