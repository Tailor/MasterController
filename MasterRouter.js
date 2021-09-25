

// version 1.0.16

var master = require('./MasterControl');
var tools =  require('./MasterTools');
const EventEmitter = require("events");
var currentRoute = {};
const path = require('path')

 var normalizePaths = function(requestPath, routePath, requestParams){
    var obj = {
        requestPath : "",
        routePath : ""
    }

    var requestPathList = requestPath.split("/");
    var routePathList = routePath.split("/");

    for(i = 0; i < requestPathList.length; i++){
        requestItem = requestPathList[i];
        routeItem = routePathList[i];
        if(routeItem){
            if(routeItem.indexOf(":") > -1){
                requestParams[routeItem.replace(":", "")] = requestItem;
                routePathList[i] = requestItem;
            }
        }
    }

    obj.requestPath = requestPath;
    obj.routePath = routePathList.join("/");
    return obj;
 }

 var processRoutes = function(requestObject, emitter, routeObject){
    var routeList = routeObject.routes;
    var root = routeObject.root;
    var isComponent = routeObject.isComponent;

    if(routeList.length > 0){
        // loop through routes
        for(var item in routeList){

            requestObject.toController = routeList[item].toController;
            requestObject.toAction = routeList[item].toAction;
            var pathObj = normalizePaths(requestObject.pathName, routeList[item].path, requestObject.params)
            // if we find the route that matches the request
            if(pathObj.requestPath === pathObj.routePath && routeList[item].type === requestObject.type){

                // call Constraint
                if(typeof routeList[item].constraint === "function"){
                    
                    var newObj = {};
                    //tools.combineObjects(newObj, master.controllerList);
                    newObj.next = function(){
                        currentRoute.root = root;
                        currentRoute.pathName = requestObject.pathName;
                        currentRoute.toAction = requestObject.toAction;
                        currentRoute.toController = requestObject.toController;
                        currentRoute.response = requestObject.response;
                        currentRoute.isComponent = isComponent;
                        emitter.emit("routeConstraintGood", requestObject);
                    };
                    routeList[item].constraint.call(newObj, requestObject);
                    return true;
                }else{

                    currentRoute.root = root;
                    currentRoute.pathName = requestObject.pathName;
                    currentRoute.toAction = requestObject.toAction;
                    currentRoute.toController = requestObject.toController;
                    currentRoute.response = requestObject.response;
                    currentRoute.isComponent = isComponent;
                    emitter.emit("routeConstraintGood", requestObject);
                    return true;
                }
                
            }
        };
        return -1;
    }
    else{
        master.error.log(`route list is not an array`, "Error");
        return -1;
    }
};

class MasterRouter {
    currentRouteName = null
    _routes = {}
    __rootLocation = "";

    loadRoutes(mimeList){
        this.init(mimeList);
    }

    addMimeList(mimeList){
        this._addMimeList(mimeList);
    }

    init(root){
        var rootPath = path.join(root, '../');
        this.__rootLocation = rootPath;
        require( rootPath + "/routes");
    }

    start(){
        var $that = this;
        var rootLocation = path.join(this.__rootLocation, '../');
        var componentExist = false;
        if(rootLocation.includes("components")){
            componentExist = true;
        }
        this.currentRouteName = tools.makeWordId(4);
        
        if(this._routes[this.currentRouteName] === undefined){
            this._routes[this.currentRouteName] = {
                root : rootLocation,
                isComponent : componentExist,
                routes : []
            };
        }
        return {
            route : function(path, toPath, type, constraint){ // function to add to list of routes
                
                var pathList = toPath.replace(/^\/|\/$/g, '').split("#");
                
                var route = {
                    type: type.toLowerCase(),
                    path: path.replace(/^\/|\/$/g, ''),
                    toController :pathList[0].replace(/^\/|\/$/g, ''),
                    toAction: pathList[1],
                    constraint : constraint
                };
        
                $that._routes[$that.currentRouteName].routes.push(route);   
        
            },
        
            resources: function(routeName){ // function to add to list of routes using resources bulk
        
                    
                $that._routes[$that.currentRouteName].routes.push({
                        type: "get",
                        path: routeName,
                        toController :routeName,
                        toAction: "index",
                        constraint : null
                    });
        
                    $that._routes[$that.currentRouteName].routes.push({
                        type: "get",
                        path: routeName,
                        toController :routeName,
                        toAction: "new",
                        constraint : null
                    });
        
                    $that._routes[$that.currentRouteName].routes.push({
                        type: "post",
                        path: routeName,
                        toController :routeName,
                        toAction: "create",
                        constraint : null
                    });
        
                    $that._routes[$that.currentRouteName].routes.push({
                        // pages/3
                        type: "get",
                        path: routeName + "/:id",
                        toController :routeName,
                        toAction: "show",
                        constraint : null
                    });
        
                    $that._routes[$that.currentRouteName].routes.push({
                        type: "get",
                        path: routeName + "/:id/" + "edit",
                        toController :routeName,
                        toAction: "edit",
                        constraint : null    
                    });
        
                    $that._routes[$that.currentRouteName].routes.push({
                        type: "put",
                        path: routeName + "/:id",
                        toController :routeName,
                        toAction: "update",
                        constraint : null
                    });
        
                    $that._routes[$that.currentRouteName].routes.push({
                        type: "delete",
                        path: routeName + "/:id",
                        toController :routeName,
                        toAction: "destroy",
                        constraint : null
                    });   
            }
        }
    }

    get currentRoute(){
        return currentRoute;
    }

    _addMimeList(mimeObject){
        var that = this;
        if(mimeObject){
            that.mimeTypes = mimeObject;
        }
    }

    findMimeType(fileExt){
        if(fileExt){
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

         tools.combineObjects(requestObject, master.requestList);
         var Control = require(`${currentRoute.root}/app/controllers/${tools.firstLetterlowercase(requestObject.toController)}Controller`);
         tools.combineObjectPrototype(Control, master.controllerList);
         Control.prototype.__namespace = Control.name;
         var control = new Control(requestObject);
         var _callEmit = new EventEmitter();
         
         _callEmit.on("controller", function(){
            control.next = function(){
                control.__callAfterAction(control, requestObject);
            }
            control[requestObject.toAction](requestObject);
         });
        
         // check if before function is avaliable and wait for it to return
         if(control.__hasBeforeAction(control, requestObject)){
             control.__callBeforeAction(control, requestObject, _callEmit);
         }else{
            _callEmit.emit("controller");
         }

    }
    
    load(rr){ // load the the router
            var $that = this;
            var requestObject = Object.create(rr);
            requestObject.pathName = requestObject.pathName.replace(/^\/|\/$/g, '');
        
            var _loadEmit = new EventEmitter();
            
            _loadEmit.on("routeConstraintGood", function(requestObj){
                    $that._call(requestObj);
            });
        
            var routeFound = false;
            const routes = Object.keys(this._routes);
            for (const route of routes) {
               var result = processRoutes(requestObject, _loadEmit, this._routes[route] );
               if(result === true){
                    routeFound = true;
                    break;
               }
            }

            if(routeFound === false){
                master.error.log(`Cannot find route for path ${requestObject.pathName}`, "warn");
                master.error.callHttpStatus(404, requestObject.response);
            }            

    }
    
}

master.extend({router :  new MasterRouter()});
