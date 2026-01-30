// version 0.0.250

const toolClass =  require('./MasterTools');
const EventEmitter = require("events");
const path = require('path');
// REMOVED: Global currentRoute (race condition bug) - now stored in requestObject
const tools = new toolClass();

// Enhanced error handling
const { handleRoutingError, handleControllerError, sendErrorResponse } = require('./error/MasterBackendErrorHandler');
const { logger } = require('./error/MasterErrorLogger');
const { performanceTracker, errorHandlerMiddleware } = require('./error/MasterErrorMiddleware');

// Security - Input validation and sanitization
const { validator, detectPathTraversal, detectSQLInjection, detectCommandInjection } = require('./security/MasterValidator');
const { escapeHTML } = require('./security/MasterSanitizer');

const isDevelopment = process.env.NODE_ENV !== 'production' && process.env.master === 'development';

// HTTP Status Code Constants
const HTTP_STATUS = {
    OK: 200,
    NO_CONTENT: 204,
    BAD_REQUEST: 400,
    NOT_FOUND: 404,
    INTERNAL_ERROR: 500
};

// Event Names Constants
const EVENT_NAMES = {
    ROUTE_CONSTRAINT_GOOD: 'routeConstraintGood',
    CONTROLLER: 'controller'
};

// HTTP Methods Constants
const HTTP_METHODS = {
    GET: 'get',
    POST: 'post',
    PUT: 'put',
    DELETE: 'delete',
    OPTIONS: 'options'
};

