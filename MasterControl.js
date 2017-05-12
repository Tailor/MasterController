// MasterControl - by Alexander Batista - Tailer 2017 - MIT Licensed 
// version 1.2 - beta -- node compatiable


( function( global, factory ) {

    "use strict";

    if ( typeof module === "object" && typeof module.exports === "object" ) {
        module.exports = factory( global );
    } else {
        factory( global );
    }

// Pass this if window is not defined yet
} )( typeof window !== "undefined" ? window : this, function( window, noGlobal ) {

    var $$controllerList = [];
    var $$actionList = [];
    var $$moduleList = [];
    var $$currentControllerName;
    var $$currentActionName;
    var $$routeList =[];

    var _call_controller = function (controllerName, scope) {
            $$currentControllerName = controllerName;

            if(controllerName){

                   var counter = 0;

                    // loop through all the controller that were loaded 
                    if ($$controllerList.length > 0) {
                        // call an anonymous function that has object
                        $$controllerList.forEach(function (callback) {
                            // only call the ones that we find in the DOM
                            if (callback.controllerName === controllerName) {
                                counter++;
                                callback.aFunction(scope);
                            }
                        });

                        // if couter is 0 then it did not find controller for attribute
                        if (counter === 0) {
                            throw new Error( "Error could not find controller with name " + controllerName);
                        }

                        return null
                    }
                    else {
                        throw new Error( "Error could not find any controller");
                    }
                }
    };

    var _call_action = function (actionName, controllerName, scope) {

            $$currentActionName =  actionName;
            
            if(actionName && controllerName){

                var counter = false;

                // loop through all the actions that were loaded
                if ($$actionList.length > 0) {

                    for(var b = 0; $$actionList.length > b; b++){

                        var actionNameLowercase = $$actionList[b].actionName.toLowerCase();
                        var controllerNameLowercase = $$actionList[b].controllerName.toLowerCase();
                            

                        var actionName = actionName.toLowerCase();
                        var controllerName = controllerName.toLowerCase();

                        if(actionNameLowercase === actionName){

                            if (actionNameLowercase === actionName && controllerNameLowercase == controllerName) {
                                $$actionList[b].aFunction(scope);
                                counter = true;
                            }
                            else{
                                throw new Error( "cannot find action " + actionNameLowercase );
                            }
                        }

                    }

                    // if couter is 0 then it did not find controller for attribute
                    if (counter === false) {
                        throw new Error( "Error could not find action with name " + actionName);
                    }

                    return null
                }
                else {
                    throw new Error( "Error could not find any action");
                }
            }
    };

    var _call_module = function (moduleName, actionName, controllerName, scope) {

            if(controllerName && actionName && moduleName){

                var counter = 0;

                // loop through all the actions that were loaded 
                if ($$moduleList.length > 0) {

                    for(var m = 0; $$moduleList.length > m; m++){

                        var actionNameLowercase = $$moduleList[m].actionName.toLowerCase();
                        var moduleNameLowercase = $$moduleList[m].moduleName.toLowerCase();
                        var controllerNameLowercase = $$moduleList[m].controllerName.toLowerCase();

                        var actionName = actionName.toLowerCase();
                         var moduleName = moduleName.toLowerCase();
                        var controllerName = controllerName.toLowerCase();

                        if(moduleNameLowercase === moduleName){
                            // only call the ones that we find in the DOM
                            if (actionNameLowercase === actionName && controllerNameLowercase == controllerName) {
                                counter++;
                                $$moduleList[m].aFunction(scope);
                            }
                        }

                    }

                    // if couter is 0 then it did not find controller for attribute
                    if (counter === 0) {
                        throw new Error( "Error could not find module with name " + moduleName);
                    }

                    return null
                }
                else {
                    throw new Error( "Error could not find any module");
                }
            }

    };

    var MasterController = function() {

        return MasterController.fn;
    };

    // return only the api that we want to use
    MasterController.fn = MasterController.prototype = {

            // call controller using name
            callController : function(controllerName, scope){
                var returnController = _call_controller(controllerName, scope);
                return returnController;
            },

            // call action using name
            callAction : function(actionName, controllerName, scope){

                var returnAction = _call_action(actionName, controllerName, scope);
                return returnAction;
            },


            // call action using name
            callModule : function( moduleName, actionName, controllerName, scope){

                var returnModule = _call_module(moduleName, actionName, controllerName, scope);
                return returnModule;
            },

            // this gets called by the declairation of the function on the page
            controller : function (controllerName, aFunction) {
                // this will push an object into array
                var objectController = {
                    controllerName: controllerName,
                    aFunction: aFunction
                };

                $$controllerList.push(objectController);
                return this;
            },

            // this gets called by the declairation of the function on the page
            action : function (actionName, controllerName,  aFunction) {

                // this will push an object into array
                var objectAction = {
                    controllerName: controllerName,
                    actionName: actionName,
                    aFunction: aFunction
                };

                $$actionList.push(objectAction);
                return this;
            },

            // this gets called by the declairation of the function on the page
            module : function (moduleName, actionName, controllerName, aFunction) {
                // this will push an object into array
                var objectModule = {
                    controllerName: controllerName,
                    actionName: actionName,
                    moduleName: moduleName,
                    aFunction: aFunction
                };

                $$moduleList.push(objectModule);
                return this;
            }


    };

    // *****************************************************************************************************************************************
    // **********************************************************  Extend MasterController  ****************************************************
    // *****************************************************************************************************************************************


    MasterController.fn.MasterRouter = function(callBack) {
        if(callBack !== undefined){
            callBack();
        }

        return {
            route : function( path, toPath, type){

                var route = {
                    type: type,
                    path: path,
                    toPath :toPath
                }

                $$routeList.push(route);
                return MasterController.fn.MasterRouter.fn
            }
        }
    };

    MasterController.fn.MasterRouter.fn = {};

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

    // at this point have the path, controler, and action names
    var _digestRoute = function(controller, action, type) {
        
        // find route accociated with controller and action
        var route = _findRoute(controller, action, type);
        if(route < 0){
                // TODO: if no routes found then just call regular routes and default to get
                _call_controller(controller);
                _call_action(action, controller);
                return {
                    controller :controller,
                    action : action
                }
            }

        else{
            // TODO if route is found then use route to call controller
            var routeController = _getControllerNameFromPath(route.toPath);
            var routeAction = _getActionNameFromPath(route.toPath);
            routeAction = routeAction === undefined || routeAction === "" ? "index" : routeAction;
            _call_controller(routeController);
            _call_action(routeAction, routeController);
            return {
                controller :routeController,
                action : routeAction
            }
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

        for(var item in $$routeList){
            // remove forward slash "/" from string start and end
            var routePath = $$routeList[item].path.replace(/^\/|\/$/g, '');
            if(routePath === path && $$routeList[item].type === type){
                return $$routeList[item];
            }else{
                if(routePath === path && type === ""){
                    return $$routeList[item];
                 }
                 else{
                    return -1
                 }
            }
        };
        return -1
    };

    // will get the url and hash
    MasterController.fn.MasterRouter.fn.url = function(isHash){

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

    MasterController.fn.MasterRouter.fn.nodeserver = function(request, response) {
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
    MasterController.fn.MasterRouter.fn.html = function(){

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
            var newRoute = _digestRoute(controllerName, actionName);
            for (var m = 0; m < moduleSelector.length; m++) {
                _call_module(moduleSelector[m].getAttribute("fan-module"), newRoute.action, newRoute.controller, moduleSelector[m]);
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
        define( "mastercontroller", [], function() {
            return MasterController;
        });
    }

    var _MasterController = window.MasterController;


    MasterController.noConflict = function( deep ) {

        if ( deep && window.MasterController === MasterController ) {
            window.MasterController = _MasterController;
        }

        return MasterController;
    };

    if ( !noGlobal ) {
        window.MasterController = MasterController;
    };


    return MasterController;

});



/********************************************************************************************************************************/
/************************************************ DOCUMENTATION FOR MASTER CONTROL **********************************************/
/********************************************************************************************************************************/

// Start:
// var app = MasterController();

// declare a Controller
// EXAMPLE:
// app.controller('ControllerName', function (action, scope) {});

// declare a Action -- add type like get or post
// EXAMPLE:
// app.action('actionName', 'controllerName', function (scope) {});

// declare a Module
// EXAMPLE:
// app.module( 'moduleName', 'actionName', 'controllerName', function (scope) {});

// calling any controller at anytime using the name
// EXAMPLE:
// app.callController(controllerName, scope);

// calling any action at anytime using the action name and controller name
// EXAMPLE:
// app.callAction(actionName, controllerName, scope);

// calling any module at anytime using the module name and action name and controller name
// EXAMPLE:
// app.callModule( moduleName,  actionName, controllerName, scope);


/********************************************************************************************************************************/
/************************************************ ROUTING EXAMPLES *********************************************/
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

    // masterControl.MasterRouter( function(){
    //         console.log("master router call back function being called");
    //     }).route("root", "/drake/").html();

    // masterControl.MasterRouter( function(){
    //         console.log("master router call back function being called");
    //     }).route("root", "/drake/").node();

    // masterControl.MasterRouter( function(){
    //         console.log("master router call back function being called");
    //     }).route("root", "/drake/").url(true);


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
