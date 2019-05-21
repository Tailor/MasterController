// MasterAPI- by Alexander Batista - Tailer 2017 - MIT Licensed 
// version 1.0.13 - beta -- node compatiable

var master = require('./MasterControl');
var fileserver = require('fs');
var ejs = require('ejs');
var tools = require('./Tools');

class MasterAction{
	
	returnJson(data){
		var json = JSON.stringify(data);
		if (!this.response.headersSent) {
			this.response.writeHead(200, {'Content-Type': 'application/json'});
			this.response.end(json);
		}
	}

	// location starts from the view folder. Ex: partialViews/fileName.html
	returnPartialView(location, data){
		var actionUrl = this.root + "/app/views/" + location;
		var getAction = fileserver.readFileSync(actionUrl, 'utf8');
		return ejs.render(getAction, data);
	}

	redirectBack(fallback){
		var fallback = fallback === undefined ? "/" : fallback;
		var backURL = this.request.header('Referer') || fallback;
		this.redirectTo(backURL);
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

		if (!this.response.headersSent) {
			this.response.writeHead(302, {
				'Location': doneParsedUrl
				//add other headers here...
			});
			this.response.end();
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
	returnViewWithoutMaster( location, data){
		this.params = toosl.combineObjects(data, this.params);
		var func = master.view.get();
        this.params = tools.combineObjects(this.params, func);
		var actionUrl = (location === undefined) ? this.root + "/app/views/" +  this.namespace + "/" +  this.action + ".html" : this.root + location;
		var actionView = fileserver.readFileSync(actionUrl, 'utf8');
		var masterView = ejs.render(actionView, data);
		if (!this.response.headersSent) {
			this.response.writeHead(200, {'Content-Type': 'text/html'});
			this.response.end(masterView);
		}
	}

	returnViewWithoutEngine(location){
		var actionUrl =  this.root + location;
		var masterView = fileserver.readFileSync(actionUrl, 'utf8');
		if (!this.response.headersSent) {
			this.response.writeHead(200, {'Content-Type': 'text/html'});
			this.response.end(masterView);
		}
	}

	returnView( location, data){
        this.params = tools.combineObjects(data, this.params);
        var func = master.view.get();
        this.params = tools.combineObjects(this.params, func);
		var viewUrl = (location === undefined) ? this.root + "/app/views/" + this.namespace + "/" +  this.action + ".html": this.root + "/app/" + location;

		var viewFile = fileserver.readFileSync(viewUrl,'utf8');
		var childView = ejs.render(viewFile, this.params);
		this.params.yield = childView;
		var masterFile = fileserver.readFileSync(this.root + "/app/views/layouts/master.html", 'utf8');
		var masterView = ejs.render(masterFile, this.params);

		if (!this.response.headersSent) {
			this.response.writeHead(200, {'Content-Type': 'text/html'});
			this.response.end(masterView);
		}
		
	}


}

// IMPORTANT
// you dont instatiate application controller extention methods because it will get done on build
master.extendController(MasterAction);