// Router Configuration Constants
const ROUTER_CONFIG = {
    ROUTE_ID_LENGTH: 4,
    DEFAULT_TIMEOUT: 30000, // 30 seconds
    MAX_ROUTE_LENGTH: 2048
};

 /**
  * Normalize and match request path against route path, extracting parameters
  *
  * Compares request path segments with route path segments. When a route segment
  * starts with ":", treats it as a parameter and extracts the corresponding value
  * from the request path.
  *
  * @param {string} requestPath - The incoming request path (e.g., "/users/123")
  * @param {string} routePath - The route pattern (e.g., "/users/:id")
  * @param {Object} requestParams - Object to populate with extracted parameters
  * @returns {Object} Object with normalized requestPath and routePath
  * @returns {string} result.requestPath - Original request path
  * @returns {string} result.routePath - Route path with parameters replaced by actual values
  *
  * @example
  * const params = {};
  * const result = normalizePaths("/users/123", "/users/:id", params);
  * // params = { id: "123" }
  * // result = { requestPath: "/users/123", routePath: "/users/123" }
  */
 const normalizePaths = function(requestPath, routePath, requestParams){
    const obj = {
        requestPath : "",
        routePath : ""
    }

    const requestPathList = requestPath.split("/");
    const routePathList = routePath.split("/");

    for(let i = 0; i < requestPathList.length; i++){
        const requestItem = requestPathList[i];
        const routeItem = routePathList[i];
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
  *
  * Checks for and mitigates:
  * - Path traversal attempts (../, ./)
  * - SQL injection patterns
  * - Command injection characters (; | & ` $ ( ))
  *
  * Logs security warnings when attacks are detected.
  *
  * @param {string} paramName - Name of the route parameter
  * @param {string} paramValue - Value to sanitize
  * @returns {string} Sanitized parameter value
  *
  * @example
  * sanitizeRouteParam("id", "123") // Returns: "123"
  * sanitizeRouteParam("path", "../etc/passwd") // Returns: "etcpasswd" (dangerous parts removed)
  */
 const sanitizeRouteParam = function(paramName, paramValue) {
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

 /**
  * Process routes and match against request
  *
  * Iterates through registered routes, attempting to match the request path and HTTP method.
  * When a match is found:
  * 1. Extracts route parameters
  * 2. Executes route constraints (if defined)
  * 3. Emits EVENT_NAMES.ROUTE_CONSTRAINT_GOOD to trigger controller execution
  *
  * Handles OPTIONS requests for CORS preflight.
  *
  * @param {Object} requestObject - Request context with path, method, params
  * @param {EventEmitter} emitter - Event emitter for route match notification
  * @param {Object} routeObject - Route configuration
  * @param {Array} routeObject.routes - Array of route definitions
  * @param {string} routeObject.root - Application root path
  * @param {boolean} routeObject.isComponent - Whether this is a component route
  * @returns {boolean|number} true if route matched, -1 if no match
  * @throws {Error} If route processing fails
  *
  * @example
  * const result = processRoutes(requestObj, emitter, {
  *   routes: [{ path: "/users/:id", type: "get", toController: "users", toAction: "show" }],
  *   root: "/app",
  *   isComponent: false
  * });
  */
 const processRoutes = function(requestObject, emitter, routeObject){
    const routeList = routeObject.routes;
    const root = routeObject.root;
    const isComponent = routeObject.isComponent;
    let currentRouteBeingProcessed = null; // Track current route for better error messages

    try{
            // Ensure routes is an array
            if(!Array.isArray(routeList)){
                this._master.error.log(`route list is not an array`, "error");
                return -1;
            }

            // No routes registered for this scope; skip silently
            if(routeList.length === 0){
                return -1;
            }

            if(routeList.length > 0){
                // FIXED: Use for...of instead of for...in for array iteration
                // This prevents prototype pollution and improves performance
                for(const route of routeList){
                    // Store current route for error handling
                    currentRouteBeingProcessed = {
                        path: route.path,
                        toController: route.toController,
                        toAction: route.toAction,
                        type: route.type
                    };

                    try {
                        requestObject.toController = route.toController;
                        requestObject.toAction = route.toAction;

                        // FIX: Create a clean copy of params for each route test to prevent parameter pollution
                        // This prevents parameters from non-matching routes from accumulating in requestObject.params
                        const testParams = Object.assign({}, requestObject.params);
                        const pathObj = normalizePaths(requestObject.pathName, route.path, testParams);

                        // if we find the route that matches the request
                        if(pathObj.requestPath === pathObj.routePath && route.type === requestObject.type){
                            // Only commit the extracted params if this route actually matches
                            requestObject.params = testParams;

                            // call Constraint
                            if(typeof route.constraint === "function"){

                                const newObj = {};
                                //tools.combineObjects(newObj, this._master.controllerList);
                                newObj.next = function(){
                                    // CRITICAL FIX: Store route info in requestObject instead of global
                                    requestObject.currentRoute = {
                                        root,
                                        pathName: requestObject.pathName,
                                        toAction: requestObject.toAction,
                                        toController: requestObject.toController,
                                        response: requestObject.response,
                                        isComponent,
                                        routeDef: currentRouteBeingProcessed
                                    };
                                    emitter.emit(EVENT_NAMES.ROUTE_CONSTRAINT_GOOD, requestObject);
                                };

                                // Wrap constraint execution with error handling
                                try {
                                    route.constraint.call(newObj, requestObject);
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

                                // CRITICAL FIX: Store route info in requestObject instead of global
                                requestObject.currentRoute = {
                                    root,
                                    pathName: requestObject.pathName,
                                    toAction: requestObject.toAction,
                                    toController: requestObject.toController,
                                    response: requestObject.response,
                                    isComponent,
                                    routeDef: currentRouteBeingProcessed
                                };
                                emitter.emit(EVENT_NAMES.ROUTE_CONSTRAINT_GOOD, requestObject);
                                return true;
                            }

                        }

                        if(pathObj.requestPath === pathObj.routePath && HTTP_METHODS.OPTIONS === requestObject.type.toLowerCase()){
                            // this means that the request is correct but its an options request means its the browser checking to see if the request is allowed
                            // Commit the params for OPTIONS requests too
                            requestObject.params = testParams;
                            requestObject.response.writeHead(HTTP_STATUS.OK, {'Content-Type': 'application/json'});
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

/**
 * Load scoped service instances into request context
 *
 * CRITICAL FIX: Stores scoped services in the request-specific context instead of
 * the shared requestList object. This prevents race conditions where concurrent
 * requests would overwrite each other's services, causing unpredictable behavior
 * and data corruption in production environments.
 *
 * @param {Object} context - Request-specific context object
 * @returns {void}
 *
 * @example
 * const requestContext = {};
 * loadScopedListClasses.call(masterRouter, requestContext);
 * // requestContext now has scoped service instances
 */
const loadScopedListClasses = function(context){
    // FIXED: Use Object.entries() for safe iteration (prevents prototype pollution)
    for (const [key, className] of Object.entries(this._master._scopedList)) {
        // Store scoped services in the context object (request-specific) instead of shared requestList
        context[key] = new className();
    }
};


/**
 * Validate route path format
 *
 * @param {string} path - Route path to validate
 * @throws {Error} If path is invalid
 */
function validateRoutePath(path) {
    if (!path || typeof path !== 'string') {
        throw new TypeError('Route path must be a non-empty string');
    }

    if (path.length > ROUTER_CONFIG.MAX_ROUTE_LENGTH) {
        throw new Error(`Route path exceeds maximum length (${ROUTER_CONFIG.MAX_ROUTE_LENGTH} characters)`);
    }

    // Check for invalid characters
    if (/[<>{}[\]\\^`|]/.test(path)) {
        throw new Error(`Route path contains invalid characters: ${path}`);
    }
}

