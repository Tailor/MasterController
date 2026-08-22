// version 0.0.250

import toolClass from './MasterTools.js';
import EventEmitter from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// REMOVED: Global currentRoute (race condition bug) - now stored in requestObject
const tools = new toolClass();

// Enhanced error handling
import { handleRoutingError, handleControllerError, sendErrorResponse } from './error/MasterBackendErrorHandler.js';
import { resolveControllerAuthorize } from './security/MasterAuth.js';
import { resolveControllerSchemas, bindRequest, writeValidationProblem } from './security/MasterModelBinding.js';
import { logger } from './error/MasterErrorLogger.js';
import { performanceTracker, errorHandlerMiddleware } from './error/MasterErrorMiddleware.js';

// Security - Input validation and sanitization
import { validator, detectPathTraversal, detectSQLInjection, detectCommandInjection } from './security/MasterValidator.js';
import { escapeHTML } from './security/MasterSanitizer.js';
import fs from 'node:fs';

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
    PATCH: 'patch',
    DELETE: 'delete',
    HEAD: 'head',
    OPTIONS: 'options'
};

// Router Configuration Constants
const ROUTER_CONFIG = {
    ROUTE_ID_LENGTH: 4,
    DEFAULT_TIMEOUT: 30000, // 30 seconds
    MAX_ROUTE_LENGTH: 2048
};

const ROUTE_PARAM_RE = /^:([A-Za-z_$][\w$]*)(?:\((.+)\))?$/;
const UUID_PARAM_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARAM_CONSTRAINTS = {
    int:      (v) => /^-?\d+$/.test(v) ? { ok: true, value: Number(v) } : { ok: false },
    number:   (v) => (v !== '' && !Number.isNaN(Number(v)) && Number.isFinite(Number(v))) ? { ok: true, value: Number(v) } : { ok: false },
    bool:     (v) => /^(true|false|1|0)$/i.test(v) ? { ok: true, value: /^(true|1)$/i.test(v) } : { ok: false },
    uuid:     (v) => UUID_PARAM_RE.test(v) ? { ok: true, value: v.toLowerCase() } : { ok: false },
    alpha:    (v) => /^[A-Za-z]+$/.test(v) ? { ok: true, value: v } : { ok: false },
    alphanum: (v) => /^[A-Za-z0-9]+$/.test(v) ? { ok: true, value: v } : { ok: false },
    slug:     (v) => /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(v) ? { ok: true, value: v } : { ok: false },
};
PARAM_CONSTRAINTS.double = PARAM_CONSTRAINTS.float = PARAM_CONSTRAINTS.number;
PARAM_CONSTRAINTS.guid = PARAM_CONSTRAINTS.uuid;
PARAM_CONSTRAINTS.string = (v) => ({ ok: true, value: v });

/** Original-case path segments of the request (for route values); null when unknown. */
function originalPathSegments(requestObject) {
    try {
        let pathname = requestObject && requestObject.requrl && requestObject.requrl.pathname;
        if (!pathname && requestObject && requestObject.request && requestObject.request.url) {
            pathname = new URL(requestObject.request.url, 'http://localhost').pathname;
        }
        if (!pathname) return null;
        const trimmed = String(pathname).replace(/^\/|\/$/g, '');
        return trimmed.split('/');
    } catch (_) {
        return null;
    }
}

/** ':id(int)' -> { name: 'id', constraint: 'int' } ; ':id' -> { name: 'id', constraint: null } */
function parseRouteParam(segment) {
    const m = String(segment).match(ROUTE_PARAM_RE);
    if (!m) return { name: String(segment).replace(':', ''), constraint: null };
    return { name: m[1], constraint: m[2] ? m[2].trim() : null };
}

/** Evaluate a typed constraint against a raw path segment -> { ok, value }. */
function checkParamConstraint(constraint, raw) {
    if (raw === undefined || raw === null) return { ok: false };
    const value = decodeURIComponent(String(raw));
    const lower = constraint.toLowerCase();
    if (PARAM_CONSTRAINTS[lower]) return PARAM_CONSTRAINTS[lower](value);
    let m;
    if ((m = lower.match(/^length\((\d+)\)$/))) return value.length === Number(m[1]) ? { ok: true, value } : { ok: false };
    if ((m = lower.match(/^minlength\((\d+)\)$/))) return value.length >= Number(m[1]) ? { ok: true, value } : { ok: false };
    if ((m = lower.match(/^maxlength\((\d+)\)$/))) return value.length <= Number(m[1]) ? { ok: true, value } : { ok: false };
    if ((m = lower.match(/^min\((-?\d+)\)$/))) { const n = Number(value); return (/^-?\d+$/.test(value) && n >= Number(m[1])) ? { ok: true, value: n } : { ok: false }; }
    if ((m = lower.match(/^max\((-?\d+)\)$/))) { const n = Number(value); return (/^-?\d+$/.test(value) && n <= Number(m[1])) ? { ok: true, value: n } : { ok: false }; }
    if ((m = constraint.match(/^regex:(.+)$/s))) { try { return new RegExp(m[1]).test(value) ? { ok: true, value } : { ok: false }; } catch (_) { return { ok: false }; } }
    return { ok: false };
}

