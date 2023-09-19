// version 0.0.1
var master = require('mastercontroller');

class TemplateOverwrite{

	#templateFunc;
	#isTemplate = false;

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

master.extend("overwrite", TemplateOverwrite);