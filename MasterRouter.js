// version 0.0.247

var master = require('./MasterControl');
var toolClass =  require('./MasterTools');
const EventEmitter = require("events");
var currentRoute = {};
var tools = new toolClass();

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
    try{
            if(routeList.length > 0){
                // loop through routes
                for(var item in routeList){

                    requestObject.toController = routeList[item].toController;
                    requestObject.toAction = routeList[item].toAction;
                    var pathObj = normalizePaths(requestObject.pathName, routeList[item].path, requestObject.params);
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

                    if(pathObj.requestPath === pathObj.routePath && "options" ===requestObject.type.toLowerCase()){
                        // this means that the request is correct but its an options request means its the browser checking to see if the request is allowed
                        requestObject.response.writeHead(200, {'Content-Type': 'application/json'});
			            requestObject.response.end(JSON.stringify({"done": "true"}));
                        return true;
                    }
                   
                };
                return -1;
            }
            else{
                master.error.log(`route list is not an array`, "Error");
                return -1;
            }
        }
        catch(e){
            throw new Error("Error processing routes: " + e.stack); 
        }
};

var loadScopedListClasses = function(){
    for (var key in master._scopedList) {
        var className =  master._scopedList[key];
        master.requestList[key] = new className();
    };
};


class MasterRouter {
    currentRouteName = null
    _routes = {}
    
    start(){
        var $that = this;
        return {
            route : function(path, toPath, type, constraint){ // function to add to list of routes
                
                var pathList = toPath.replace(/^\/|\/$/g, '').split("#");
                
                var route = {
                    type: type.toLowerCase(),
                    path: path.replace(/^\/|\/$/g, '').toLowerCase(),
                    toController :pathList[0].replace(/^\/|\/$/g, ''),
                    toAction: pathList[1],
                    constraint : constraint
                };
        
                $that._routes[$that.currentRouteName].routes.push(route);   
        
            },
        
            resources: function(routeName){ // function to add to list of routes using resources bulk
        

                $that._routes[$that.currentRouteName].routes.push({
                        type: "get",
                        path: routeName.toLowerCase(),
                        toController :routeName,
                        toAction: "index",
                        constraint : null
                    });
        
                    $that._routes[$that.currentRouteName].routes.push({
                        type: "get",
                        path: routeName.toLowerCase(),
                        toController :routeName,
                        toAction: "new",
                        constraint : null
                    });
        
                    $that._routes[$that.currentRouteName].routes.push({
                        type: "post",
                        path: routeName.toLowerCase(),
                        toController :routeName,
                        toAction: "create",
                        constraint : null
                    });
        
                    $that._routes[$that.currentRouteName].routes.push({
                        // pages/3
                        type: "get",
                        path: routeName.toLowerCase() + "/:id",
                        toController :routeName,
                        toAction: "show",
                        constraint : null
                    });
        
                    $that._routes[$that.currentRouteName].routes.push({
                        type: "get",
                        path: routeName.toLowerCase() + "/:id/" + "edit",
                        toController :routeName,
                        toAction: "edit",
                        constraint : null    
                    });
        
                    $that._routes[$that.currentRouteName].routes.push({
                        type: "put",
                        path: routeName.toLowerCase() + "/:id",
                        toController :routeName,
                        toAction: "update",
                        constraint : null
                    });
        
                    $that._routes[$that.currentRouteName].routes.push({
                        type: "delete",
                        path: routeName.toLowerCase() + "/:id",
                        toController :routeName,
                        toAction: "destroy",
                        constraint : null
                    });   
            }
        }
    }

    loadRoutes(mimeList){
        this.init(mimeList);
    }

    addMimeList(mimeList){
        this._addMimeList(mimeList);
    }

    setup(route){
        this.currentRouteName = tools.makeWordId(4);
        
        if(this._routes[this.currentRouteName] === undefined){
            this._routes[this.currentRouteName] = {
                root : route.root,
                isComponent : route.isComponent,
                routes : []
            };
        }
    }

    get currentRoute(){
        return currentRoute;
    }

    set currentRoute(data){
        currentRoute = data;
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

         tools.combineObjects(master.requestList, requestObject);
         requestObject = master.requestList;
         var Control = require(`${currentRoute.root}/app/controllers/${tools.firstLetterlowercase(requestObject.toController)}Controller`);
         if(Control === null){
            Control = require(`${currentRoute.root}/app/controllers/${tools.firstLetterUppercase(requestObject.toController)}Controller`);
            if(Control === null){
                console.log(`Cannot find controller name - ${requestObject.toController}`);
            }
         }
         tools.combineObjectPrototype(Control, master.controllerList);
         Control.prototype.__namespace = Control.name;
         Control.prototype.__requestObject = requestObject;
         Control.prototype.__currentRoute = currentRoute;
         Control.prototype.__response = requestObject.response;
         Control.prototype.__request = requestObject.request;
         var control = new Control(requestObject);
         var _callEmit = new EventEmitter();
         
         _callEmit.on("controller", function(){
            control.next = function(){
                control.__callAfterAction(control, requestObject);
            }
            // 
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

            loadScopedListClasses();
            var $that = this;
            var requestObject = Object.create(rr);
            requestObject.pathName = requestObject.pathName.replace(/^\/|\/$/g, '').toLowerCase();
        
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

master.extend("router", MasterRouter);
