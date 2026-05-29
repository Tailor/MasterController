// MasterControl - by Alexander rich
// version 1.0.252

import url from 'node:url';
import fileserver from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto'; // For ETag generation
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import MasterAction from './MasterAction.js';
import MasterActionFilters from './MasterActionFilters.js';
import SecurityEnforcement from './security/SecurityEnforcement.js';
import { MasterPipeline } from './MasterPipeline.js';
import { MasterTimeout } from './MasterTimeout.js';
import { MasterRouter } from './MasterRouter.js';
import { MasterRequest } from './MasterRequest.js';
import { MasterCors } from './MasterCors.js';
import { MasterSocket } from './MasterSocket.js';
import { MasterTemp } from './MasterTemp.js';
import { MasterSessionSecurity } from './security/SessionSecurity.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// HTTP Status Code Constants
const HTTP_STATUS = {
    OK: 200,
    MOVED_PERMANENTLY: 301,
    FOUND: 302,
    NOT_MODIFIED: 304,
    BAD_REQUEST: 400,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    PAYLOAD_TOO_LARGE: 413,
    INTERNAL_ERROR: 500
};

// Enhanced error handling - setup global handlers
import { setupGlobalErrorHandlers } from './error/MasterErrorMiddleware.js';
import { logger } from './error/MasterErrorLogger.js';

// Security - Initialize security features
import { security, securityHeaders } from './security/SecurityMiddleware.js';
import { csp } from './security/CSPConfig.js';
import { session } from './security/SessionSecurity.js';

// Initialize global error handling
setupGlobalErrorHandlers();

// Log framework start
logger.info({
    code: 'MC_INFO_FRAMEWORK_START',
    message: 'MasterController framework initializing',
    context: {
        version: '1.0.247',
        nodeVersion: process.version,
        platform: process.platform,
        env: process.env.NODE_ENV || 'development'
    }
});

// Log security status
const isProduction = process.env.NODE_ENV === 'production';
logger.info({
    code: 'MC_INFO_SECURITY_INITIALIZED',
    message: 'Security features initialized',
    context: {
        environment: isProduction ? 'production' : 'development',
        features: {
            securityHeaders: true,
            csp: csp.enabled,
            csrf: security.csrfEnabled,
            rateLimit: security.rateLimitEnabled,
            sessionSecurity: true
        }
    }
});


class MasterControl {
    controllerList = {}
    viewList = {}
    requestList = {}
    _root = null
    _environmentType = null
    _serverProtocol = null
    _scopedList = []
    _loadedFunc = null
    _tlsOptions = null
    _hstsEnabled = false
    _hstsMaxAge = 31536000 // 1 year default
    _hstsIncludeSubDomains = true
    _hstsPreload = false
    _viewEngine = null // Pluggable view engine (MasterView, EJS, Pug, etc.)

    // Root directory for static file serving. Only files physically present
    // under this directory are servable as static assets — URL pattern is never
    // consulted. Same model as ASP.NET wwwroot / Rails public/ / express.static.
    //
    // Defaults to null. When unset the static-file middleware resolves to
    // master.root for backward compatibility. Production apps should set this
    // to a dedicated public directory so source files (server.js, config/,
    // app/) aren't reachable via URL:
    //   master.staticRoot = path.join(master.root, 'public');
    staticRoot = null

