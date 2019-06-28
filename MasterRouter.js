// MasterRouter- by Alexander Batista - Tailer 2017 - MIT Licensed 
// version 1.0.13 - beta -- node compatiable

var master = require('./MasterControl');
var Controller = require('./Controller');
const fs = require("fs");
//master.appendControllerMethodsToClass(Controller);
const EventEmitter = require("events");
var _routeList = []; // list of routes being added Array

 var firstLetterUppercase = function(string){
     return string.charAt(0).toUpperCase() + string.slice(1);
 };

 var firstLetterlowercase = function(string){
    return string.charAt(0).toLowerCase() + string.slice(1);
};

 var appendResponseToController = function(requestObj, controller){

    var controller = controller === undefined ? master.error.log("controller not instantiated", "warn") : controller;

    controller.request = requestObj.request;
    controller.response = requestObj.response;
    controller.namespace = requestObj.namespace;
    controller.action = requestObj.action;
    controller.root = requestObj.root;
    controller.environment = requestObj.environment;
    controller.pathName = requestObj.pathName;
    controller.type = requestObj.type;
    controller.params = requestObj.params;
    return controller;
 };

 var processControllerRoute = function(requestObject, emitter){

    // request object needs action, controller, and next functions
    var params = {};
    var pathList = requestObject.pathName.split("/");

    if(_routeList.length > 0){
        // loop through routes
        for(var item in _routeList){

            var namespace = _routeList[item].toPath[0];
            var action =  _routeList[item].toPath[1] === undefined ? "index" : _routeList[item].toPath[1];

            // set defualt route Action to Index
           // _routeList[item].toPath[1] =  _routeList[item].toPath[1] === undefined ? "index" : _routeList[item].toPath[1];
           
            // if we find the route that matches the request
            if(_routeList[item].path === requestObject.pathName && _routeList[item].type === requestObject.type){
                
                // now we have the controller name and action name
                requestObject.namespace = namespace;
                requestObject.action = action;
                // callConstraint
                // manage constraint method
                if(typeof _routeList[item].constraint === "function"){
                    
                    // need to build request for
                    var newObj = new Controller();
                    var newThis = appendResponseToController(requestObject, newObj);
                    
                    newThis.next = function(){
                        emitter.emit("routeConstraintGood", requestObject);
                    };

                    _routeList[item].constraint.call(newThis, newThis);
                    return true;
                }else{
                    
                    emitter.emit("routeConstraintGood", requestObject);
                    return true;
                }
                
            }else{
                // check if pathParsed has url path = pages/5ff/edit route path = pages/:id/edit
                if(_routeList[item].path.indexOf("/:") > -1 && _routeList[item].type === requestObject.type){
                    var routeArray = _routeList[item].path.split("/");
                    if(routeArray.length > 0){
                        for(var l in routeArray){
                            var routeArrayItem = routeArray[l];
                            if(routeArrayItem.indexOf(":") > -1){
                                var routeName = routeArrayItem.replace(/:/g , '');
                                routeArray[l] = pathList[l];
                                params[routeName] = pathList[l];
                            }
                            var completeRoute = routeArray.join("/");
                            
                            if(requestObject.pathName === completeRoute){

                                requestObject.namespace = namespace;
                                requestObject.action = action;
                                requestObject.params = mergingObjectLiteral(requestObject.params, params);

                                if(typeof _routeList[item].constraint === "function"){
                                     // need to build request for 
                                    
                                    var newObj = new Controller();
                                    var newThis = appendResponseToController( requestObject, newObj);

                                    newThis.next = function(){
                                        emitter.emit("routeConstraintGood", requestObject);
                                    };

                                    _routeList[item].constraint.call(newThis, newThis);
                                    return true;
                                }else{

                                    emitter.emit("routeConstraintGood", requestObject);
                                    return true;
                                }
                            }
                        }
                    }
                }
                else{
                    // check for components
                    if( _routeList[item].isComponent === true){
                        var loadPath = `${master.root}/${_routeList[item].path}/${_routeList[item].toPath[0]}`;
                        if(fs.existsSync(loadPath)){
                            requestObject.masterRoot = requestObject.root;
                            requestObject.root = loadPath;
                            requestObject.component = {
                                isError : false,
                                isComponent : true
                            };
                            // load component file
                            require(loadPath + "/component")(requestObject);
                            requestObject.component.isComponent = false;
                        }
                        
                    }
                    // if it's the last one 
                    if((parseInt(item, 10) + 1) === _routeList.length){
                        if(requestObject.component.isComponent === true){
                            requestObject.component.isError = true;
                            return true;
                        }
                        else{
                            if(requestObject.component.isError === false){
                                return true;
                            }
                            else{
                                var namespaceError = namespace ? namespace:"undefined";
                                var actionError = action ? action : "undefined";
                                master.error.log("Cannot find module namespace:" + namespaceError + " and action:" + actionError, "warn");
                                master.error.callHttpStatus(404, requestObject.response);  
                            }
                        }
                    }
                
                }
            }
        };
    }
    else{
        emitter.emit("routeConstraintBad");
        return -1;
    }
};