/**
 * Validate HTTP method
 *
 * @param {string} method - HTTP method to validate
 * @throws {Error} If method is invalid
 */
function validateHttpMethod(method) {
    const validMethods = Object.values(HTTP_METHODS);
    if (!validMethods.includes(method.toLowerCase())) {
        throw new Error(`Invalid HTTP method: ${method}. Must be one of: ${validMethods.join(', ')}`);
    }
}

/**
 * Validate controller/action name
 *
 * @param {string} name - Name to validate
 * @param {string} type - Type (controller or action)
 * @throws {Error} If name is invalid
 */
function validateIdentifier(name, type) {
    if (!name || typeof name !== 'string') {
        throw new TypeError(`${type} name must be a non-empty string`);
    }

    // Controllers can have forward slashes for nested structures (e.g., "api/health")
    // Actions must be simple identifiers
    if (type === 'controller') {
        // Split on slash and validate each segment
        const segments = name.split('/');
        for (const segment of segments) {
            if (!segment || !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(segment)) {
                throw new Error(`Invalid ${type} name: ${name}. Each segment must be a valid identifier.`);
            }
        }
    } else {
        // Actions must be simple identifiers (no slashes)
        if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) {
            throw new Error(`Invalid ${type} name: ${name}. Must be a valid identifier.`);
        }
    }
}

/**
 * Normalize route path: lowercase segments but preserve param names
 *
 * Ensures consistent route matching by:
 * - Converting path segments to lowercase
 * - Preserving parameter names (segments starting with :)
 * - Removing leading/trailing slashes
 *
 * @param {string} path - Route path like "/Period/:periodId/Items/:itemId"
 * @returns {string} Normalized path: "period/:periodId/items/:itemId"
 *
 * @example
 * normalizeRoutePath("/Users/:userId/Posts/:postId")
 * // Returns: "users/:userId/posts/:postId"
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

/**
 * MasterRouter - Route management and request routing
 *
 * Handles:
 * - Route registration (manual and RESTful resources)
 * - Path normalization and parameter extraction
 * - Controller/action resolution and execution
 * - Route constraints and middleware
 * - Request-specific context isolation (no shared state)
 *
 * @class MasterRouter
 */
class MasterRouter {
    currentRouteName = null
    _routes = {}
    _currentRoute = null // Instance property instead of global

    // Lazy-load master to avoid circular dependency (Google-style lazy initialization)
    get _master() {
        if (!this.__masterCache) {
            this.__masterCache = require('./MasterControl');
        }
        return this.__masterCache;
    }

