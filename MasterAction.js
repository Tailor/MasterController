
// version 0.0.22

var master = require('./MasterControl');
var fileserver = require('fs');
var toolClass =  require('./MasterTools');
var tempClass =  require('./MasterTemplate');
var temp = new tempClass();
var tools = new toolClass();

class MasterAction{
	
	getView(location, data){
		var actionUrl =  master.root + location;
		var actionView = fileserver.readFileSync(actionUrl, 'utf8');
		return temp.htmlBuilder(actionView, data);
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
		var actionUrl = (location === undefined) ? this.__currentRoute.root + "/app/views/" +  this.__currentRoute.toController + "/" +  this.__currentRoute.toAction + ".html" : master.root + location;
		var actionView = fileserver.readFileSync(actionUrl, 'utf8');
		if(master.overwrite.isTemplate){
			masterView = master.overwrite.templateRender(data, "returnViewWithoutMaster");
		}
		else{
			masterView = temp.htmlBuilder(actionView, data);	
		}
		if (!this.__requestObject.response._headerSent) {
			this.__requestObject.response.writeHead(200, {'Content-Type': 'text/html'});
			this.__requestObject.response.end(masterView);
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

	returnView(data, location){
		
		var masterView = null;
		data = data === undefined ? {} : data;
		this.params = this.params === undefined ? {} : this.params;
        this.params = tools.combineObjects(data, this.params);
        var func = master.viewList;
        this.params = tools.combineObjects(this.params, func);
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
			this.__response.writeHead(200, {'Content-Type': 'text/html'});
			this.__response.end(masterView);
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


}

master.extendController(MasterAction);