/** Reject unknown constraint names at registration time (fail fast). */
function validateRouteParamConstraints(path) {
    for (const seg of String(path).split('/')) {
        if (!seg.startsWith(':')) continue;
        const p = parseRouteParam(seg);
        if (!p.constraint) continue;
        const lower = p.constraint.toLowerCase();
        const ok = PARAM_CONSTRAINTS[lower] || /^(length|minlength|maxlength|min|max)\((-?\d+)\)$/.test(lower) || /^regex:.+$/s.test(p.constraint);
        if (!ok) throw new Error(`Unknown route constraint '${p.constraint}' in segment '${seg}' (int, number, bool, uuid, alpha, alphanum, slug, length(n), minlength(n), maxlength(n), min(n), max(n), regex:…)`);
    }
}

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
 const normalizePaths = function(requestPath, routePath, requestParams, originalSegments = null){
    const obj = {
        requestPath : "",
        routePath : ""
    }

    const requestPathList = requestPath.split("/");
    const routePathList = routePath.split("/");

    for(let i = 0; i < requestPathList.length; i++){
        // Matching is case-insensitive (requestPath is lowercased), but route
        // VALUES keep the caller's casing when the original segments are known
        // (v2.4.0 — ids/tokens/slugs are case-sensitive; ASP.NET preserves them).
        const requestItem = (originalSegments && originalSegments.length === requestPathList.length && originalSegments[i] !== undefined)
            ? originalSegments[i]
            : requestPathList[i];
        const routeItem = routePathList[i];
        if(routeItem){
            if(routeItem.indexOf(":") > -1){
                // v2.4.0: typed route constraints — ':id(int)', ':code(regex:^[A-Z]{3}$)' …
                // (ASP.NET {id:int}). A constraint miss makes the route not match so
                // the router can try the next one; matched values are coerced.
                const parsed = parseRouteParam(routeItem);
                const paramName = parsed.name;
                const paramValue = requestItem;
                if (parsed.constraint) {
                    const check = checkParamConstraint(parsed.constraint, paramValue);
                    if (!check.ok) {
                        routePathList[i] = '\u0000';        // cannot equal any request segment
                        continue;
                    }
                    requestParams[paramName] = check.value;
                    routePathList[i] = requestPathList[i];   // match on the lowercased segment
                    continue;
                }

                // Security: Sanitize route parameter
                const sanitizedValue = sanitizeRouteParam(paramName, paramValue);

                requestParams[paramName] = sanitizedValue;
                // FIX: Use the request segment (not sanitizedValue) for route matching
                // The route pattern should match against the actual request path
                routePathList[i] = requestPathList[i];   // match on the lowercased segment
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

    // Fast path: skip expensive regex checks for simple alphanumeric values
    if (/^[a-zA-Z0-9_-]+$/.test(paramValue)) {
        return paramValue;
    }

    // Check for path traversal attempts
    const pathCheck = detectPathTraversal(paramValue);
    if (!pathCheck.safe) {
        logger.warn({
            code: 'MC_SECURITY_PATH_TRAVERSAL',
            message: 'Path traversal attempt detected in route parameter',
            context: { param: paramName, value: paramValue }
        });

        // v2.1.1: single-pass replacement was non-idempotent — `....//`
        // left `..//` because the outer dots collapsed inward. Repeatedly
        // strip until stable so no `..` sequence can survive.
        let cleaned = paramValue;
        let prev;
        do {
            prev = cleaned;
            cleaned = cleaned.replace(/\.\./g, '').replace(/\.\//g, '');
        } while (cleaned !== prev);
        return cleaned;
    }

    // Check for SQL injection attempts
    const sqlCheck = detectSQLInjection(paramValue);
    if (!sqlCheck.safe) {
        logger.warn({
            code: 'MC_SECURITY_SQL_INJECTION',
            message: 'SQL injection attempt detected in route parameter',
            context: { param: paramName, value: paramValue }
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
            context: { param: paramName, value: paramValue }
        });

        // Remove dangerous characters
        return paramValue.replace(/[;&|`$()]/g, '');
    }

    // Basic sanitization for all params
    return escapeHTML(paramValue);
 }

 /**
 * Dispatch a matched route: run its constraint (if any) and emit
 * ROUTE_CONSTRAINT_GOOD so the controller executes. Shared by the plain and
 * the authorized (async) paths of processRoutes().
 */
const __dispatchMatchedRoute = function(requestObject, emitter, route, root, isComponent, routeDef){
    const setCurrentRoute = () => {
        requestObject.currentRoute = {
            root,
            pathName: requestObject.pathName,
            toAction: requestObject.toAction,
            toController: requestObject.toController,
            response: requestObject.response,
            isComponent,
            routeDef
        };
    };
    if (typeof route.constraint === "function") {
        const newObj = {};
        newObj.next = function(){
            setCurrentRoute();
            emitter.emit(EVENT_NAMES.ROUTE_CONSTRAINT_GOOD, requestObject);
        };
        try {
            route.constraint.call(newObj, requestObject);
        } catch(constraintError) {
            handleRoutingError(requestObject.pathName, [], { type: 'CONSTRAINT_ERROR', route: routeDef, error: constraintError });
            logger.error({
                code: 'MC_ERR_ROUTE_CONSTRAINT',
                message: `Route constraint failed for ${routeDef && routeDef.path}`,
                route: routeDef,
                error: constraintError.message,
                stack: constraintError.stack
            });
            throw constraintError;
        }
        return;
    }
    setCurrentRoute();
    emitter.emit(EVENT_NAMES.ROUTE_CONSTRAINT_GOOD, requestObject);
};

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
    // v2.11.0: versions served per path+method (built lazily, once per request)
    let versionIndex = null;
    const getVersionIndex = () => {
        if (versionIndex) return versionIndex;
        versionIndex = new Map();
        for (const r of (Array.isArray(routeList) ? routeList : [])) {
            if (r.apiVersion === undefined || r.apiVersion === null) continue;
            const key = `${r.path}|${r.type}`;
            const e = versionIndex.get(key) || { supported: new Set(), deprecated: new Set() };
            for (const v of [].concat(r.apiVersion)) e.supported.add(String(v));
            if (r.deprecated === true) for (const v of [].concat(r.apiVersion)) e.deprecated.add(String(v));
            else if (r.deprecated) for (const v of [].concat(r.deprecated)) e.deprecated.add(String(v));
            versionIndex.set(key, e);
        }
        return versionIndex;
    };
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
                        type: route.type,
                        outputCache: route.outputCache
                    };

                    try {
                        requestObject.toController = route.toController;
                        requestObject.toAction = route.toAction;

                        // FIX: Create a clean copy of params for each route test to prevent parameter pollution
                        // This prevents parameters from non-matching routes from accumulating in requestObject.params
                        const testParams = Object.assign({}, requestObject.params);
                        const pathObj = normalizePaths(requestObject.pathName, route.path, testParams, originalPathSegments(requestObject));

                        // if we find the route that matches the request
                        // HEAD requests match GET routes per HTTP spec (RFC 9110 §9.3.2)
                        const methodMatches = route.type === requestObject.type
                            || (requestObject.type === HTTP_METHODS.HEAD && route.type === HTTP_METHODS.GET);
                        if(pathObj.requestPath === pathObj.routePath && methodMatches){
                            // v2.11.0: API versioning — a versioned route serves only its versions.
                            const versioning = requestObject.master && requestObject.master.apiVersioning;
                            if (versioning && route.apiVersion !== undefined && route.apiVersion !== null) {
                                // every version served on this path+method (all routes, not just the ones scanned so far)
                                const entry = getVersionIndex().get(`${route.path}|${route.type}`) || { supported: new Set(), deprecated: new Set() };
                                requestObject.__apiVersionMismatch = entry;
                                if (!versioning.routeMatches(route, requestObject)) continue;
                                requestObject.__apiVersions = { supported: [...entry.supported], deprecated: [...entry.deprecated] };
                            }
                            // Only commit the extracted params if this route actually matches
                            requestObject.params = testParams;

                            // call Constraint
                            // v2.3.0: route-level authorization (ASP.NET [Authorize] on an
                            // endpoint) runs BEFORE the constraint. A failure has already
                            // written the 401/403 (or redirect), so the route is "handled".
                            if (route.allowAnonymous) requestObject.__allowAnonymous = true;
                            const masterForAuth = requestObject.master;
                            if (route.authorize !== undefined && route.authorize !== null && route.authorize !== false && masterForAuth && masterForAuth.auth) {
                                const routeDefForAuth = currentRouteBeingProcessed;
                                masterForAuth.auth.enforce(requestObject, route.authorize).then((allowed) => {
                                    if (!allowed) return;
                                    try {
                                        __dispatchMatchedRoute(requestObject, emitter, route, root, isComponent, routeDefForAuth);
                                    } catch (dispatchError) {
                                        const routeError = handleRoutingError(requestObject.pathName, [], { type: 'CONSTRAINT_ERROR', route: routeDefForAuth, error: dispatchError });
                                        sendErrorResponse(requestObject.response, routeError, requestObject.pathName, requestObject.request);
                                    }
                                }).catch((authError) => {
                                    logger.error({ code: 'MC_ERR_ROUTE_AUTHORIZE', message: `Route authorization failed for ${routeDefForAuth.path}`, error: authError && authError.message, stack: authError && authError.stack });
                                    const routeError = handleRoutingError(requestObject.pathName, [], { type: 'CONSTRAINT_ERROR', route: routeDefForAuth, error: authError });
                                    sendErrorResponse(requestObject.response, routeError, requestObject.pathName, requestObject.request);
                                });
                                return true;
                            }

                            __dispatchMatchedRoute(requestObject, emitter, route, root, isComponent, currentRouteBeingProcessed);
                            return true;
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
        // Lazy, per-scope resolution — mirrors ASP.NET Core DI (where EF's
        // DbContext is a Scoped service). A scoped service is constructed on
        // FIRST access within the request scope (not eagerly), cached for the
        // rest of the scope, and is handed the scope so it can read its
        // dependencies (e.g. `scope.userContext`) on demand — so registration
        // order doesn't matter and a request builds only the services it
        // actually touches. Backward compatible: existing no-arg scoped classes
        // simply ignore the scope argument.
        let instance;   // block-scoped per key: each getter closes over its own
        Object.defineProperty(context, key, {
            configurable: true,
            enumerable: true,
            get() {
                if (instance === undefined) {
                    instance = new className(context);
                }
                return instance;
            },
        });
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

    // Check for invalid characters — outside typed-constraint bodies
    // (v2.4.0: ':code(regex:^[A-Z]{3}$)' legitimately contains ^ [ ] { }).
    const withoutConstraints = String(path).split('/').map(seg => seg.startsWith(':') ? seg.replace(/\(.*\)$/s, '') : seg).join('/');
    if (/[<>{}[\]\\^`|]/.test(withoutConstraints)) {
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

    constructor(master) {
        // Constructor injection (replaces previous lazy require pattern)
        this._master = master;
        // Controller registry: pre-populated at startup by discoverControllers().
        // Keyed by absolute file path. Eliminates per-request fs/require overhead
        // and is required for Phase 4 (ESM) where sync require() doesn't exist.
        this._controllers = new Map();
        // v2.10.0: programmatic controllers (minimal APIs) and named routes (urlFor)
        this._programmatic = new Map();
        this._named = new Map();
        this._minimalSeq = 0;
    }

    /**
     * Pre-load all controllers from a route's controllers directory into the registry.
     * Called from MasterControl.startMVC() during framework startup.
     *
     * Async because Phase 4 (ESM) will use `await import()`. In v1.x this still
     * uses sync require() for backward compatibility.
     *
     * @param {String} routeRoot - Absolute path to a route root (e.g. master.root, or a component root)
     * @returns {Promise<void>}
     */
    async discoverControllers(routeRoot) {

        const controllersDir = path.join(routeRoot, 'app', 'controllers');
        if (!fs.existsSync(controllersDir)) {
            return; // No controllers in this route — silent skip (some component routes have none)
        }

        const walk = async (dir) => {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walk(full);
                } else if (entry.isFile() && entry.name.endsWith('.js')) {
                    try {
                        const mod = await import(pathToFileURL(full).href);
                        const Control = mod.default ?? mod;
                        if (Control && typeof Control === 'function') {
                            this._controllers.set(full, Control);
                        }
                    } catch (err) {
                        logger.error({
                            code: 'MC_CONTROLLER_LOAD_FAILED',
                            message: 'Failed to pre-load controller',
                            file: full,
                            error: err.message,
                            stack: err.stack
                        });
                    }
                }
            }
        };

        await walk(controllersDir);
    }

    /**
     * Resolve a controller class by name from the registry.
     *
     * The registry is populated at startup by discoverControllers(). In ESM
     * there is no synchronous fallback — unknown controllers return null and
     * the caller is responsible for raising an error.
     *
     * @private
     * @param {String} routeRoot - Absolute path of the matching route root
     * @param {String} controllerName - Lowercased controller name (without "Controller" suffix)
     * @returns {Function|null} The controller class, or null if not found
     */
    _resolveController(routeRoot, controllerName) {
        if (this._programmatic.has(controllerName)) return this._programmatic.get(controllerName);   // v2.10.0 minimal APIs
        const lowerPath = path.join(routeRoot, 'app', 'controllers', `${tools.firstLetterlowercase(controllerName)}Controller.js`);
        if (this._controllers.has(lowerPath)) {
            return this._controllers.get(lowerPath);
        }
        const upperPath = path.join(routeRoot, 'app', 'controllers', `${tools.firstLetterUppercase(controllerName)}Controller.js`);
        if (this._controllers.has(upperPath)) {
            return this._controllers.get(upperPath);
        }
        return null;
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
                validateRouteParamConstraints(path);   // v2.4.0 typed constraints

                // v2.3.0: the 4th argument may be an options object —
                // { constraint?, authorize?, allowAnonymous? } — so a route can carry
                // its own [Authorize] requirement (ASP.NET endpoint authorization).
                let routeOptions = {};
                if (constraint && typeof constraint === 'object') {
                    routeOptions = constraint;
                    constraint = routeOptions.constraint;
                }

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
                    constraint : constraint,
                    authorize: routeOptions.allowAnonymous ? undefined : routeOptions.authorize,   // [AllowAnonymous] wins
                    allowAnonymous: !!routeOptions.allowAnonymous,
                    outputCache: routeOptions.outputCache,     // v2.8.0 [OutputCache]
                    name: routeOptions.name || undefined,      // v2.10.0 named route (urlFor)
                    apiVersion: routeOptions.apiVersion,       // v2.11.0 [ApiVersion]
                    deprecated: routeOptions.deprecated        // v2.11.0 [Obsolete] / deprecated versions
                };

                $that._routes[$that.currentRouteName].routes.push(route);
                if (route.name) $that._named.set(route.name, route);

            },

            /**
             * v2.10.0 — route group (ASP.NET MapGroup): a path prefix plus default
             * route options (authorize, allowAnonymous, outputCache) applied to
             * every route registered through the returned builder.
             *   router.group('/api/v1', { authorize: true }, (g) => { g.route('/items', 'items#index', 'get'); g.resources('posts'); });
             */
            group: function(prefix, groupOptions, fn){
                if (typeof groupOptions === 'function') { fn = groupOptions; groupOptions = {}; }
                groupOptions = groupOptions || {};
                const parent = this;
                const pfx = '/' + String(prefix || '').replace(/^\/|\/$/g, '');
                const join = (p) => { const rel = String(p || '').replace(/^\/+/, ''); const base = pfx === '/' ? '' : pfx; return rel ? `${base}/${rel}` : (base || '/'); };
                const merge = (opts) => {
                    let o = {};
                    if (typeof opts === 'function') o = { constraint: opts }; else if (opts && typeof opts === 'object') o = { ...opts };
                    const inheritable = ['authorize', 'allowAnonymous', 'outputCache', 'apiVersion'];
                    for (const k of inheritable) if (o[k] === undefined && groupOptions[k] !== undefined) o[k] = groupOptions[k];
                    if (o.allowAnonymous) o.authorize = undefined;   // a route opting out beats the group's authorize
                    return o;
                };
                const builder = {
                    route(p, toPath, type, opts) { parent.route(join(p), toPath, type, merge(opts)); return builder; },
                    resources(name, opts = {}) {
                        const o = merge(opts);
                        const only = Array.isArray(opts.only) ? opts.only : null, except = Array.isArray(opts.except) ? opts.except : [];
                        const table = [['get', `/${name}`, 'index'], ['get', `/${name}/new`, 'new'], ['post', `/${name}`, 'create'], ['get', `/${name}/:id`, 'show'], ['get', `/${name}/:id/edit`, 'edit'], ['put', `/${name}/:id`, 'update'], ['delete', `/${name}/:id`, 'destroy']];
                        for (const [m, p, action] of table) {
                            if ((only && !only.includes(action)) || except.includes(action)) continue;
                            const ro = { ...o }; delete ro.only; delete ro.except;
                            if (ro.outputCache !== undefined && !['index', 'show'].includes(action)) delete ro.outputCache;
                            parent.route(join(p), `${name}#${action}`, m, ro);
                        }
                        return builder;
                    },
                    group(p, opts, f) { return parent.group(join(p), { ...groupOptions, ...(typeof opts === 'object' && opts ? opts : {}) }, typeof opts === 'function' ? opts : f); },
                };
                if (typeof fn === 'function') fn(builder);
                return builder;
            },

            resources: function(routeName, resourceOptions = {}){ // function to add to list of routes using resources bulk
                // Input validation
                if (!routeName || typeof routeName !== 'string') {
                    throw new TypeError('Resource name must be a non-empty string');
                }

                validateIdentifier(routeName, 'resource');
                validateRoutePath(`/${routeName}`);

                // v2.3.0: resources('posts', { authorize: {...}, only: [...], except: [...] })
                const authorize = resourceOptions && resourceOptions.authorize;
                const only = resourceOptions && Array.isArray(resourceOptions.only) ? resourceOptions.only : null;
                const except = resourceOptions && Array.isArray(resourceOptions.except) ? resourceOptions.except : [];
                const add = (r) => { if ((!only || only.includes(r.toAction)) && !except.includes(r.toAction)) { r.authorize = authorize; if (resourceOptions && resourceOptions.outputCache !== undefined && ['index', 'show'].includes(r.toAction)) r.outputCache = resourceOptions.outputCache; $that._routes[$that.currentRouteName].routes.push(r); } };

                add({
                        type: HTTP_METHODS.GET,
                        path: normalizeRoutePath(routeName),
                        toController :routeName,
                        toAction: "index",
                        constraint : null
                    });

                    add({
                        type: HTTP_METHODS.GET,
                        path: normalizeRoutePath(routeName),
                        toController :routeName,
                        toAction: "new",
                        constraint : null
                    });

                    add({
                        type: HTTP_METHODS.POST,
                        path: normalizeRoutePath(routeName),
                        toController :routeName,
                        toAction: "create",
                        constraint : null
                    });

                    add({
                        // pages/3
                        type: HTTP_METHODS.GET,
                        path: normalizeRoutePath(routeName + "/:id"),
                        toController :routeName,
                        toAction: "show",
                        constraint : null
                    });

                    add({
                        type: HTTP_METHODS.GET,
                        path: normalizeRoutePath(routeName + "/:id/edit"),
                        toController :routeName,
                        toAction: "edit",
                        constraint : null
                    });

                    add({
                        type: HTTP_METHODS.PUT,
                        path: normalizeRoutePath(routeName + "/:id"),
                        toController :routeName,
                        toAction: "update",
                        constraint : null
                    });

                    add({
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
     * v2.10.0 — minimal API (ASP.NET app.MapGet/MapPost): register a handler for
     * a path without a controller file. The handler runs as a controller action:
     * `this` has ok/created/problem/authorize/signIn/logger/user/model…, and the
     * request object is the first argument; a returned value is sent as JSON.
     * options: { name, authorize, allowAnonymous, outputCache, schemas, openapi, constraint }
     */
    mapHandler(method, routePath, handler, options = {}) {
        if (typeof handler !== 'function') throw new TypeError('master.map.<method>(path, handler, options): handler must be a function');
        if (!this._programmatic.has('minimal')) {
            const Minimal = class MinimalApiController { constructor(requestObject) { this.requestObject = requestObject; } };
            Minimal.schemas = {}; Minimal.openapi = {}; Minimal.outputCache = {}; Minimal.authorize = {}; Minimal.allowAnonymous = [];
            this._programmatic.set('minimal', Minimal);
        }
        const Minimal = this._programmatic.get('minimal');
        const action = `m${++this._minimalSeq}`;
        Minimal.prototype[action] = handler;
        if (options.schemas) Minimal.schemas[action] = options.schemas;
        if (options.openapi) Minimal.openapi[action] = options.openapi;
        if (options.outputCache !== undefined) Minimal.outputCache[action] = options.outputCache;
        if (!this.currentRouteName || !this._routes || !this._routes[this.currentRouteName]) {
            this.setup({ root: (this._master && this._master.root) || process.cwd(), isComponent: false });
        }
        const routeOptions = { name: options.name, authorize: options.authorize, allowAnonymous: options.allowAnonymous, outputCache: options.outputCache, constraint: options.constraint, apiVersion: options.apiVersion, deprecated: options.deprecated };
        const methods = method === 'any' ? ['get', 'post', 'put', 'patch', 'delete'] : [method];
        const builder = this.start();
        for (const m of methods) builder.route(routePath, `minimal#${action}`, m, routeOptions);
        return this;
    }

    /**
     * v2.10.0 — URL generation for a named route (ASP.NET LinkGenerator / Url.Action):
     *   router.route('/items/:id(int)', 'items#show', 'get', { name: 'item' });
     *   master.urlFor('item', { id: 5 }, { query: { tab: 'info' } })  ->  '/items/5?tab=info'
     */
    urlFor(name, params = {}, { query, absolute } = {}) {
        const route = this._named.get(name);
        if (!route) throw new Error(`urlFor: no route named '${name}' (known: ${[...this._named.keys()].join(', ') || 'none'})`);
        const segs = String(route.path).split('/').map((seg) => {
            const m = seg.match(/^:([A-Za-z_$][\w$]*)(?:\(.+\))?$/);
            if (!m) return seg;
            const v = params && params[m[1]];
            if (v === undefined || v === null) throw new Error(`urlFor('${name}'): missing route parameter '${m[1]}'`);
            return encodeURIComponent(String(v));
        });
        let url = '/' + segs.filter((s, i) => !(i === 0 && s === '')).join('/');
        if (url !== '/' && url.endsWith('/')) url = url.slice(0, -1);
        if (query && typeof query === 'object') {
            const qs = Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
            if (qs) url += '?' + qs;
        }
        if (absolute) url = String(absolute).replace(/\/+$/, '') + url;
        return url;
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
             // Resolve controller from registry (pre-populated at startup),
             // with sync require() fallback for v1.x compatibility.
             Control = this._resolveController(currentRoute.root, requestObject.toController);

             if (!Control) {
                 const error = handleControllerError(
                     new Error(`Controller not found: ${requestObject.toController}Controller`),
                     requestObject.toController,
                     requestObject.toAction,
                     requestObject.pathName,
                     currentRoute.routeDef
                 );

                 sendErrorResponse(requestObject.response, error, requestObject.pathName, requestObject.request);
                 performanceTracker.end(requestId);
                 return;
             }

             tools.combineObjectPrototype(Control, this._master.controllerList);
             Control.prototype.__namespace = Control.name;
             const control = new Control(requestObject);
             // Set request-specific state on INSTANCE (not prototype) for concurrency safety
             control.__requestObject = requestObject;
             control.__currentRoute = currentRoute;
             control.__response = requestObject.response;
             control.__request = requestObject.request;
             control.state = requestObject.state || requestObject.request.__pipelineState || {};
             const _callEmit = new EventEmitter();

             _callEmit.once(EVENT_NAMES.CONTROLLER, function(){
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
                        .then((returnValue) => {
                            // Auto-send return value as JSON if controller returned data
                            // and no response was sent yet (e.g., overridden returnJson pattern)
                            if (returnValue !== undefined && returnValue !== null
                                && !requestObject.response.headersSent && !requestObject.response._headerSent) {
                                const seen = new WeakSet();
                                const json = JSON.stringify(returnValue, (key, value) => {
                                    if (typeof value === 'object' && value !== null) {
                                        if (seen.has(value)) {
                                            return '[Circular Reference]';
                                        }
                                        seen.add(value);
                                    }
                                    return value;
                                });
                                // Use status field from return value as HTTP status code if it's a valid 4xx/5xx code
                                const httpStatus = (returnValue && typeof returnValue.status === 'number' && returnValue.status >= 400 && returnValue.status <= 599)
                                    ? returnValue.status
                                    : 200;

                                requestObject.response.writeHead(httpStatus, {
                                    'Content-Type': 'application/json',
                                    'Content-Length': Buffer.byteLength(json, 'utf8')
                                });
                                requestObject.response.end(json);
                            }
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
                            sendErrorResponse(requestObject.response, mcError, requestObject.pathName, requestObject.request);
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
                    sendErrorResponse(requestObject.response, mcError, requestObject.pathName, requestObject.request);
                    performanceTracker.end(requestId);
                    // MEMORY LEAK FIX: Clean up event listeners
                    _callEmit.removeAllListeners();
                }
             });

             // v2.3.0: the caller's identity (ASP.NET HttpContext.User) is available
             // as this.user in every action / filter.
             control.user = requestObject.user || (this._master.auth ? this._master.auth.anonymous() : null);

             const proceed = () => {
                 control.user = requestObject.user || control.user;
                 // v2.5.0: IOptions<T> values + IConfiguration on the controller
                 control.options = this._master.options ? this._master.options.all() : {};
                 control.configuration = this._master.configuration || null;
                 control.environment = this._master.environment || null;
                 // v2.7.0: ILogger<T> with the controller as category
                 control.logger = (this._master.logging && typeof this._master.logging.createLogger === "function") ? this._master.logging.createLogger(Control.name || requestObject.toController) : null;
                 control.urlFor = (name, params, opts) => this.urlFor(name, params, opts);   // v2.10.0 named routes
                 // v2.11.0: API version + culture/localizer on the controller; ReportApiVersions headers
                 control.apiVersion = requestObject.apiVersion || null;
                 control.culture = requestObject.culture || null;
                 control.localizer = requestObject.localizer || null;
                 if (requestObject.__apiVersions && this._master.apiVersioning && requestObject.response && !requestObject.response.headersSent) {
                     const rh = this._master.apiVersioning.reportHeaders(requestObject.__apiVersions.supported, requestObject.__apiVersions.deprecated);
                     for (const [k, v] of Object.entries(rh)) { try { requestObject.response.setHeader(k, v); } catch (_) { /* ignore */ } }
                 }

                 const afterBind = () => {
                     const runFiltersAndAction = () => {
                     // check if before function is avaliable and wait for it to return
                     if(control.__hasBeforeAction(control, requestObject)){
                         control.__callBeforeAction(control, requestObject, _callEmit)
                             .catch((error) => {
                                 if (!requestObject.response.headersSent && !requestObject.response._headerSent) {
                                     const mcError = handleControllerError(
                                         error,
                                         requestObject.toController,
                                         requestObject.toAction,
                                         requestObject.pathName,
                                         currentRoute.routeDef
                                     );
                                     sendErrorResponse(requestObject.response, mcError, requestObject.pathName, requestObject.request);
                                 }
                                 performanceTracker.end(requestId);
                                 _callEmit.removeAllListeners();
                             });
                     }else{
                        _callEmit.emit("controller");
                     }
                     };

                     // v2.8.0: output caching ([OutputCache]) — after authorization and
                     // binding: serve a cached 200 for eligible GET/HEAD requests, else
                     // capture this response and store it when it completes.
                     const oc = this._master.outputCache;
                     const ocPolicy = oc ? oc.resolvePolicy(currentRoute.routeDef && currentRoute.routeDef.outputCache, Control, requestObject.toAction) : null;
                     if (!ocPolicy) { runFiltersAndAction(); return; }
                     oc.tryServe(requestObject, ocPolicy).then((served) => {
                         if (served) { performanceTracker.end(requestId); _callEmit.removeAllListeners(); return; }
                         try { oc.capture(requestObject, ocPolicy); } catch (_) { /* caching must never break the request */ }
                         runFiltersAndAction();
                     }).catch(() => { runFiltersAndAction(); });
                 };

                 // v2.4.0: model binding + validation (ASP.NET [ApiController]):
                 // static schemas = { action: { body, query, route } } binds this.model /
                 // this.modelState before filters run; invalid -> 400 ValidationProblemDetails
                 // unless static autoValidate = false.
                 const bindSpec = resolveControllerSchemas(Control, requestObject.toAction);
                 if (!bindSpec) { afterBind(); return; }
                 bindRequest(requestObject, bindSpec).then((bound) => {
                     control.model = bound.value;
                     control.modelState = bound.modelState;
                     requestObject.model = bound.value;
                     if (!bound.valid && Control.autoValidate !== false) {
                         writeValidationProblem(requestObject.response, bound.errors, { request: requestObject.request });
                         performanceTracker.end(requestId);
                         _callEmit.removeAllListeners();
                         return;
                     }
                     afterBind();
                 }).catch((error) => {
                     if (!requestObject.response.headersSent && !requestObject.response._headerSent) {
                         const mcError = handleControllerError(error, requestObject.toController, requestObject.toAction, requestObject.pathName, currentRoute.routeDef);
                         sendErrorResponse(requestObject.response, mcError, requestObject.pathName, requestObject.request);
                     }
                     performanceTracker.end(requestId);
                     _callEmit.removeAllListeners();
                 });
             };

             // v2.3.0: controller-level authorization (ASP.NET [Authorize] on the
             // controller class): static authorize = true | 'Policy' | { roles } |
             // { '*': spec, action: spec|false }; static allowAnonymous = true | [actions].
             // Skipped when the route itself declared { allowAnonymous: true }.
             const authSpec = requestObject.__allowAnonymous ? undefined : resolveControllerAuthorize(Control, requestObject.toAction);
             if (authSpec === undefined || !this._master.auth) {
                 proceed();
             } else {
                 this._master.auth.enforce(requestObject, authSpec).then((allowed) => {
                     if (allowed) { proceed(); return; }
                     performanceTracker.end(requestId);
                     _callEmit.removeAllListeners();
                 }).catch((error) => {
                     if (!requestObject.response.headersSent && !requestObject.response._headerSent) {
                         const mcError = handleControllerError(error, requestObject.toController, requestObject.toAction, requestObject.pathName, currentRoute.routeDef);
                         sendErrorResponse(requestObject.response, mcError, requestObject.pathName, requestObject.request);
                     }
                     performanceTracker.end(requestId);
                     _callEmit.removeAllListeners();
                 });
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
             sendErrorResponse(requestObject.response, mcError, requestObject.pathName, requestObject.request);
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

            // Normalize pathName from various request object formats
            if (!rr.pathName || typeof rr.pathName !== 'string') {
                // Try to extract pathName from standard HTTP request properties
                if (rr.request.url) {
                    // Handle full URL or path with query string (Node.js http, Express)
                    try {
                        // Try parsing as full URL first
                        const url = new URL(rr.request.url, `http://${rr.request.headers?.host || 'localhost'}`);
                        rr.pathName = url.pathname;
                    } catch (e) {
                        // Fallback: treat as relative path, strip query string
                        rr.pathName = rr.request.url.split('?')[0];
                    }
                } else if (rr.request.path) {
                    // Express-style request.path
                    rr.pathName = rr.request.path;
                } else if (rr.request.pathname) {
                    // Alternative property name
                    rr.pathName = rr.request.pathname;
                } else {
                    throw new TypeError('Request object must have a valid path (url, path, pathname, or pathName property)');
                }
            }

            // Validate that we now have a valid pathName
            if (typeof rr.pathName !== 'string') {
                throw new TypeError('Request object must have a valid pathName');
            }

            if (!rr.type || typeof rr.type !== 'string') {
                throw new TypeError('Request object must have a valid type (HTTP method)');
            }

            // Skip route processing for OPTIONS requests already handled by CORS middleware
            if (rr.type.toLowerCase() === 'options' && (rr.response.headersSent || rr.response._headerSent)) {
                return;
            }

            const $that = this;
            // FIX: Use direct reference instead of Object.create() to preserve request/response objects
            // Object.create() puts properties on prototype, causing undefined access issues
            const requestObject = rr;

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

            if(routeFound === false && requestObject.__apiVersionMismatch && this._master && this._master.apiVersioning){
                // v2.11.0: the path exists but no route serves the requested API version
                this._master.apiVersioning.writeUnsupported(requestObject, [...requestObject.__apiVersionMismatch.supported]);
                _loadEmit.removeAllListeners();
                return;
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
                sendErrorResponse(requestObject.response, mcError, requestObject.pathName, requestObject.request);
                // MEMORY LEAK FIX: Clean up event listeners if route not found
                _loadEmit.removeAllListeners();
            }

    }
    
}

export { MasterRouter, sanitizeRouteParam };