    #loadTransientListClasses(name, params){
        Object.defineProperty(this.requestList, name, {
            get: function() { 
              return  new params();
            }
          });
    }

    get env(){
        // Lazy-load on first access, then cache. Read with fs+JSON.parse instead
        // of require() so this works identically in CJS and ESM (Phase 4).
        if (this._envCache !== undefined) {
            return this._envCache;
        }
        const envPath = `${this.root}/config/environments/env.${this.environmentType}.json`;
        try {
            this._envCache = JSON.parse(fs.readFileSync(envPath, 'utf8'));
        } catch (err) {
            logger.error({
                code: 'MC_ENV_LOAD_FAILED',
                message: `Failed to load environment config: ${envPath}`,
                error: err.message
            });
            this._envCache = {};
        }
        return this._envCache;
    }

    /**
     * @param {string} type
     */
    set serverProtocol(type){
        this._serverProtocol = type ===  undefined ? "http": type;
    }

    get serverProtocol(){
        return this._serverProtocol;
    }

    /**
     * @param {any} root
     */
    set root(root){
        this._root = root ===  undefined ? global.__basedir : root;
    }

    get root(){
        return this._root;
    }

    /**
     * @param {any} env
     */
    set environmentType(env){
        this._environmentType = env === undefined ? "development" : env;
    }

    get environmentType(){
        return this._environmentType;
    }

    // this extends master framework - adds your class to main master class object
    extend(name, element){
        this[name] = new element()
    }

    loaded(func){
        if (typeof func === 'function') {
           this._loadedFunc = func;
        }
    }

    /**
     * Initialize prototype pollution protection
     * SECURITY: Prevents malicious modification of Object/Array prototypes
     */
    _initPrototypePollutionProtection() {
        // Only freeze in production to allow for easier debugging in development
        const isProduction = process.env.NODE_ENV === 'production';

        // NOTE: Prototype freezing was removed. Freezing Object.prototype/Array.prototype/
        // Function.prototype breaks third-party libraries (e.g., long, mysql2) that define
        // properties on their prototypes after framework init. Prototype pollution protection
        // is handled via input validation in MasterValidator.js instead.

        // Add prototype pollution detection utility
        this._detectPrototypePollution = (obj) => {
            if (!obj || typeof obj !== 'object') {
                return false;
            }

            const dangerousKeys = ['__proto__', 'constructor', 'prototype'];

            for (const key of dangerousKeys) {
                if (key in obj) {
                    logger.error({
                        code: 'MC_SECURITY_PROTOTYPE_POLLUTION',
                        message: `Prototype pollution detected: ${key} in object`,
                        severity: 'CRITICAL'
                    });
                    return true;
                }
            }

            return false;
        };

        logger.info({
            code: 'MC_INFO_PROTOTYPE_PROTECTION',
            message: 'Prototype pollution protection initialized'
        });
    }

    // extends class methods to be used inside of the view class using the THIS keyword
    extendView( name, element){
        element = new element();
        const propertyNames = Object.getOwnPropertyNames(element.__proto__);
        this.viewList[name] = {};

        // Fixed: Use for...of instead of for...in for array iteration
        // Filter out 'constructor' and iterate efficiently
        for (const propName of propertyNames) {
            if (propName !== "constructor") {
                this.viewList[name][propName] = element[propName];
            }
        }
    }

    // extends class methods to be used inside of the controller class using the THIS keyword
    extendController(element){
        element = new element();
        const propertyNames = Object.getOwnPropertyNames(element.__proto__);

        // Fixed: Use for...of instead of for...in for array iteration
        // Filter out 'constructor' and iterate efficiently
        for (const propName of propertyNames) {
            if (propName !== "constructor") {
                this.controllerList[propName] = element[propName];
            }
        }
    }

    /**
     * Register a view engine (MasterView, React, EJS, Pug, etc.)
     * This allows for pluggable view rendering
     *
     * @param {Object|Function} ViewEngine - View engine class or instance
     * @param {Object} options - Configuration options for the view engine
     * @returns {MasterControl} - Returns this for chaining
     *
     * @example
     * // Use MasterView (official view engine)
     * const MasterView = require('masterview');
     * master.useView(MasterView, { ssr: true });
     *
     * @example
     * // Use EJS adapter
     * const EJSAdapter = require('./adapters/ejs');
     * master.useView(EJSAdapter);
     */
    useView(ViewEngine, options = {}) {
        if (typeof ViewEngine === 'function') {
            this._viewEngine = new ViewEngine(options);
        } else {
            this._viewEngine = ViewEngine;
        }

        // Let the view engine register itself
        if (this._viewEngine && this._viewEngine.register) {
            this._viewEngine.register(this);
        }

        logger.info({
            code: 'MC_INFO_VIEW_ENGINE_REGISTERED',
            message: 'View engine registered',
            engine: ViewEngine.name || 'Custom'
        });

        return this;
    }

    /*
    Services are created each time they are requested. 
    It gets a new instance of the injected object, on each request of this object. 
    For each time you inject this object is injected in the class, it will create a new instance.
    */
    addTransient(name, params){
        if(name && params){
            this.#loadTransientListClasses(name, params);
        }
       
    }

        /*
        Services are created on each request (once per request). This is most recommended for WEB applications. 
        So for example, if during a request you use the same dependency injection, 
        in many places, you will use the same instance of that object, 
        it will make reference to the same memory allocation
        */
    addScoped(name, params){
        if(name && params){
         this._scopedList[name] =  params;
        }
    }

    /*
    Services are created once for the lifetime of the application. It uses the same instance for the whole application.
    */
    addSingleton(name, params){
        if(name && params){
            this.requestList[name] = new params();
        }
    }

    // adds your class instance to the request object.
    register(name, params){
        if(name && params){
            this.requestList[name] = params;
        }
    }

    async component(folderLocation, innerFolder){

        // Enhanced: Support both relative (to master.root) and absolute paths
        let rootFolderLocation;
        if (path.isAbsolute(folderLocation)) {
            rootFolderLocation = path.join(folderLocation, innerFolder);
        } else {
            rootFolderLocation = path.join(this.root, folderLocation, innerFolder);
        }

        // Structure is always: {rootFolderLocation}/config/initializers/config.js
        const configPath = path.join(rootFolderLocation, 'config', 'initializers', 'config.js');
        if (fs.existsSync(configPath)) {
            await import(url.pathToFileURL(configPath).href);
        } else {
            logger.error({
                code: 'MC_ERR_CONFIG_NOT_FOUND',
                message: 'Cannot find config file',
                path: configPath
            });
        }

        // Structure is always: {rootFolderLocation}/config/routes.js
        const routePath = path.join(rootFolderLocation, 'config', 'routes.js');
        const routeObject = {
            isComponent: true,
            root: rootFolderLocation
        };
        this.router.setup(routeObject);
        if (fs.existsSync(routePath)) {
            await import(url.pathToFileURL(routePath).href);
        } else {
            logger.error({
                code: 'MC_ERR_ROUTES_NOT_FOUND',
                message: 'Cannot find routes file',
                path: routePath
            });
        }

        // Pre-populate component controllers into the registry.
        await this.router.discoverControllers(rootFolderLocation);
    }


    // adds all the server settings needed
    serverSettings(settings){
        // Defensive: Check if server exists (may be called before master.start())
        if (!this.server) {
            console.warn('[MasterControl] serverSettings() called before master.start(server). Settings will be applied when server is set.');
            // Store settings to apply later
            this._pendingServerSettings = settings;
            return;
        }

        if(settings.httpPort || settings.requestTimeout){
            this.server.timeout = settings.requestTimeout;
            const host =settings.hostname || settings.host || settings.http;
            if(host){
                this.server.listen(settings.httpPort, host);
            }else{
                this.server.listen(settings.httpPort);
            }
        }
        else{
            throw "HTTP, HTTPS, HTTPPORT and REQUEST TIMEOUT MISSING";
        }

    }

    /**
     * Enable HSTS (HTTP Strict Transport Security) for HTTPS
     * Should only be called for production HTTPS servers
     *
     * @param {Object} options - HSTS configuration options
     * @param {Number} options.maxAge - Max age in seconds (default: 31536000 = 1 year)
     * @param {Boolean} options.includeSubDomains - Include subdomains (default: true)
     * @param {Boolean} options.preload - Enable HSTS preload (default: false)
     * @returns {MasterControl} - Returns this for chaining
     *
     * @example
     * // Basic usage (1 year, includeSubDomains)
     * master.enableHSTS();
     *
     * // Custom configuration
     * master.enableHSTS({
     *     maxAge: 15552000,        // 180 days
     *     includeSubDomains: true,
     *     preload: true            // Submit to HSTS preload list
     * });
     */
    enableHSTS(options = {}) {
        this._hstsEnabled = true;
        this._hstsMaxAge = options.maxAge || 31536000; // 1 year default (matches industry standard)
        this._hstsIncludeSubDomains = options.includeSubDomains !== false; // true by default
        this._hstsPreload = options.preload === true; // false by default

        console.log(`[MasterControl] HSTS enabled: max-age=${this._hstsMaxAge}${this._hstsIncludeSubDomains ? ', includeSubDomains' : ''}${this._hstsPreload ? ', preload' : ''}`);

        return this; // Chainable
    }

    useHTTPServer(port, func){
        if (typeof func === 'function') {
            http.createServer(function (req, res) {
                func(req, res);
            }).listen(port);
        }
    }

    // sets up https or http server protocals
    setupServer(type, credentials ){
        try {
            const $that = this;

            // SECURITY: Initialize prototype pollution protection
            this._initPrototypePollutionProtection();

            // Construct child modules with explicit dependency injection.
            // ESM imports are at the top of this file, so the previous dynamic
            // require() loop is gone. Order doesn't matter — DI breaks any cycles.
            $that.pipeline = new MasterPipeline($that);
            $that.timeout = new MasterTimeout($that);
            $that.router = new MasterRouter($that);
            $that.request = new MasterRequest($that);
            $that.cors = new MasterCors($that);
            $that.socket = new MasterSocket($that);
            $that.tempdata = new MasterTemp($that);
            $that.session = new MasterSessionSecurity($that);

            // Bind master to static-based modules (MasterAction, MasterActionFilters)
            // These can't use constructor injection because user controllers extend them.
            // Register them as controller extensions immediately afterward (this previously
            // happened inside setImmediate() inside each module — now explicit and synchronous).
            try {
                if (MasterAction && typeof MasterAction.bindMaster === 'function') {
                    MasterAction.bindMaster($that);
                    if (typeof $that.extendController === 'function') {
                        $that.extendController(MasterAction);
                    }
                }
                if (MasterActionFilters && typeof MasterActionFilters.bindMaster === 'function') {
                    MasterActionFilters.bindMaster($that);
                    if (typeof $that.extendController === 'function') {
                        $that.extendController(MasterActionFilters);
                    }
                }
                if (SecurityEnforcement && typeof SecurityEnforcement.bindMaster === 'function') {
                    SecurityEnforcement.bindMaster($that);
                    if (typeof $that.extend === 'function') {
                        $that.extend('securityEnforcement', SecurityEnforcement);
                    }
                }
            } catch (e) {
                console.error('[MasterControl] Failed to bind master to action modules:', e.message);
            }

            // BACKWARD COMPATIBILITY: Alias master.sessions → master.session (v1.3.4)
            // Legacy code uses master.sessions (plural), new API uses master.session (singular)
            $that.sessions = $that.session;

            // Controller extension modules (MasterAction, MasterActionFilters)
            // are imported at the top of this file. They register themselves explicitly
            // via bindMaster() above. No additional require() needed.

            // Initialize global error handlers
            setupGlobalErrorHandlers();

            // Register core middleware that must run for framework to function
            $that._registerCoreMiddleware();

            if(type === "http"){
                $that.serverProtocol = "http";
                const server = http.createServer(async function(req, res) {
                    await $that.serverRun(req, res);
                });
                // Set server immediately so config can access it
                $that.server = server;
                return server;
            }
            if(type === "https"){
                $that.serverProtocol = "https";
                // Initialize TLS from env if no credentials passed
                if(!credentials){
                    $that._initializeTlsFromEnv();
                    credentials = $that._tlsOptions;
                }
                // Apply secure defaults if missing (2026 security standards)
                if(credentials){
                    // Default to TLS 1.3 for security (2026 standard)
                    // TLS 1.2 still supported but not default
                    if(!credentials.minVersion){
                        credentials.minVersion = 'TLSv1.3';
                        console.log('[MasterControl] TLS 1.3 enabled by default (recommended for 2026)');
                    }

                    // Secure cipher suites (Mozilla Intermediate configuration - 2026)
                    // Supports TLS 1.3 and TLS 1.2 for backward compatibility
                    if(!credentials.ciphers){
                        credentials.ciphers = [
                            // TLS 1.3 cipher suites (strongest)
                            'TLS_AES_256_GCM_SHA384',
                            'TLS_CHACHA20_POLY1305_SHA256',
                            'TLS_AES_128_GCM_SHA256',
                            // TLS 1.2 cipher suites (backward compatibility)
                            'ECDHE-ECDSA-AES256-GCM-SHA384',
                            'ECDHE-RSA-AES256-GCM-SHA384',
                            'ECDHE-ECDSA-CHACHA20-POLY1305',
                            'ECDHE-RSA-CHACHA20-POLY1305',
                            'ECDHE-ECDSA-AES128-GCM-SHA256',
                            'ECDHE-RSA-AES128-GCM-SHA256'
                        ].join(':');
                        console.log('[MasterControl] Secure cipher suites configured (Mozilla Intermediate)');
                    }

                    if(credentials.honorCipherOrder === undefined){ credentials.honorCipherOrder = true; }
                    if(!credentials.ALPNProtocols){ credentials.ALPNProtocols = ['h2', 'http/1.1']; }
                    const server = https.createServer(credentials, async function(req, res) {
                        await $that.serverRun(req, res);
                    });
                    // Set server immediately so config can access it
                    $that.server = server;
                    return server;
                }else{
                    throw "Credentials needed to setup https"
                }
            }
        }
        catch(error){
            console.error("Failed to setup server:", error);
            throw error;
        }
    }

    /**
     * Creates an HTTP server that 301-redirects to HTTPS counterpart
     * SECURITY: Validates host header to prevent open redirect attacks
     *
     * @param {Number} redirectPort - Port to listen on (usually 80)
     * @param {String} bindHost - Host to bind to (e.g., '0.0.0.0')
     * @param {Array<String>} allowedHosts - Whitelist of allowed hostnames (REQUIRED for security)
     * @returns {http.Server} - HTTP server instance
     *
     * @example
     * // Production usage (MUST specify allowed hosts)
     * const redirectServer = master.startHttpToHttpsRedirect(80, '0.0.0.0', [
     *     'example.com',
     *     'www.example.com',
     *     'api.example.com'
     * ]);
     *
     * @security CRITICAL: Always provide allowedHosts in production to prevent open redirect attacks
     */
    startHttpToHttpsRedirect(redirectPort, bindHost, allowedHosts = []){
        const $that = this;

        // Security warning if no hosts specified
        if (allowedHosts.length === 0) {
            console.warn('[MasterControl] ⚠️  SECURITY WARNING: startHttpToHttpsRedirect() called without allowedHosts.');
            console.warn('[MasterControl] This is vulnerable to open redirect attacks. Specify allowed hosts:');
            console.warn('[MasterControl] master.startHttpToHttpsRedirect(80, "0.0.0.0", ["example.com", "www.example.com"])');
        }

        return http.createServer(function (req, res) {
            try{
                const host = req.headers['host'] || '';
                const hostname = host.split(':')[0]; // Remove port number

                // CRITICAL SECURITY: Validate host header to prevent open redirect attacks
                if (allowedHosts.length > 0) {
                    if (!allowedHosts.includes(hostname)) {
                        logger.warn({
                            code: 'MC_SECURITY_INVALID_HOST',
                            message: 'HTTP redirect blocked: invalid host header',
                            host: hostname,
                            ip: req.connection.remoteAddress
                        });
                        res.statusCode = 400;
                        res.setHeader('Content-Type', 'text/plain');
                        res.end('Bad Request: Invalid host header');
                        return;
                    }
                }

                // Redirect to HTTPS with validated host
                var location = 'https://' + host + req.url;
                res.statusCode = 301;
                res.setHeader('Location', location);
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.end();
            }catch(e){
                logger.error({
                    code: 'MC_ERR_REDIRECT',
                    message: 'HTTP to HTTPS redirect failed',
                    error: e.message,
                    stack: e.stack
                });
                res.statusCode = 500;
                res.end();
            }
        }).listen(redirectPort, bindHost);
    }

    // Load TLS configuration from env and build SNI contexts with live reload
    _initializeTlsFromEnv(){
        try{
            var cfg = this.env;
            if(!cfg || !cfg.server || !cfg.server.tls){
                return;
            }
            var tlsCfg = cfg.server.tls;

            var defaultCreds = this._buildSecureContextFromPaths(tlsCfg.default);
            var defaultContext = defaultCreds ? tls.createSecureContext(defaultCreds) : null;

            var sniMap = {};
            if(tlsCfg.sni && typeof tlsCfg.sni === 'object'){
                for (var domain in tlsCfg.sni){
                    if (Object.prototype.hasOwnProperty.call(tlsCfg.sni, domain)){
                        var domCreds = this._buildSecureContextFromPaths(tlsCfg.sni[domain]);
                        if(domCreds){
                            sniMap[domain] = tls.createSecureContext(domCreds);
                            // watch domain certs for reload
                            this._watchTlsFilesAndReload(tlsCfg.sni[domain], function(){
                                try{
                                    var updated = tls.createSecureContext(
                                        this._buildSecureContextFromPaths(tlsCfg.sni[domain])
                                    );
                                    sniMap[domain] = updated;
                                }catch(e){
                                    console.error('Failed to reload TLS context for domain', domain, e);
                                }
                            }.bind(this));
                        }
                    }
                }
            }

            var options = defaultCreds ? Object.assign({}, defaultCreds) : {};
            options.SNICallback = function(servername, cb){
                var ctx = sniMap[servername];
                if(!ctx && defaultContext){ ctx = defaultContext; }
                if(cb){ return cb(null, ctx); }
                return ctx;
            };

            // Apply top-level TLS defaults/hardening from env if provided
            if(tlsCfg.minVersion){ options.minVersion = tlsCfg.minVersion; }
            if(tlsCfg.honorCipherOrder !== undefined){ options.honorCipherOrder = tlsCfg.honorCipherOrder; }
            if(tlsCfg.ciphers){ options.ciphers = tlsCfg.ciphers; }
            if(tlsCfg.alpnProtocols){ options.ALPNProtocols = tlsCfg.alpnProtocols; }

            // HSTS
            this._hstsEnabled = !!tlsCfg.hsts;
            this._hstsMaxAge = tlsCfg.hstsMaxAge || 15552000; // 180 days by default

            // Watch default certs for reload
            if(tlsCfg.default){
                this._watchTlsFilesAndReload(tlsCfg.default, function(){
                    try{
                        var updatedCreds = this._buildSecureContextFromPaths(tlsCfg.default);
                        defaultContext = tls.createSecureContext(updatedCreds);
                        // keep key/cert on options for non-SNI connections
                        Object.assign(options, updatedCreds);
                    }catch(e){
                        console.error('Failed to reload default TLS context', e);
                    }
                }.bind(this));
            }

            this._tlsOptions = options;
        }catch(e){
            console.error('Failed to initialize TLS from env', e);
        }
    }

    _buildSecureContextFromPaths(desc){
        if(!desc){ return null; }
        var opts = {};
        try{
            if(desc.keyPath){ opts.key = fs.readFileSync(desc.keyPath); }
            if(desc.certPath){ opts.cert = fs.readFileSync(desc.certPath); }
            if(desc.caPath){ opts.ca = fs.readFileSync(desc.caPath); }
            if(desc.pfxPath){ opts.pfx = fs.readFileSync(desc.pfxPath); }
            if(desc.passphrase){ opts.passphrase = desc.passphrase; }
            return opts;
        }catch(e){
            console.error('Failed to read TLS files', e);
            return null;
        }
    }

    _watchTlsFilesAndReload(desc, onChange){
        var paths = [];
        if(desc.keyPath){ paths.push(desc.keyPath); }
        if(desc.certPath){ paths.push(desc.certPath); }
        if(desc.caPath){ paths.push(desc.caPath); }
        if(desc.pfxPath){ paths.push(desc.pfxPath); }
        paths.forEach(function(p){
            try{
                fs.watchFile(p, { interval: 5000 }, function(){
                    onChange();
                });
            }catch(e){
                console.error('Failed to watch TLS file', p, e);
            }
        });
    }

    /**
     * Register core middleware that must run for the framework to function
     * This includes: static files, body parsing, scoped services, routing, error handling
     */
    _registerCoreMiddleware(){
        const $that = this;

        // 1. Static File Serving (with path traversal protection)
        $that.pipeline.use(async (ctx, next) => {
            // Static file serving — ASP.NET / Rails / Express model.
            //
            // The gate is "does the URL resolve to a real file under
            // master.staticRoot?" — NOT URL pattern matching. This means:
            //   - /api/customer.listMyEngagements → no such file → next() to router
            //   - /css/site.css → file exists → served as static
            //   - /api/users → no such file → next() to router
            //
            // URL never determines static-vs-dynamic. Filesystem does.
            const staticRoot = path.resolve($that.staticRoot || $that.root || '.');
            const requestedPath = ctx.request.url.split('?')[0].split('#')[0];
            const safePath = path.join(staticRoot, requestedPath);
            const resolvedPath = path.resolve(safePath);

            // SECURITY: Reject path-traversal escapes from the static root.
            // Treated as a real security event (logged), but we still fall
            // through to the router rather than 403 — the router may have a
            // legitimate route at the requested URL, and the path traversal
            // only matters to static file serving.
            if (!resolvedPath.startsWith(staticRoot)) {
                logger.warn({
                    code: 'MC_SECURITY_PATH_TRAVERSAL',
                    message: 'Path traversal attempt blocked from static serving',
                    requestedPath: requestedPath,
                    resolvedPath: resolvedPath,
                    ip: ctx.request.connection.remoteAddress
                });
                return next();
            }

            // SECURITY: Refuse to serve dotfiles (.env, .git, .htaccess).
            // Same fall-through rationale — the router may have a legitimate
            // dynamic route at that URL.
            const filename = path.basename(resolvedPath);
            if (filename.startsWith('.')) {
                logger.warn({
                    code: 'MC_SECURITY_DOTFILE_BLOCKED',
                    message: 'Dotfile access blocked from static serving',
                    filename: filename,
                    ip: ctx.request.connection.remoteAddress
                });
                return next();
            }

            // File-existence check is THE gate. If nothing is at this path
            // (or it's not a regular file / index'd directory), fall through.
            let stats;
            try {
                stats = fs.statSync(resolvedPath);
            } catch (_) {
                return next(); // not a static file → routing's turn
            }

            // Resolve directory → index.html or fall through.
            let finalPath = resolvedPath;
            if (stats.isDirectory()) {
                finalPath = path.join(resolvedPath, 'index.html');
                try {
                    stats = fs.statSync(finalPath);
                } catch (_) {
                    return next(); // no index.html in this directory → routing's turn
                }
            }

            if (!stats.isFile()) {
                return next();
            }

            try {

                    // CRITICAL FIX: Stream large files instead of reading into memory
                    // Files >1MB are streamed to prevent memory exhaustion and improve performance
                    const STREAM_THRESHOLD = 1 * 1024 * 1024; // 1MB
                    const fileSize = stats.size;
                    const ext = path.extname(finalPath);
                    const mimeType = $that.router.findMimeType(ext);

                    // ETag format: "size-mtime" (weak ETag for better performance)
                    const etag = `W/"${stats.size}-${stats.mtime.getTime()}"`;

                    // CRITICAL FIX: Check If-None-Match header for 304 Not Modified
                    const clientETag = ctx.request.headers['if-none-match'];
                    if (clientETag === etag) {
                        // File hasn't changed, return 304 Not Modified
                        logger.debug({
                            code: 'MC_STATIC_304',
                            message: 'Returning 304 Not Modified',
                            path: finalPath,
                            etag: etag
                        });
                        ctx.response.statusCode = 304;
                        ctx.response.setHeader('ETag', etag);
                        ctx.response.end();
                        return;
                    }

                    // Set common headers for both streaming and buffered responses
                    ctx.response.setHeader('Content-Type', mimeType || 'application/octet-stream');
                    ctx.response.setHeader('X-Content-Type-Options', 'nosniff');
                    ctx.response.setHeader('Content-Length', fileSize);

                    // CRITICAL FIX: Add caching headers
                    ctx.response.setHeader('ETag', etag);
                    ctx.response.setHeader('Last-Modified', stats.mtime.toUTCString());

                    // Cache-Control based on file type
                    const cacheableExtensions = ['.js', '.css', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.ico'];
                    const isCacheable = cacheableExtensions.includes(ext.toLowerCase());

                    if (isCacheable) {
                        // PERFORMANCE: Cache static assets for 1 year (immutable pattern)
                        // Use versioned URLs (e.g., app.v123.js) for cache-busting
                        ctx.response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                    } else {
                        // SECURITY: Dynamic content should revalidate
                        ctx.response.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
                    }

                    if (fileSize > STREAM_THRESHOLD) {
                        // PERFORMANCE: Stream large files (>1MB) to avoid memory issues
                        logger.debug({
                            code: 'MC_STATIC_STREAMING',
                            message: 'Streaming large static file',
                            path: finalPath,
                            size: fileSize
                        });

                        const readStream = fs.createReadStream(finalPath);

                        readStream.on('error', (err) => {
                            logger.error({
                                code: 'MC_ERR_STREAM_READ',
                                message: 'Error streaming static file',
                                path: finalPath,
                                error: err.message
                            });

                            // Only send error if headers not sent
                            if (!ctx.response.headersSent) {
                                ctx.response.statusCode = 500;
                                ctx.response.setHeader('Content-Type', 'text/plain');
                                ctx.response.end('Internal Server Error');
                            } else {
                                // Connection already started, just close it
                                ctx.response.end();
                            }
                        });

                        // Pipe the file stream to the response
                        readStream.pipe(ctx.response);

                    } else {
                        // PERFORMANCE: Small files (<1MB) can be buffered for better caching
                        fs.readFile(finalPath, function(err, data) {
                            if (err) {
                                logger.error({
                                    code: 'MC_ERR_FILE_READ',
                                    message: 'Error reading static file',
                                    path: finalPath,
                                    error: err.message
                                });
                                ctx.response.statusCode = 500;
                                ctx.response.setHeader('Content-Type', 'text/plain');
                                ctx.response.end('Internal Server Error');
                            } else {
                                ctx.response.end(data);
                            }
                        });
                    }
            } catch (error) {
                // Failure DURING serving (read/stream error after we've decided
                // the file exists). Not the same as "no such file" — this is an
                // actual error reading a file that's there. Surface it as 500.
                logger.error({
                    code: 'MC_ERR_FILE_SERVE',
                    message: 'Error serving static file',
                    path: resolvedPath,
                    error: error.message
                });
                if (!ctx.response.headersSent) {
                    ctx.response.statusCode = 500;
                    ctx.response.setHeader('Content-Type', 'text/plain');
                    ctx.response.end('Internal Server Error');
                }
                return;
            }
            // Note: when a file IS served, we return early inside the try{} above
            // (via .end() / .pipe()). We never reach here in the served-file path.
        });

        // 2. Timeout Tracking (optional - disabled by default until init)
        // Will be configured by user in config.js with master.timeout.init()
        // This is just a placeholder registration - actual timeout is set in user config

        // 3. Request Body Parsing (always needed)
        $that.pipeline.use(async (ctx, next) => {
            // Parse body using MasterRequest
            // Pass entire context for backward compatibility (v1.3.x)
            // getRequestParam() will extract request and requrl from context
            const params = await $that.request.getRequestParam(ctx, ctx.response);

            // Merge parsed params into context
            if (params && params.query) {
                ctx.params.query = params.query;
            }
            if (params && params.formData) {
                ctx.params.formData = params.formData;
            }

            if (typeof next === 'function') await next();
        });

        // 4. Load Scoped Services (per request - always needed)
        // Cache keys for performance (computed once, not on every request)
        const scopedKeys = Object.keys($that._scopedList);

        $that.pipeline.use(async (ctx, next) => {
            // Fixed: Use cached keys with direct array iteration (faster & safer)
            for (let i = 0; i < scopedKeys.length; i++) {
                const key = scopedKeys[i];
                const className = $that._scopedList[key];
                $that.requestList[key] = new className();
            }
            if (typeof next === 'function') await next();
        });

        // 4. HSTS Header (if enabled for HTTPS)
        $that.pipeline.use(async (ctx, next) => {
            if ($that.serverProtocol === 'https' && $that._hstsEnabled) {
                // Use configured HSTS values (not hardcoded)
                let hstsValue = `max-age=${$that._hstsMaxAge}`;
                if ($that._hstsIncludeSubDomains) {
                    hstsValue += '; includeSubDomains';
                }
                if ($that._hstsPreload) {
                    hstsValue += '; preload';
                }
                ctx.response.setHeader('Strict-Transport-Security', hstsValue);
            }
            if (typeof next === 'function') await next();
        });

        // 5. Routing and Error Handler are registered in start() so that user
        // middleware (auth, logging, etc.) registered between setupServer() and
        // start() runs BEFORE the terminal routing middleware.
    }

    async serverRun(req, res){
        const $that = this;
        console.log("path", `${req.method} ${req.url}`);

        try {
            const parsedUrl = url.parse(req.url);
            const pathname = parsedUrl.pathname;

            // ctx.isStatic intentionally not set. Static vs dynamic dispatch is
            // decided by the static-file middleware based on whether the URL
            // resolves to an actual file under master.staticRoot, NOT by URL
            // pattern. URLs with dots in path segments (e.g.
            // /api/customer.listMyEngagements) flow through to the router
            // correctly because there's no file at that path.
            const context = {
                request: req,
                response: res,
                requrl: url.parse(req.url, true),
                pathName: pathname.replace(/^\/|\/$/g, '').toLowerCase(),
                type: req.method.toLowerCase(),
                params: {},
                state: {},
                master: $that
            };

            await $that.pipeline.execute(context);
        } catch (error) {
            console.error('Pipeline execution failed:', error);
            if (!res.headersSent) {
                res.statusCode = 500;
                res.end('Internal Server Error');
            }
        }

    } // end serverRun()

    async start(server){
        this.server = server;

        // Crash immediately on fatal listen-time errors (EADDRINUSE, EACCES, etc.)
        // so a port-in-use never silently turns into "boot succeeded".
        //
        // Why prependListener: a user might add their own server.on('error', ...)
        // handler. If theirs runs first and just logs, Node treats the event as
        // handled and uncaughtException never fires — the process keeps running
        // with a non-listening server. Prepending guarantees we see the error
        // first and decide whether it's fatal regardless of what the user added.
        //
        // Why a flag instead of removing the listener after listening: runtime
        // errors (post-listen, e.g. a request handler throw) should NOT crash
        // the process. The flag lets us distinguish "before listen" (fatal)
        // from "after listen" (recoverable).
        let __isListening = false;
        server.once('listening', () => { __isListening = true; });
        server.prependListener('error', (err) => {
            if (__isListening) {
                // Post-listen runtime error — log and let the application decide.
                logger.error({
                    code: 'MC_SERVER_RUNTIME_ERROR',
                    message: `Server runtime error: ${err.message}`,
                    error: err.code,
                    stack: err.stack
                });
                return;
            }
            // Pre-listen error — fatal. Surface clearly and exit so process
            // managers (PM2, systemd, Docker) know the boot failed.
            const detail = err.code === 'EADDRINUSE'
                ? `Port ${err.port} is already in use. Stop the other process or pick a different port.`
                : err.code === 'EACCES'
                ? `Permission denied binding port ${err.port} (ports < 1024 require root or CAP_NET_BIND_SERVICE).`
                : err.message;
            try {
                process.stderr.write(`\n[MasterController] FATAL: server failed to start — ${err.code || 'unknown error'}\n  ${detail}\n\n`);
            } catch (_) {}
            logger.fatal({
                code: 'MC_SERVER_LISTEN_FAILED',
                message: `Server listen failed: ${err.code || err.message}`,
                error: err.code,
                detail: detail,
                stack: err.stack
            });
            process.exit(1);
        });

        // Apply any pending server settings that were called before start()
        if (this._pendingServerSettings) {
            console.log('[MasterControl] Applying pending server settings');
            this.serverSettings(this._pendingServerSettings);
            this._pendingServerSettings = null;
        }

        // Register terminal routing and error handler LAST so that user middleware
        // (auth, logging, etc.) registered between setupServer() and start() runs first
        const $that = this;

        // Pre-load config/load module ONCE at startup. ESM dynamic import
        // is async — start() is async to handle this.
        //
        // Distinguish "file doesn't exist" (legitimate skip in v2.0+ where
        // config/load.js is optional) from "file exists but failed to load"
        // (a real bug we must surface, not demote to a warning).
        let configLoadFn = null;
        const configLoadPath = `${$that.root}/config/load.js`;
        if (fs.existsSync(configLoadPath)) {
            try {
                const mod = await import(url.pathToFileURL(configLoadPath).href);
                configLoadFn = mod.default ?? mod;
            } catch (err) {
                logger.error({
                    code: 'MC_CONFIG_LOAD_FAILED',
                    message: `config/load.js exists at ${configLoadPath} but failed to load`,
                    error: err.message,
                    stack: err.stack
                });
                throw err; // critical — do not silently continue with a broken config/load.js
            }
        }
        // If the file doesn't exist, we silently skip — v2.0+ doesn't require it.

        // Terminal routing middleware.
        // If the user provides config/load.js, we call it (legacy hook for CORS etc).
        // Otherwise we dispatch to the router directly — v2.0 makes config/load.js
        // optional so the simplest "hello world" works without it.
        $that.pipeline.run(async (ctx) => {
            ctx.request.__pipelineState = ctx.state;
            if (configLoadFn) {
                configLoadFn(ctx);
            } else if ($that.router && typeof $that.router.load === 'function') {
                $that.router.load(ctx);
            }
        });

        // Global error handler
        $that.pipeline.useError(async (error, ctx, next) => {
            logger.error({
                code: 'MC_ERR_PIPELINE',
                message: 'Error in middleware pipeline',
                error: error.message,
                stack: error.stack,
                path: ctx.request.url,
                method: ctx.type
            });

            if (!ctx.response.headersSent) {
                ctx.response.statusCode = 500;
                ctx.response.setHeader('Content-Type', 'application/json');
                ctx.response.end(JSON.stringify({
                    error: 'Internal Server Error',
                    message: process.env.NODE_ENV === 'production'
                        ? 'An error occurred'
                        : error.message
                }));
            }
        });
    }

    async startMVC(foldername){
        var rootFolderLocation = path.join(this.root, foldername);

        // Structure is always: {rootFolderLocation}/routes.js
        const routePath = path.join(rootFolderLocation, 'routes.js');
        var route = {
            isComponent: false,
            root: `${this.root}`
        };
        this.router.setup(route);
        if (fs.existsSync(routePath)) {
            await import(url.pathToFileURL(routePath).href);
        } else {
            logger.error({
                code: 'MC_ERR_ROUTES_NOT_FOUND',
                message: 'Cannot find routes file',
                path: routePath
            });
        }

        // Pre-populate the controller registry so request-time lookup is a Map.get().
        // Required for ESM since sync require() doesn't exist.
        await this.router.discoverControllers(this.root);
    }
    
    
    // will take the repsonse and request objetc and add to it
    async middleware(request, response){
        request.requrl = url.parse(request.url, true);
        // check if its css
        if (/.(css)$/.test(request.requrl)) {

            response.writeHead(200, {
              'Content-Type': 'text/css'
            });

            // get css file — use this.root (absolute) instead of __dirname
            // so this works in ESM where __dirname doesn't exist.
            // Note: request.requrl is a parsed URL object; use .pathname for the string.
            const cssPath = path.join(this.root, request.requrl.pathname || String(request.requrl));
            fileserver.readFile(cssPath, 'utf8', function(err, data) {
              if (err) throw err;
              response.write(data, 'utf8');
              response.end();
            });

            return -1;
        }
        else{
            
            var params = await this.request.getRequestParam(request, response);
            return {
                request : request,
                response : response,
                pathName : request.requrl.pathname,
                type: request.method.toLowerCase(),
                params : params
            }

        }
    }
};

// Singleton default export. Users do `import master from 'mastercontroller'`.
// The class itself is also exported as a named export for advanced use cases.
const masterInstance = new MasterControl();
export default masterInstance;
export { MasterControl };
