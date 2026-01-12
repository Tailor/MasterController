// version 0.0.250

var toolClass =  require('./MasterTools');
const EventEmitter = require("events");
var path = require('path');
var currentRoute = {};
var tools = new toolClass();

// Enhanced error handling
const { handleRoutingError, handleControllerError, sendErrorResponse } = require('./error/MasterBackendErrorHandler');
const { logger } = require('./error/MasterErrorLogger');
const { performanceTracker, errorHandlerMiddleware } = require('./error/MasterErrorMiddleware');

// Security - Input validation and sanitization
const { validator, detectPathTraversal, detectSQLInjection, detectCommandInjection } = require('./security/MasterValidator');
const { escapeHTML } = require('./security/MasterSanitizer');

const isDevelopment = process.env.NODE_ENV !== 'production' && process.env.master === 'development';

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
                const paramName = routeItem.replace(":", "");
                const paramValue = requestItem;

                // Security: Sanitize route parameter
                const sanitizedValue = sanitizeRouteParam(paramName, paramValue);

                requestParams[paramName] = sanitizedValue;
                routePathList[i] = sanitizedValue;
            }
        }
    }

    obj.requestPath = requestPath;
    obj.routePath = routePathList.join("/");
    return obj;
 }

 /**
  * Sanitize route parameter to prevent injection attacks
  */
 var sanitizeRouteParam = function(paramName, paramValue) {
    if (!paramValue || typeof paramValue !== 'string') {
        return paramValue;
    }

    // Check for path traversal attempts
    const pathCheck = detectPathTraversal(paramValue);
    if (!pathCheck.safe) {
        logger.warn({
            code: 'MC_SECURITY_PATH_TRAVERSAL',
            message: 'Path traversal attempt detected in route parameter',
            param: paramName,
            value: paramValue
        });

        // Remove dangerous content
        return paramValue.replace(/\.\./g, '').replace(/\.\//g, '');
    }

    // Check for SQL injection attempts
    const sqlCheck = detectSQLInjection(paramValue);
    if (!sqlCheck.safe) {
        logger.warn({
            code: 'MC_SECURITY_SQL_INJECTION',
            message: 'SQL injection attempt detected in route parameter',
            param: paramName,
            value: paramValue
        });

        // Escape to prevent injection
        return escapeHTML(paramValue);
    }

    // Check for command injection attempts
    const cmdCheck = detectCommandInjection(paramValue);
    if (!cmdCheck.safe) {
        logger.warn({
            code: 'MC_SECURITY_COMMAND_INJECTION',
            message: 'Command injection attempt detected in route parameter',
            param: paramName,
            value: paramValue
        });

        // Remove dangerous characters
        return paramValue.replace(/[;&|`$()]/g, '');
    }

    // Basic sanitization for all params
    return escapeHTML(paramValue);
 }

 var processRoutes = function(requestObject, emitter, routeObject){
    var routeList = routeObject.routes;
    var root = routeObject.root;
    var isComponent = routeObject.isComponent;
    var currentRouteBeingProcessed = null; // Track current route for better error messages

    try{
            // Ensure routes is an array
            if(!Array.isArray(routeList)){
                master.error.log(`route list is not an array`, "error");
                return -1;
            }

            // No routes registered for this scope; skip silently
            if(routeList.length === 0){
                return -1;
            }

            if(routeList.length > 0){
                // loop through routes
                for(var item in routeList){
                    // Store current route for error handling
                    currentRouteBeingProcessed = {
                        path: routeList[item].path,
                        toController: routeList[item].toController,
                        toAction: routeList[item].toAction,
                        type: routeList[item].type
                    };

                    try {
                        requestObject.toController = routeList[item].toController;
                        requestObject.toAction = routeList[item].toAction;

                        // FIX: Create a clean copy of params for each route test to prevent parameter pollution
                        // This prevents parameters from non-matching routes from accumulating in requestObject.params
                        var testParams = Object.assign({}, requestObject.params);
                        var pathObj = normalizePaths(requestObject.pathName, routeList[item].path, testParams);

                        // if we find the route that matches the request
                        if(pathObj.requestPath === pathObj.routePath && routeList[item].type === requestObject.type){
                            // Only commit the extracted params if this route actually matches
                            requestObject.params = testParams;

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
                                    currentRoute.routeDef = currentRouteBeingProcessed; // Add route definition
                                    emitter.emit("routeConstraintGood", requestObject);
                                };

                                // Wrap constraint execution with error handling
                                try {
                                    routeList[item].constraint.call(newObj, requestObject);
                                } catch(constraintError) {
                                    const routeError = handleRoutingError(
                                        requestObject.pathName,
                                        [],
                                        {
                                            type: 'CONSTRAINT_ERROR',
                                            route: currentRouteBeingProcessed,
                                            error: constraintError
                                        }
                                    );
                                    logger.error({
                                        code: 'MC_ERR_ROUTE_CONSTRAINT',
                                        message: `Route constraint failed for ${currentRouteBeingProcessed.path}`,
                                        route: currentRouteBeingProcessed,
                                        error: constraintError.message,
                                        stack: constraintError.stack
                                    });
                                    throw constraintError;
                                }

                                return true;
                            }else{

                                currentRoute.root = root;
                                currentRoute.pathName = requestObject.pathName;
                                currentRoute.toAction = requestObject.toAction;
                                currentRoute.toController = requestObject.toController;
                                currentRoute.response = requestObject.response;
                                currentRoute.isComponent = isComponent;
                                currentRoute.routeDef = currentRouteBeingProcessed; // Add route definition
                                emitter.emit("routeConstraintGood", requestObject);
                                return true;
                            }

                        }

                        if(pathObj.requestPath === pathObj.routePath && "options" ===requestObject.type.toLowerCase()){
                            // this means that the request is correct but its an options request means its the browser checking to see if the request is allowed
                            // Commit the params for OPTIONS requests too
                            requestObject.params = testParams;
                            requestObject.response.writeHead(200, {'Content-Type': 'application/json'});
                            requestObject.response.end(JSON.stringify({"done": "true"}));
                            return true;
                        }
                    } catch(routeProcessError) {
                        // Log the specific route that failed
                        logger.error({
                            code: 'MC_ERR_ROUTE_PROCESS',
                            message: `Failed to process route: ${currentRouteBeingProcessed.path}`,
                            route: currentRouteBeingProcessed,
                            requestPath: requestObject.pathName,
                            error: routeProcessError.message,
                            stack: routeProcessError.stack
                        });

                        // Re-throw to be caught by outer try-catch
                        throw routeProcessError;
                    }

                };
                return -1;
            }
        }
        catch(e){
            // Enhanced error message with route context
            const errorDetails = currentRouteBeingProcessed
                ? `\n\nFailing Route:\n  Path: ${currentRouteBeingProcessed.path}\n  Controller: ${currentRouteBeingProcessed.toController}#${currentRouteBeingProcessed.toAction}\n  Method: ${currentRouteBeingProcessed.type.toUpperCase()}\n\nRequest:\n  Path: ${requestObject.pathName}\n  Method: ${requestObject.type.toUpperCase()}`
                : '';

            throw new Error(`Error processing routes: ${e.message}${errorDetails}\n\nOriginal Stack:\n${e.stack}`);
        }
};

var loadScopedListClasses = function(){
    for (var key in master._scopedList) {
        var className =  master._scopedList[key];
        master.requestList[key] = new className();
    };
};


/**
 * Normalize route path: lowercase segments but preserve param names
 *
 * @param {String} path - Route path like "/Period/:periodId/Items/:itemId"
 * @returns {String} - Normalized: "period/:periodId/items/:itemId"
 */
function normalizeRoutePath(path) {
    const trimmed = path.replace(/^\/|\/$/g, '');
    const segments = trimmed.split('/');

    const normalized = segments.map(segment => {
        // Preserve parameter names (start with :)
        if (segment.startsWith(':')) {
            return segment;
        }
        // Lowercase path segments
        return segment.toLowerCase();
    });

    return normalized.join('/');
}

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
                    path: normalizeRoutePath(path),
                    toController :pathList[0].replace(/^\/|\/$/g, ''),
                    toAction: pathList[1],
                    constraint : constraint
                };

                $that._routes[$that.currentRouteName].routes.push(route);

            },
        
            resources: function(routeName){ // function to add to list of routes using resources bulk


                $that._routes[$that.currentRouteName].routes.push({
                        type: "get",
                        path: normalizeRoutePath(routeName),
                        toController :routeName,
                        toAction: "index",
                        constraint : null
                    });

                    $that._routes[$that.currentRouteName].routes.push({
                        type: "get",
                        path: normalizeRoutePath(routeName),
                        toController :routeName,
                        toAction: "new",
                        constraint : null
                    });

                    $that._routes[$that.currentRouteName].routes.push({
                        type: "post",
                        path: normalizeRoutePath(routeName),
                        toController :routeName,
                        toAction: "create",
                        constraint : null
                    });

                    $that._routes[$that.currentRouteName].routes.push({
                        // pages/3
                        type: "get",
                        path: normalizeRoutePath(routeName + "/:id"),
                        toController :routeName,
                        toAction: "show",
                        constraint : null
                    });

                    $that._routes[$that.currentRouteName].routes.push({
                        type: "get",
                        path: normalizeRoutePath(routeName + "/:id/edit"),
                        toController :routeName,
                        toAction: "edit",
                        constraint : null
                    });

                    $that._routes[$that.currentRouteName].routes.push({
                        type: "put",
                        path: normalizeRoutePath(routeName + "/:id"),
                        toController :routeName,
                        toAction: "update",
                        constraint : null
                    });

                    $that._routes[$that.currentRouteName].routes.push({
                        type: "delete",
                        path: normalizeRoutePath(routeName + "/:id"),
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

         // Start performance tracking
         const requestId = `${Date.now()}-${Math.random()}`;
         performanceTracker.start(requestId, requestObject);

         tools.combineObjects(master.requestList, requestObject);
         requestObject = master.requestList;
         var Control = null;

         try{
             // Try to load controller
             try{
                 Control = require(path.join(currentRoute.root, 'app', 'controllers', `${tools.firstLetterlowercase(requestObject.toController)}Controller`));
             }catch(e){
                 try{
                     Control = require(path.join(currentRoute.root, 'app', 'controllers', `${tools.firstLetterUppercase(requestObject.toController)}Controller`));
                 }catch(e2){
                     // Controller not found - handle error
                     const error = handleControllerError(
                         new Error(`Controller not found: ${requestObject.toController}Controller`),
                         requestObject.toController,
                         requestObject.toAction,
                         requestObject.pathName,
                         currentRoute.routeDef // Pass route definition
                     );

                     sendErrorResponse(requestObject.response, error, requestObject.pathName);
                     performanceTracker.end(requestId);
                     return;
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
                try {
                    control.next = function(){
                        control.__callAfterAction(control, requestObject);
                    }

                    // Check if action exists
                    if (typeof control[requestObject.toAction] !== 'function') {
                        throw new Error(`Action '${requestObject.toAction}' not found in controller ${requestObject.toController}`);
                    }

                    // Wrap action with error handling
                    const wrappedAction = errorHandlerMiddleware(
                        control[requestObject.toAction],
                        requestObject.toController,
                        requestObject.toAction
                    );

                    // Execute action
                    Promise.resolve(wrappedAction.call(control, requestObject))
                        .then(() => {
                            performanceTracker.end(requestId);
                        })
                        .catch((error) => {
                            const mcError = handleControllerError(
                                error,
                                requestObject.toController,
                                requestObject.toAction,
                                requestObject.pathName,
                                currentRoute.routeDef // Pass route definition
                            );
                            sendErrorResponse(requestObject.response, mcError, requestObject.pathName);
                            performanceTracker.end(requestId);
                        });

                } catch (error) {
                    // Action execution error
                    const mcError = handleControllerError(
                        error,
                        requestObject.toController,
                        requestObject.toAction,
                        requestObject.pathName,
                        currentRoute.routeDef // Pass route definition
                    );
                    sendErrorResponse(requestObject.response, mcError, requestObject.pathName);
                    performanceTracker.end(requestId);
                }
             });

             // check if before function is avaliable and wait for it to return
             if(control.__hasBeforeAction(control, requestObject)){
                 control.__callBeforeAction(control, requestObject, _callEmit);
             }else{
                _callEmit.emit("controller");
             }

         } catch (error) {
             // General error
             const mcError = handleControllerError(
                 error,
                 requestObject.toController,
                 requestObject.toAction,
                 requestObject.pathName,
                 currentRoute.routeDef // Pass route definition
             );
             sendErrorResponse(requestObject.response, mcError, requestObject.pathName);
             performanceTracker.end(requestId);
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
                // Enhanced 404 handling
                const allRoutes = [];
                for (const route of routes) {
                    if (this._routes[route] && this._routes[route].routes) {
                        allRoutes.push(...this._routes[route].routes);
                    }
                }

                const mcError = handleRoutingError(requestObject.pathName, allRoutes);
                sendErrorResponse(requestObject.response, mcError, requestObject.pathName);
            }            

    }
    
}

module.exports = { MasterRouter };