    /**
     * Start route definition builder
     *
     * Returns an object with methods for defining routes:
     * - route(path, toPath, type, constraint): Define a single route
     * - resources(routeName): Define RESTful resource routes
     *
     * @returns {Object} Route builder with route() and resources() methods
     *
     * @example
     * const builder = masterRouter.start();
     * builder.route("/users/:id", "users#show", "get");
     * builder.resources("posts"); // Creates index, new, create, show, edit, update, destroy
     */
    start(){
        const $that = this;
        return {
            route : function(path, toPath, type, constraint){ // function to add to list of routes
                // Input validation
                validateRoutePath(path);
                validateHttpMethod(type);

                if (!toPath || typeof toPath !== 'string') {
                    throw new TypeError('Route target (toPath) must be a non-empty string');
                }

                if (!/^[^#]+#[^#]+$/.test(toPath)) {
                    throw new Error(`Invalid route target format: ${toPath}. Must be "controller#action"`);
                }

                const pathList = toPath.replace(/^\/|\/$/g, '').split("#");
                const controller = pathList[0].replace(/^\/|\/$/g, '');
                const action = pathList[1];

                validateIdentifier(controller, 'controller');
                validateIdentifier(action, 'action');

                if (constraint !== undefined && constraint !== null && typeof constraint !== 'function') {
                    throw new TypeError('Route constraint must be a function or null/undefined');
                }

                const route = {
                    type: type.toLowerCase(),
                    path: normalizeRoutePath(path),
                    toController: controller,
                    toAction: action,
                    constraint : constraint
                };

                $that._routes[$that.currentRouteName].routes.push(route);

            },
        
            resources: function(routeName){ // function to add to list of routes using resources bulk
                // Input validation
                if (!routeName || typeof routeName !== 'string') {
                    throw new TypeError('Resource name must be a non-empty string');
                }

                validateIdentifier(routeName, 'resource');
                validateRoutePath(`/${routeName}`);

                $that._routes[$that.currentRouteName].routes.push({
                        type: HTTP_METHODS.GET,
                        path: normalizeRoutePath(routeName),
                        toController :routeName,
                        toAction: "index",
                        constraint : null
                    });

                    $that._routes[$that.currentRouteName].routes.push({
                        type: HTTP_METHODS.GET,
                        path: normalizeRoutePath(routeName),
                        toController :routeName,
                        toAction: "new",
                        constraint : null
                    });

                    $that._routes[$that.currentRouteName].routes.push({
                        type: HTTP_METHODS.POST,
                        path: normalizeRoutePath(routeName),
                        toController :routeName,
                        toAction: "create",
                        constraint : null
                    });

                    $that._routes[$that.currentRouteName].routes.push({
                        // pages/3
                        type: HTTP_METHODS.GET,
                        path: normalizeRoutePath(routeName + "/:id"),
                        toController :routeName,
                        toAction: "show",
                        constraint : null
                    });

                    $that._routes[$that.currentRouteName].routes.push({
                        type: HTTP_METHODS.GET,
                        path: normalizeRoutePath(routeName + "/:id/edit"),
                        toController :routeName,
                        toAction: "edit",
                        constraint : null
                    });

                    $that._routes[$that.currentRouteName].routes.push({
                        type: HTTP_METHODS.PUT,
                        path: normalizeRoutePath(routeName + "/:id"),
                        toController :routeName,
                        toAction: "update",
                        constraint : null
                    });

                    $that._routes[$that.currentRouteName].routes.push({
                        type: HTTP_METHODS.DELETE,
                        path: normalizeRoutePath(routeName + "/:id"),
                        toController :routeName,
                        toAction: "destroy",
                        constraint : null
                    });
            }
        }
    }

    /**
     * Initialize router with MIME type list
     *
     * @param {Object} mimeList - Object mapping file extensions to MIME types
     * @returns {void}
     * @deprecated Use addMimeList() instead
     *
     * @example
     * router.loadRoutes({ json: 'application/json', html: 'text/html' });
     */
    loadRoutes(mimeList){
        this.init(mimeList);
    }

    /**
     * Add MIME type mappings
     *
     * @param {Object} mimeList - Object mapping file extensions to MIME types
     * @returns {void}
     *
     * @example
     * router.addMimeList({ json: 'application/json', xml: 'application/xml' });
     */
    addMimeList(mimeList){
        this._addMimeList(mimeList);
    }

    /**
     * Setup a new route scope
     *
     * Creates a new route group with a unique ID. All routes defined via start()
     * will be added to this scope until setup() is called again.
     *
     * @param {Object} route - Route scope configuration
     * @param {string} route.root - Application root path
     * @param {boolean} [route.isComponent=false] - Whether this is a component route
     * @returns {void}
     *
     * @example
     * router.setup({ root: '/app', isComponent: false });
     * const builder = router.start();
     * builder.route("/users", "users#index", "get");
     */
    setup(route){
        // Input validation
        if (!route || typeof route !== 'object') {
            throw new TypeError('Route configuration must be an object');
        }

        if (!route.root || typeof route.root !== 'string') {
            throw new TypeError('Route configuration must have a valid root path');
        }

        this.currentRouteName = tools.makeWordId(ROUTER_CONFIG.ROUTE_ID_LENGTH);

        if(this._routes[this.currentRouteName] === undefined){
            this._routes[this.currentRouteName] = {
                root : route.root,
                isComponent : route.isComponent,
                routes : []
            };
        }
    }

    /**
     * Get current route (deprecated - use requestObject.currentRoute instead)
     * @deprecated Store route in requestObject.currentRoute for request isolation
     * @returns {Object} Current route information
     */
    get currentRoute(){
        return this._currentRoute;
    }

    /**
     * Set current route (deprecated - use requestObject.currentRoute instead)
     * @deprecated Store route in requestObject.currentRoute for request isolation
     * @param {Object} data - Route data
     */
    set currentRoute(data){
        this._currentRoute = data;
    }

    _addMimeList(mimeObject){
        const that = this;
        if(mimeObject){
            that.mimeTypes = mimeObject;
        }
    }

    /**
     * Find MIME type for file extension
     *
     * Performs O(1) constant-time lookup in MIME types object.
     *
     * @param {string} fileExt - File extension (with or without leading dot)
     * @returns {string|boolean} MIME type string or false if not found
     *
     * @example
     * router.findMimeType("json") // Returns: "application/json"
     * router.findMimeType(".html") // Returns: "text/html"
     * router.findMimeType("unknown") // Returns: false
     */
    findMimeType(fileExt){
        if(!fileExt){
            return false;
        }

        // FIXED: O(1) direct lookup instead of O(n) loop
        // Remove leading dot if present for consistent lookup
        const ext = fileExt.startsWith('.') ? fileExt.slice(1) : fileExt;

        // Direct object access - constant time complexity
        const type = this.mimeTypes[ext];

        // Return the MIME type or false if not found
        return type || false;
    }

    /**
     * Execute controller action for matched route
     *
     * Internal method that:
     * 1. Loads the controller file
     * 2. Creates controller instance with request context
     * 3. Executes beforeAction filters
     * 4. Calls the action method
     * 5. Handles errors and sends responses
     *
     * @private
     * @param {Object} requestObject - Request context with route information
     * @returns {void}
     *
     * @example
     * // Called internally when route matches
     * this._call(requestObject);
     */
    _call(requestObject){

         // Start performance tracking
         const requestId = `${Date.now()}-${Math.random()}`;
         performanceTracker.start(requestId, requestObject);

         // CRITICAL FIX: Use currentRoute from requestObject (not global)
         const currentRoute = requestObject.currentRoute;

         // CRITICAL FIX: Create a request-specific context instead of using shared requestList
         // This prevents race conditions where concurrent requests overwrite each other's services
         const requestContext = Object.create(this._master.requestList);
         tools.combineObjects(requestContext, requestObject);
         requestObject = requestContext;
         let Control = null;

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

             tools.combineObjectPrototype(Control, this._master.controllerList);
             Control.prototype.__namespace = Control.name;
             Control.prototype.__requestObject = requestObject;
             Control.prototype.__currentRoute = currentRoute;
             Control.prototype.__response = requestObject.response;
             Control.prototype.__request = requestObject.request;
             const control = new Control(requestObject);
             const _callEmit = new EventEmitter();

             _callEmit.on(EVENT_NAMES.CONTROLLER, function(){
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
                            // MEMORY LEAK FIX: Clean up event listeners
                            _callEmit.removeAllListeners();
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
                            // MEMORY LEAK FIX: Clean up event listeners
                            _callEmit.removeAllListeners();
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
                    // MEMORY LEAK FIX: Clean up event listeners
                    _callEmit.removeAllListeners();
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
    
    /**
     * Load and route incoming request
     *
     * Main entry point for request routing:
     * 1. Creates request-specific context
     * 2. Loads scoped services
     * 3. Normalizes request path
     * 4. Searches for matching route
     * 5. Triggers controller execution or sends 404
     *
     * @param {Object} rr - Raw request object
     * @param {Object} rr.request - HTTP request
     * @param {Object} rr.response - HTTP response
     * @param {string} rr.pathName - Request path
     * @param {string} rr.type - HTTP method (get, post, etc.)
     * @param {Object} [rr.params={}] - Query parameters
     * @returns {void}
     *
     * @example
     * router.load({
     *   request: req,
     *   response: res,
     *   pathName: "/users/123",
     *   type: "get",
     *   params: {}
     * });
     */
    load(rr){ // load the the router
            // Input validation
            if (!rr || typeof rr !== 'object') {
                throw new TypeError('Request object must be a valid object');
            }

            if (!rr.request || typeof rr.request !== 'object') {
                throw new TypeError('Request object must have a valid request property');
            }

            if (!rr.response || typeof rr.response !== 'object') {
                throw new TypeError('Request object must have a valid response property');
            }

            if (!rr.pathName || typeof rr.pathName !== 'string') {
                throw new TypeError('Request object must have a valid pathName');
            }

            if (!rr.type || typeof rr.type !== 'string') {
                throw new TypeError('Request object must have a valid type (HTTP method)');
            }

            const $that = this;
            const requestObject = Object.create(rr);

            // CRITICAL FIX: Load scoped services into request-specific context
            // Pass requestObject so scoped services are stored per-request, not globally
            loadScopedListClasses.call(this, requestObject);
            requestObject.pathName = requestObject.pathName.replace(/^\/|\/$/g, '').toLowerCase();

            const _loadEmit = new EventEmitter();

            _loadEmit.on(EVENT_NAMES.ROUTE_CONSTRAINT_GOOD, function(requestObj){
                    $that._call(requestObj);
                    // MEMORY LEAK FIX: Clean up event listeners after handling route
                    _loadEmit.removeAllListeners();
            });

            let routeFound = false;
            const routes = Object.keys(this._routes);
            for (const route of routes) {
               const result = processRoutes(requestObject, _loadEmit, this._routes[route] );
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
                // MEMORY LEAK FIX: Clean up event listeners if route not found
                _loadEmit.removeAllListeners();
            }

    }
    
}

module.exports = { MasterRouter };
