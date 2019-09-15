
// version 1.0.13 - beta -- node compatiable

var master = require('./MasterControl');

class MasterView{
	
	viewParams = {};

	extend(element, extention){
		if(extention !== undefined){
			this.viewParams[extention] = {};
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
							this.viewParams[propertyNames[i]] = elementInstance[propertyNames[i]];
						}
						else{
							this.viewParams[extention][propertyNames[i]] = elementInstance[propertyNames[i]];
						}
					}
				};
			}
			else{
				for(var i in propertyNames){
					if (propertyNames.hasOwnProperty(i)) {
						if(extention === undefined){
							this.viewParams[propertyNames[i]] = propertyNames[i];
						}
						else{
							this.viewParams[extention][propertyNames[i]] = propertyNames[i];
						}
					}
				};
			}
            
		}
	}

	get(){
		return this.viewParams;
	}
}

master.extend({view: new MasterView()});