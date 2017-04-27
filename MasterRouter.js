// version 1
// TESTING NEEDED -> NODESERVER


( function( global, factory ) {

    "use strict";

    if ( typeof module === "object" && typeof module.exports === "object" ) {
        module.exports = factory( global );
    } else {
        factory( global );
    }

} )( typeof window !== "undefined" ? window : this, function( window, noGlobal ) {
        
    var _masterController;
    var routeList =[];

    var MasterRouter = function(masterController, callBack) {

        if(masterController === null || masterController === undefined){
            throw new Error("Master Controller not found");
        }

        _masterController = masterController;
        if(callBack !== undefined){
            callBack();
        }

        return MasterRouter.fn;
    };

    MasterRouter.fn = MasterRouter.prototype = {

        route : function( path, toPath, type){

            var route = {
                type: type,
                path: path,
                toPath :toPath
            }

            routeList.push(route);
            return this;
        }
    };

    var _getControllerNameFromPath = function(pathName){
        const url = pathName.split("/");
        var controller = url[1];
        if (controller === null) {
            controller = "root";
        }
        return controller;
    };

    var _getActionNameFromPath = function(pathName){
        const url = pathName.split("/");
        var action = url[2];
        if (action === null) {
            action = "index";
        }
        return action;
    };


    var _callController = function (controllerName, scope) {

            if (controllerName === undefined) 
                throw new Error("Cannot call Controller witout Controller name");

            _masterController.callController(controllerName, scope);

    };

    var _callAction = function (actionName, controllerName, scope) {

            if (actionName === undefined) 
                throw new Error("Cannot call Action witout Action name");

            _masterController.callAction( actionName, controllerName, scope);

    };

    var _callModule = function (moduleName, actionName, controllerName, scope) {
            if (moduleName === undefined) 
                throw new Error("Cannot call Action witout Action name");
            
            _masterController.callModule(moduleName, actionName, controllerName, scope);
    };

    // at this point have the path, controler, and action names
    var _digestRoute = function(controller, action, type) {
        
        // find route accociated with controller and action
        var route = _findRoute(controller, action, type);
        if(route < 0){
                // TODO: if no routes found then just call regular routes and default to get
                _callController(controller);
                _callAction(action, controller);
            }

        else{
            // TODO if route is found then use route to call controller
            var routeController = _getControllerNameFromPath(route.toPath);
            var routeAction = _getActionNameFromPath(route.toPath);
            routeAction = routeAction === undefined || routeAction === "" ? "index" : routeAction;
            _callController(routeController);
            _callAction(routeAction, routeController);
        }
    };


    var _findRoute = function(controller, action, type){
        // url path
        var path = null;
        type = type === undefined ? "" : type;

        if(controller === "root"){
             path = controller;
        }else{
             path = controller + "/" + action;
        }

        for(var item in routeList){
            // remove forward slash "/" from string start and end
            var routePath = routeList[item].path.replace(/^\/|\/$/g, '');
            if(routePath === path && routeList[item].type === type){
                return routeList[item];
            }else{
                if(routePath === path && type === ""){
                    return routeList[item];
                 }
                 else{
                    return -1
                 }
            }
        };
        return -1
    };

    // will get the url and hash
    MasterRouter.fn.url = function(isHash){

            isHash = isHash === null ? false : isHash;

            if (isHash === true) {

                var onloadHash = window.location.hash;
                var controller = _getControllerNameFromPath(onloadHash);
                controller = controller === undefined || controller === "" ? "root" : controller;
                var action = _getActionNameFromPath(onloadHash);
                action = action === undefined || action === "" ? "index" : action;

                if (controller != null) {
                    _digestRoute(controller, action);
                } else {
                   throw new Error("Cannot find Controller");
                }

                // this starts listening to url hash changes
                window.onhashchange = function() {
                    var currentHash = window.location.hash;
                    var controller = _getControllerNameFromPath(currentHash);
                    controller = controller === undefined || controller === "" ? "root" : controller;
                    var action = _getActionNameFromPath(currentHash);
                    action = action === undefined || action === "" ? "index" : action;
                    _digestRoute(controller, action);
                };

            } else {
                var onloadPath = window.location.pathname;
                var controller = _getControllerNameFromPath(onloadPath);
                controller = controller === undefined || controller === "" ? "root" : controller;
                var action = _getActionNameFromPath(onloadPath);
                action = action === undefined || action === "" ? "index" : action;
                _digestRoute(controller, action);
            }
    };

    MasterRouter.fn.nodeserver = function(request, response) {
            // node stuff
            var url = require("url");
            request.requrl = url.parse(request.url, true);

            // test if request is a css file using regular expression
            if (/.(css)$/.test(request.requrl)) {
                
                response.writeHead(200, {
                  'Content-Type': 'text/css'
                });
                
                // get css file
                fileserver.readFile(__dirname + request.requrl, 'utf8', function(err, data) {
                  if (err) throw err;
                  response.write(data, 'utf8');
                  response.end();
                });

            }
            else{
                    var controller = _getControllerNameFromPath(request.requrl.pathname);
                    var action = _getActionNameFromPath(request.requrl.pathname);

                    // call master controller and controller to load page
                    const controllerUrl = "../app/controllers/" + controller + "_controller";
                    // always call the master controller first before any controllers
                    const masterUrl = "../app/controllers/master_controller"; 
                    // call the javascript pages
                    require(masterUrl);
                    require(controllerUrl);

                    _digestRoute(controllerName, actionName, request.method);

                    masterControl.callAction(request.method, router.controller, router.action, options);
            }
    };


    // build json representation of the view page
    MasterRouter.fn.html = function(){

            // should be only one controller per page
            var controllerSelector = window.document.querySelector("[fan-controller]");
            var controllerName = "root";
            // check that we find a controller declaration inside the app declaration
            if (controllerSelector === undefined || controllerSelector === null) {
                controllerSelector = window.document;
            }
            else{
                controllerName = controllerSelector.getAttribute("fan-controller");
            }

            var actionSelector = controllerSelector.querySelector("[fan-action]");
            var actionName = "index";
            var moduleSelector =  controllerSelector.querySelectorAll("[fan-module]");

            if(actionSelector !== null){
                moduleSelector = actionSelector.querySelectorAll("[fan-module]");
                actionName = actionSelector.getAttribute("fan-action");
            }
            _digestRoute(controllerName, actionName);

            for (var m = 0; m < moduleSelector.length; m++) {
                _callModule(moduleSelector[m].getAttribute("fan-module"), actionName, controllerName, moduleSelector[m]);
             }

            return {
                refreshModule:function(actionName, controllerName, scope){
                    if(scope !== null){
                        var moduleScope = scope.querySelector("[fan-module]");
                        var moduleName = moduleScope.getAttribute("fan-module");
                        _call_module(moduleName, actionName, controllerName, moduleScope);
                                
                    }else{
                        throw new Error("Must provide HTML scope to refresh module");
                    }
                }
            }

    };


    if ( typeof define === "function" && define.amd ) {
        define( "masterrouter", [], function() {
            return MasterRouter;
        });
    }

    var _MasterRouter = window.MasterRouter;


    MasterRouter.noConflict = function( deep ) {

        if ( deep && window.MasterRouterr === MasterRouter ) {
            window.MasterRouter = _MasterRouter;
        }

        return MasterRouter;
    };

    if ( !noGlobal ) {
        window.MasterRouter = MasterRouter;
    };

    return MasterRouter;

});

