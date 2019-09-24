// MasterAPI- by Alexander Batista - Tailer 2017 - MIT Licensed 
// version 1.0.13 - beta -- node compatiable

var master = require('./MasterControl');
var fileserver = require('fs');
var ejs = require('ejs');
var tools =  master.tools;

class MasterAction{
	
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
		return ejs.render(getAction, data);
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
		this.params = tools.combineObjects(data, this.params);
		var func = master.viewList;
        this.params = tools.combineObjects(this.params, func);
		var actionUrl = (location === undefined) ? master.router.currentRoute.root + "/app/views/" +  master.router.currentRoute.toController + "/" +  master.router.currentRoute.toAction + ".html" : master.router.currentRoute.root + location;
		var actionView = fileserver.readFileSync(actionUrl, 'utf8');
		var masterView = ejs.render(actionView, data);
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
		data = data === undefined ? {} : data;
		this.params = this.params === undefined ? {} : this.params;
        this.params = tools.combineObjects(data, this.params);
        var func = master.viewList;
        this.params = tools.combineObjects(this.params, func);
		var viewUrl = (location === undefined || location === "" || location === null) ? master.router.currentRoute.root + "/app/views/" + master.router.currentRoute.toController + "/" +  master.router.currentRoute.toAction + ".html": master.router.currentRoute.root + "/app/" + location;
		var viewFile = fileserver.readFileSync(viewUrl,'utf8');
		var childView = ejs.render(viewFile, this.params);
		this.params.yield = childView;
		var masterFile = fileserver.readFileSync(master.router.currentRoute.root + "/app/views/layouts/master.html", 'utf8');
		var masterView = ejs.render(masterFile, this.params);

		if (!master.router.currentRoute.response.headersSent) {
			master.router.currentRoute.response.writeHead(200, {'Content-Type': 'text/html'});
			master.router.currentRoute.response.end(masterView);
		}
		
	}


}

// IMPORTANT
// you dont instatiate application controller extention methods because it will get done on build
master.extendController(MasterAction);