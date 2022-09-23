
// version 1.0.17

var master = require('./MasterControl');
var fileserver = require('fs');
var tools =  require('./MasterTools');
var temp =  require('./MasterTemplate');
var templateFunc = null;

class MasterAction{

	init(opts){
		templateFunc = opts.templateFunc === undefined ? null : opts.templateFunc;
	}

	
	returnJson(data){
		var json = JSON.stringify(data);
		if (!master.router.currentRoute.response.headersSent) {
			master.router.currentRoute.response.writeHead(200, {'Content-Type': 'application/json'});
			master.router.currentRoute.response.end(json);
		}
	}

	// location starts from the view folder. Ex: partialViews/fileName.html
	returnPartialView(location, data){
		var actionUrl = master.router.currentRoute.root + "/app/views/" + location;
		var getAction = fileserver.readFileSync(actionUrl, 'utf8');
		if(typeof(templateFunc) === "function"){
			return templateFunc(getAction, data);
		}
		else{
			return temp.htmlBuilder(getAction, data);	
		}
	}

	redirectBack(fallback){
		if(fallback === undefined){
			var backUrl = master.router.currentRoute.request.headers.referer === "" ? "/" : master.router.currentRoute.request.headers.referer
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

		if (!master.router.currentRoute.response.headersSent) {
			master.router.currentRoute.response.writeHead(302, {
				'Location': doneParsedUrl
				//add other headers here...
			});
			master.router.currentRoute.response.end();
		}

	}
	

	// redirects to another action inside the same controller = does not reload the page
	redirectToAction(namespace, action, type, data){

		this.namespace = namespace,
		this.action = action;
		this.type = type;
		this.params = data;

		master.router._call(this);
	}
	
	// this will allow static pages without master view
	returnViewWithoutMaster(location, data){
		var masterView = null;
		this.params = tools.combineObjects(data, this.params);
		var func = master.viewList;
        this.params = tools.combineObjects(this.params, func);
		var actionUrl = (location === undefined) ? master.router.currentRoute.root + "/app/views/" +  master.router.currentRoute.toController + "/" +  master.router.currentRoute.toAction + ".html" : master.router.currentRoute.root + location;
		var actionView = fileserver.readFileSync(actionUrl, 'utf8');
		if(typeof(templateFunc) === "function"){
			masterView = templateFunc(actionView, data);
		}
		else{
			masterView = temp.htmlBuilder(actionView, data);	
		}
		if (!master.router.currentRoute.response.headersSent) {
			master.router.currentRoute.response.writeHead(200, {'Content-Type': 'text/html'});
			master.router.currentRoute.response.end(masterView);
		}
	}

	returnViewWithoutEngine(location){
		var actionUrl =  master.router.currentRoute.root + location;
		var masterView = fileserver.readFileSync(actionUrl, 'utf8');
		if (!master.router.currentRoute.response.headersSent) {
			master.router.currentRoute.response.writeHead(200, {'Content-Type': 'text/html'});
			master.router.currentRoute.response.end(masterView);
		}
	}

	returnView(data, location){
		var childView = null;
		var masterView = null;
		data = data === undefined ? {} : data;
		this.params = this.params === undefined ? {} : this.params;
        this.params = tools.combineObjects(data, this.params);
        var func = master.viewList;
        this.params = tools.combineObjects(this.params, func);
		var viewUrl = (location === undefined || location === "" || location === null) ? master.router.currentRoute.root + "/app/views/" + master.router.currentRoute.toController + "/" +  master.router.currentRoute.toAction + ".html": master.router.currentRoute.root + "/app/" + location;
		var viewFile = fileserver.readFileSync(viewUrl,'utf8');
		if(typeof(templateFunc) === "function"){
			childView = templateFunc(viewFile, this.params);
		}
		else{
			childView = temp.htmlBuilder(viewFile, this.params);
		}

		this.params.yield = childView;
		var masterFile = fileserver.readFileSync(master.router.currentRoute.root + "/app/views/layouts/master.html", 'utf8');
		if(typeof(templateFunc) === "function"){
			masterView = templateFunc(masterFile, this.params);
		}
		else{
			masterView = temp.htmlBuilder(masterFile, this.params);
		}
		

		if (!master.router.currentRoute.response.headersSent) {
			master.router.currentRoute.response.writeHead(200, {'Content-Type': 'text/html'});
			master.router.currentRoute.response.end(masterView);
		}
		
	}

	close(response, code, content, end){
		response.writeHead(code, content.type);
		response.end(end);
	}


}

// IMPORTANT
// you dont instatiate application controller extention methods because it will get done on build
var masterAction = new MasterAction();
// give option to change the template engine. Skips default template engine and calls templateFunc function. Inside this function you can return your own parsed TEXT or HTML.
master.extend({action: {
	init : masterAction.init,
	close: masterAction.close,
	templateFunc : templateFunc
} });
// you need to have access to functions inside the controller
master.extendController(masterAction);