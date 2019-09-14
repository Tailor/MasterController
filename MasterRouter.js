
// version 1.0.19
var master = require('./MasterControl');
var tools =  master.tools;
var Controller = require('./Controller');
const fs = require("fs");
const EventEmitter = require("events");
var _routeList = []; // list of routes being added Array
var routeFound = false;

 var appendResponseToController = function(requestObj, controller){

    var controller = controller === undefined ? master.error.log("controller not instantiated", "warn") : controller;

    controller.request = requestObj.request;
    controller.response = requestObj.response;
    controller.namespace = requestObj.toController;
    controller.action = requestObj.toAction;
    controller.root = requestObj.root;
    controller.environment = requestObj.environment;
    controller.pathName = requestObj.pathName;
    controller.type = requestObj.type;
    controller.params = requestObj.params;
    return controller;
 };

 var normalizePaths = function(requestPath, routePath, requestParams){
    var obj = {
        requestPath : "",
        routhPath : ""
    }

    var requestPathList = requestPath.split("/");
    var routePathList = routePath.split("/");

    for(i = 0; i < requestPathList.length; i++){
        requestItem = requestPathList[i];
        routeItem = routePathList[i];
        if(routeItem !== undefined){
            if(routeItem.indexOf(":") > -1){
                requestParams[routeItem.replace(":", "")] = requestItem;
                routePathList[i] = requestItem;
            }
        }
    }

    obj.requestPath = requestPath;
    obj.routhPath = routePathList.join("/");
    return obj;
 }

 var processControllerRoute = function(requestObject, emitter){
    routeFound = false;
    // request object needs action, controller, and next functions
    var currentMasterLocation = requestObject.masterFileLocation;

    if(_routeList.length > 0){
        // loop through routes
        for(var item in _routeList){

            requestObject.toController = _routeList[item].toController;
            requestObject.toAction = _routeList[item].toAction;

            // if component then call component and let the componont hande its own routing
            if(_routeList[item].isComponent === true){
                var loadPath = `${master.root}/${_routeList[item].folder}/${_routeList[item].location}`;
                if(fs.existsSync(loadPath)){
                    requestObject.masterRoot = requestObject.root;
                    requestObject.root = loadPath;
                    requestObject.masterFileLocation = `${__dirname}/MasterControl`;
                    // load component file
                    require(loadPath + "/component")(requestObject);
                    requestObject.root = requestObject.masterRoot;
                }

            }
            else{
                    var pathObj = normalizePaths(requestObject.pathName, _routeList[item].path, requestObject.params)
                    // if we find the route that matches the request
                    if(pathObj.requestPath === pathObj.routhPath && _routeList[item].type === requestObject.type){
                        if(currentMasterLocation !== undefined){
                            routeFound = true;
                            var mod = require(currentMasterLocation);
                            mod.router._routeFoundInsideComponent();
                        }

                        // call Constraint
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
                        
                    }
            }
            // if route is found get out of loop no point of keep looping
            if(routeFound === true){
                break;
            }
        };
        // if route hasnt been found then through some error's
        if(routeFound === false && currentMasterLocation === undefined){
            master.error.log(`Cannot find route for path  ${requestObject.pathName}`, "warn");
            master.error.callHttpStatus(404, requestObject.response);
        }
    }
    else{
        emitter.emit("routeConstraintBad");
        return -1;
    }
};

class MasterRouter {
    _routeFoundInsideComponent(){
        routeFound = true;
    }

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

         var Control = require(`${requestObject.root}/app/controllers/${tools.firstLetterlowercase(requestObject.toController)}Controller`);
         master.appendControllerMethodsToClass(Control);
         Control.prototype.__namespace = Control.name;
         var control = new Control();
         var response = appendResponseToController(requestObject, control);
         var _callEmit = new EventEmitter();
         
         _callEmit.on("controller", function(){

            control.next = function(){
                control.__callAfterAction(response);
            }
            control[requestObject.toAction](response);
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
            type: null,
            path: null,
            controller: null,
            action: null,
            constraint : null,
            folder : folder,
            location: name,
            isComponent : true
        };

        _routeList.push(route);  
    }

    route(path, toPath, type, constraint){ // function to add to list of routes
        var pathList = toPath.replace(/^\/|\/$/g, '').split("#");

        var route = {
            type: type.toLowerCase(),
            path: path.replace(/^\/|\/$/g, ''),
            toController :pathList[0],
            toAction: pathList[1],
            constraint : constraint,
            folder : null,
            location: null,
            isComponent : false
        };

        _routeList.push(route);     

    }

    resources(routeName){ // function to add to list of routes using resources bulk

            _routeList.push({
                type: "get",
                path: routeName,
                toController :routeName,
                toAction: "index",
                constraint : null,
                folder : null,
                location: null,
                isComponent : false
            });

            _routeList.push({
                type: "get",
                path: routeName,
                toController :routeName,
                toAction: "new",
                constraint : null,
                folder : null,
                location: null,
                isComponent : false
            });

            _routeList.push({
                type: "post",
                path: routeName,
                toController :routeName,
                toAction: "create",
                constraint : null,
                folder : null,
                location: null,
                isComponent : false
            });

            _routeList.push({
                // pages/3
                type: "get",
                path: routeName + "/:id",
                toController :routeName,
                toAction: "show",
                constraint : null,
                folder : null,
                location: null,
                isComponent : false
            });

            _routeList.push({
                type: "get",
                path: routeName + "/:id/" + "edit",
                toController :routeName,
                toAction: "edit",
                constraint : null,
                folder : null,
                location: null,
                isComponent : false
            });

            _routeList.push({
                type: "put",
                path: routeName + "/:id",
                toController :routeName,
                toAction: "update",
                constraint : null,
                folder : null,
                location: null,
                isComponent : false
            });

            _routeList.push({
                type: "delete",
                path: routeName + "/:id",
                toController :routeName,
                toAction: "destroy",
                constraint : null,
                folder : null,
                location: null,
                isComponent : false
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