/********************************************************************************************************************************/
/************************************************ FRAMEWORK EXAMPLES *********************************************/
/********************************************************************************************************************************/
// *********  Framework will only call 1 controller and 1 action per page. Can call unlimited modules
// *********  Action Name will defualt to "index" if non is provided
// *********  Controller Name will default to "root"
// *********  Must declare at lease one route for the root url
// *********  You can delare a route without a method type like get
// *********  This version is compatible with Node.js

// declare application
// MasterRouter.(MasterControlFunction, function(){ // CallBack Function });

// declare routes
// MasterRouter.route("root", "/home/index", "get");


/********************************************************************************************************************************/
/************************************************ HTML ROUTING EXPLAINED *********************************************/
/********************************************************************************************************************************/

// RULES:
// Only one controller per page
// Only one action per page
// unlimited modules per page
// every page must have a controller and an action

// SYNTEX:
/*
<body fan-controller="drake">
    <div fan-action="index">
        <div fan-module="content">
            The content of the document......
        </div>
    </div>
</body>

*/

// ROUTING IN HTML:
// Declare Controller in HTML
    // fan-controller="controllerName"
// Declare Action in HTML
    // fan-action="actionName"
// Declare Module in HTML 
    // fan-module-"moduleName"


/********************************************************************************************************************************/
/************************************************ URL ROUTING EXAMPLES *********************************************/
/********************************************************************************************************************************/
// *********  We are using window.location to get url
// *********  We are using window.onhashchange to listen for hash changes

// URL SYNTEX:
    // myapp.com/controllerName/actionName

// URL HASHING:
    // TO USE URL HASHING MUST SET URL TO TRUE
            //MasterRouter().url(true);

    // SYTEX HASH ROUTING
        // #/controllerName/ActionName