class MasterRouter {

    mimes(mimeObject){
        var that = this;
        if(mimeObject.mime !== null && mimeObject.mime !== undefined){
            that.mimeTypes = mimeObject.mime;
        }
    }

    findMimeType(fileExt){
        if(fileExt !== null && fileExt !== undefined && fileExt !== ""){
            var type = undefined;
            var mime = this.mimeTypes;
            for(var i in mime) {

                if("." + i === fileExt){
                    type = mime[i];
                }
            }
            if(type === undefined){
                return false;
            }
            else{
                return type;
            }
        }
        else{
            return false;
        }
    }

    _call(requestObject){

         var Control = require(requestObject.root + "/app/controllers/" + firstLetterlowercase(requestObject.namespace) + "Controller");
         master.appendControllerMethodsToClass(Control);
         Control.prototype.__namespace = Control.name;
         var control = new Control();
         var response = appendResponseToController(requestObject, control);

         var _callEmit = new EventEmitter();
         
         _callEmit.on("controller", function(){

            control.next = function(){
                control.__callAfterAction(response);
            }
            control[response.action](response);
         });
        
         // check if before function is avaliable and wait for it to return
         if(control.__hasBeforeAction(control)){
             control.__callBeforeAction(control, _callEmit);
         }else{
            _callEmit.emit("controller");
         }

    }
    componentRoute(folder, name){
        var route = {
            type: "",
            path: folder,
            toPath : [name],
            constraint : "",
            isComponent : true
        };

        _routeList.push(route);  
    }

    route(path, toPath, type, constraint){ // function to add to list of routes

            var route = {
                type: type.toLowerCase(),
                path: path.replace(/^\/|\/$/g, ''),
                toPath : toPath.replace(/^\/|\/$/g, '').split("/"),
                constraint : constraint,
                isComponent : false
            };

            _routeList.push(route);     

    }

    resources(routeName){ // function to add to list of routes using resources bulk

            var indexRoute = routeName + "/index";
            _routeList.push({
                type: "get",
                path: routeName,
                toPath : indexRoute.split("/")
            });

            var newRoute = routeName + "/new";
            _routeList.push({
                type: "get",
                path: routeName + "/new",
                toPath : newRoute.split("/")
            });

            var createRoute = routeName + "/create";
            _routeList.push({
                type: "post",
                path: routeName,
                toPath : createRoute.split("/")
            });

            var showRoute = routeName + "/show";
            _routeList.push({
                // pages/3
                type: "get",
                path: routeName + "/:id",
                toPath : showRoute.split("/")
            });

            var editRoute = routeName + "/edit";
            _routeList.push({
                type: "get",
                path: routeName + "/:id/" + "edit",
                toPath : editRoute.split("/")
            });

            var updateRoute = routeName + "/update";
            _routeList.push({
                type: "put",
                path: routeName + "/:id",
                toPath : updateRoute.split("/")
            });

            var destroyRoute = routeName + "/destroy";
            _routeList.push({
                type: "delete",
                path: routeName + "/:id",
                toPath : destroyRoute.split("/")
            });   
    }

    load(rr){ // load the the router
            var $that = this;
            var requestObject = Object.create(rr);
            requestObject.pathName = requestObject.pathName.replace(/^\/|\/$/g, '');
        
            var _loadEmit = new EventEmitter();
            
            _loadEmit.on("routeConstraintGood", function(requestObj){
                    $that._call(requestObj);
            });

            _loadEmit.on("routeConstraintBad", function(){
                master.error.log("Cannot find route. Please add correct route to the router.js file", "warn");
                master.error.callHttpStatus(404, requestObject.response);
            });
        
            processControllerRoute(requestObject, _loadEmit);

    }
    
}

master.extend({router : new MasterRouter()});
