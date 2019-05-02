// MasterAPI- by Alexander Batista - Tailer 2017 - MIT Licensed 
// version 1.0.13 - beta -- node compatiable

var master = require('./MasterControl');

var viewParams = {};

class MasterView{
	extend(element, extention){
		if(extention !== undefined){
			viewParams[extention] = {};
		}
		if(element.prototype === undefined) {
            throw "cannot extend MasterView using an instantiated class";
		}
		else{
			var propertyNames = Object.getOwnPropertyNames(element.prototype);
			var type = typeof element;
			if(type === "function"){
				var elementInstance = new element();
				for(var i in propertyNames){
					if (propertyNames.hasOwnProperty(i)) {
						if(extention === undefined){
							viewParams[propertyNames[i]] = elementInstance[propertyNames[i]];
						}
						else{
							viewParams[extention][propertyNames[i]] = elementInstance[propertyNames[i]];
						}
					}
				};
			}
			else{
				for(var i in propertyNames){
					if (propertyNames.hasOwnProperty(i)) {
						if(extention === undefined){
							viewParams[propertyNames[i]] = propertyNames[i];
						}
						else{
							viewParams[extention][propertyNames[i]] = propertyNames[i];
						}
					}
				};
			}
            
		}
	}

	get(){
		return viewParams;
	}
}

master.extend({view: new MasterView()});