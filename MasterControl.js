// MasterControl - by Alexander rich
// version 1.0.252

import url from 'node:url';
import fileserver from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import net from 'node:net'; // For BlockList (trusted-proxy CIDR matching)
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
    _viewEngine = null // Pluggable view engine (EJS, Pug, React SSR, etc.)

    // When true (default), an uncaught exception or unhandled rejection will
    // flush logs and terminate the process (Node's own recommendation). Setting
    // this to false keeps the process alive after logging the error — useful
    // when a supervisor is not restarting the process, but ONLY if you have
    // audited that all async code paths are wrapped and side-effect-safe.
    exitOnUncaughtException = true

    // v2.1.1: default deny-list of extensions that should never be served
    // from public/ even if a developer accidentally deploys them. Apps can
    // set this to `false` or replace it with a custom list.
    staticDenyExtensions = ['.env', '.map', '.bak', '.pem', '.key', '.git']

    // ---- Developer-convenience: auto-increment port on EADDRINUSE ----
    //
    // When enabled, if the configured port is already in use the framework
    // automatically retries server.listen() on the next port (up to
    // `maxPortIncrement` attempts) instead of crashing with FATAL.
    //
    // Intended for LOCAL DEVELOPMENT only. Auto-bumping a port in production
    // makes service discovery and health checks miss the running instance.
    // The setter therefore refuses to enable when NODE_ENV === 'production'.
    //
    // Usage:
    //   master.autoIncrementPort = true;          // dev only
    //   master.maxPortIncrement = 10;             // optional, default 10
    //   master.start(server);
    //   server.listen(3000);                      // → uses 3000, or 3001, 3002…
    //
    // After listen succeeds, `master.actualPort` holds the port that was
    // bound (useful for printing "listening on http://127.0.0.1:3001").
    _autoIncrementPort = false
    maxPortIncrement = 10
    actualPort = null

    get autoIncrementPort() {
        return this._autoIncrementPort;
    }
    set autoIncrementPort(v) {
        if (v && process.env.NODE_ENV === 'production') {
            // Refuse silently in production — don't throw because user code may
            // toggle this from a shared config file.
            try {
                process.stderr.write('[MasterController] autoIncrementPort ignored: refuses to enable when NODE_ENV=production\n');
            } catch (_) {}
            this._autoIncrementPort = false;
            return;
        }
        this._autoIncrementPort = !!v;
    }

    // Trusted reverse-proxy peer addresses (IPs / CIDRs). When set, the
    // framework will trust X-Forwarded-Proto and X-Forwarded-For only when
    // the immediate TCP peer (req.socket.remoteAddress) is in this list.
    //
    // SECURE DEFAULT: empty array means X-Forwarded-* headers are IGNORED,
    // even if a client sends them. This prevents:
    //   - HTTPS enforcement bypass by sending "X-Forwarded-Proto: https"
    //   - Rate-limit bypass by rotating X-Forwarded-For
    //   - Log/IP spoofing for forensics evasion
    //
    // Set this when you deploy behind a known reverse proxy (nginx, ELB, k8s
    // ingress, Cloudflare):
    //   master.trustedProxies = ['127.0.0.1', '::1', '10.0.0.0/8'];
    trustedProxies = []

    /**
     * Returns true if the given peer IP is in the trustedProxies list.
     * @param {string} peer - The TCP peer address (req.socket.remoteAddress)
     * @returns {boolean}
     */
    isTrustedProxy(peer) {
        if (!peer || !this.trustedProxies || this.trustedProxies.length === 0) return false;
        // Normalize IPv4-mapped IPv6 (::ffff:1.2.3.4 → 1.2.3.4) for comparison.
        const normalized = peer.startsWith('::ffff:') ? peer.slice(7) : peer;
        // v2.1.0: support CIDR entries (e.g. '10.0.0.0/8', 'fc00::/7') via
        // net.BlockList. The docs advertised CIDR since day one, but the
        // previous implementation was string-equality only — silently
        // treating `'10.0.0.0/8'` as un-matchable. Cache the BlockList so we
        // rebuild it only when the trustedProxies list itself changes.
        if (this._trustedProxiesBL === undefined
            || this._trustedProxiesCacheKey !== this.trustedProxies) {
            this._trustedProxiesCacheKey = this.trustedProxies;
            this._trustedProxiesBL = this._buildTrustedProxiesBlockList(this.trustedProxies);
        }
        if (this._trustedProxiesBL) {
            try {
                const family = normalized.includes(':') ? 'ipv6' : 'ipv4';
                if (this._trustedProxiesBL.check(normalized, family)) return true;
            } catch (_) { /* invalid IP shape — fall through to string match */ }
        }
        return this.trustedProxies.some(p => p === peer || p === normalized);
    }

    _buildTrustedProxiesBlockList(entries) {
        if (!Array.isArray(entries) || entries.length === 0) return null;
        try {
            const bl = new net.BlockList();
            for (const entry of entries) {
                if (typeof entry !== 'string') continue;
                if (entry.includes('/')) {
                    const [addr, bitsRaw] = entry.split('/');
                    const bits = parseInt(bitsRaw, 10);
                    if (Number.isNaN(bits)) continue;
                    const family = addr.includes(':') ? 'ipv6' : 'ipv4';
                    try { bl.addSubnet(addr, bits, family); } catch (_) {}
                } else {
                    const family = entry.includes(':') ? 'ipv6' : 'ipv4';
                    try { bl.addAddress(entry, family); } catch (_) {}
                }
            }
            return bl;
        } catch (_) { return null; }
    }

    /**
     * Returns the effective client IP, honoring X-Forwarded-For only if the
     * immediate peer is in trustedProxies. Otherwise returns the raw peer IP.
     * @param {Object} req - Node http.IncomingMessage
     * @returns {string}
     */
    getClientIp(req) {
        const peer = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
        if (!this.isTrustedProxy(peer)) return peer;
        const xff = req.headers['x-forwarded-for'];
        if (!xff) return peer;
        // Walk right-to-left; first untrusted hop is the real client.
        const hops = String(xff).split(',').map(s => s.trim()).filter(Boolean);
        for (let i = hops.length - 1; i >= 0; i--) {
            if (!this.isTrustedProxy(hops[i])) return hops[i];
        }
        return peer;
    }

    /**
     * Returns true if the request is HTTPS, honoring X-Forwarded-Proto only
     * if the immediate peer is in trustedProxies.
     * @param {Object} req - Node http.IncomingMessage
     * @returns {boolean}
     */
    isRequestSecure(req) {
        if (req.connection?.encrypted || req.socket?.encrypted) return true;
        const peer = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
        if (!this.isTrustedProxy(peer)) return false;
        return req.headers['x-forwarded-proto'] === 'https';
    }

    // Root directory for static file serving.
    //
    // Secure-by-default: defaults to `<master.root>/public/`. If that directory
    // doesn't exist, static file serving is disabled entirely — there is NO
    // fallback to master.root. This mirrors ASP.NET wwwroot, Rails public/, and
    // Django STATIC_ROOT: source files (server.js, config/, app/, package.json,
    // node_modules/) are never reachable via URL.
    //
    // Customize by setting before master.start():
    //   master.staticRoot = path.join(master.root, 'assets');   // different dir
    //   master.staticRoot = false;                              // disable entirely
    //
    // History: v2.x defaulted to master.root, which exposed application source.
    // v3.0 introduced the public/ default. CVE-class fix.
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
     * Register a pluggable view engine (EJS, Pug, React SSR, etc.)
     *
     * @param {Object|Function} ViewEngine - View engine class or instance
     * @param {Object} options - Configuration options for the view engine
     * @returns {MasterControl} - Returns this for chaining
     *
     * @example
     * // Use an EJS adapter
     * import EJSAdapter from './adapters/ejs.js';
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
            context: { engine: ViewEngine.name || 'Custom' }
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

    /**
     * Register a component.
     *
     * A component is a self-contained module rooted at a folder. The framework
     * probes the folder for known layout pieces (init, routes, controllers,
     * services, models, sockets) and loads whatever is present. None of these
     * are individually required — many real components are controller-only,
     * or service-only, or pure data layers. Missing pieces are silently
     * skipped (not logged as errors).
     *
     * Behavior:
     *   - The component folder MUST exist. If it doesn't, throws — that's a
     *     configuration bug, not an optional condition.
     *   - The component must contain AT LEAST ONE recognized piece (init,
     *     routes, controllers, services, models, sockets). If it's empty, a
     *     WARN is logged — registering an empty folder is almost always a
     *     typo or stale path.
     *   - Loading order: init → routes → controllers (registry pre-populated).
     *   - A single INFO entry summarizes what was loaded, so operators can
     *     see component composition at boot without 5 separate log lines.
     *
     * @param {string} folderLocation - Parent folder (absolute or relative to master.root)
     * @param {string} innerFolder - Component folder name within folderLocation
     * @param {Object} [opts]
     * @param {boolean} [opts.silent=false] - Suppress the INFO summary line
     *   (use when registering many components programmatically and you'd
     *   rather emit your own consolidated log)
     * @returns {Promise<Object>} Discovery result with flags and paths for
     *   each piece — useful for tests, tooling, and orchestrators
     */
    async component(folderLocation, innerFolder, opts = {}) {
        const rootFolderLocation = path.isAbsolute(folderLocation)
            ? path.join(folderLocation, innerFolder)
            : path.join(this.root, folderLocation, innerFolder);
        const componentName = innerFolder;

        // The component folder itself must exist. A missing folder is a real
        // bug (typo, stale path, package not installed) and we surface it
        // loudly rather than silently no-op'ing the registration.
        if (!fs.existsSync(rootFolderLocation)) {
            const err = new Error(
                `Component '${componentName}' folder does not exist: ${rootFolderLocation}`
            );
            err.code = 'MC_ERR_COMPONENT_FOLDER_MISSING';
            // NOTE: structured data goes in `context` because the logger only
            // serializes a fixed set of top-level fields (code/message/
            // component/file/line/route/context). Arbitrary top-level fields
            // are silently dropped, so they're not useful for tooling.
            logger.error({
                code: 'MC_ERR_COMPONENT_FOLDER_MISSING',
                message: err.message,
                component: componentName,
                context: { path: rootFolderLocation }
            });
            throw err;
        }

        const discovery = this._discoverComponent(rootFolderLocation);

        // Empty folder = real config bug worth warning about (no init, no
        // routes, no controllers, no services, no models, no sockets). The
        // user likely meant a different path or hasn't built out the
        // component yet.
        if (discovery.isEmpty) {
            logger.warn({
                code: 'MC_WARN_COMPONENT_EMPTY',
                message: `Component '${componentName}' registered but contains no recognized framework pieces (init, routes, controllers, services, models, or sockets). Check the path and folder layout.`,
                component: componentName,
                context: { path: rootFolderLocation }
            });
            return discovery;
        }

        // Set up the route scope so the router knows where this component's
        // routes (if any) and controllers live, even if it ultimately only
        // has controllers and no routes.js.
        this.router.setup({
            isComponent: true,
            root: rootFolderLocation
        });

        // Load init file if present — its job is usually pipeline.use()
        // registration, service registration, scoped-service setup.
        if (discovery.hasInit) {
            await import(url.pathToFileURL(discovery.initPath).href);
        }

        // Load routes file if present.
        if (discovery.hasRoutes) {
            await import(url.pathToFileURL(discovery.routesPath).href);
        }

        // Pre-populate controllers into the registry if a controllers folder
        // exists. discoverControllers is itself idempotent and a no-op when
        // the directory is missing — but checking here lets us include it in
        // the summary log.
        if (discovery.hasControllers) {
            await this.router.discoverControllers(rootFolderLocation);
        }

        if (!opts.silent) {
            const pieces = Object.entries(discovery.has)
                .filter(([, v]) => v)
                .map(([k]) => k)
                .join(', ');
            logger.info({
                code: 'MC_INFO_COMPONENT_LOADED',
                message: `Component '${componentName}' loaded (${pieces})`,
                component: componentName,
                context: {
                    path: rootFolderLocation,
                    has: discovery.has
                }
            });
        }

        return discovery;
    }

    /**
     * Probe a component folder for known framework layout pieces. Synchronous
     * because all the checks are filesystem `existsSync`/`statSync` calls —
     * keeping discovery sync lets `component()` callers reason linearly about
     * what was found before any async loading kicks in.
     *
     * Returns a stable shape with both per-piece flags and absolute paths.
     * Add new piece types here as the framework grows; bumps to this contract
     * should be additive (existing callers should keep working).
     *
     * @private
     * @param {string} root - Absolute path to the component folder
     * @returns {Object} discovery result
     */
    _discoverComponent(root) {
        const isDir = (p) => {
            try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
        };
        const isFile = (p) => {
            try { return fs.statSync(p).isFile(); } catch (_) { return false; }
        };

        const initPath        = path.join(root, 'config', 'initializers', 'config.js');
        const routesPath      = path.join(root, 'config', 'routes.js');
        const controllersPath = path.join(root, 'app', 'controllers');
        const servicesPath    = path.join(root, 'app', 'services');
        const modelsPath      = path.join(root, 'app', 'models');
        const socketsPath     = path.join(root, 'app', 'sockets');

        const has = {
            init:        isFile(initPath),
            routes:      isFile(routesPath),
            controllers: isDir(controllersPath),
            services:    isDir(servicesPath),
            models:      isDir(modelsPath),
            sockets:     isDir(socketsPath)
        };

        return {
            root,
            isEmpty: Object.values(has).every(v => v === false),
            has,
            // Convenience accessors so consumers don't have to re-compute paths.
            hasInit:        has.init,        initPath,
            hasRoutes:      has.routes,      routesPath,
            hasControllers: has.controllers, controllersPath,
            hasServices:    has.services,    servicesPath,
            hasModels:      has.models,      modelsPath,
            hasSockets:     has.sockets,     socketsPath
        };
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
            throw new Error("HTTP, HTTPS, HTTPPORT and REQUEST TIMEOUT MISSING");
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

    /**
     * v2.1.1: apply defensive server-level timeouts to counter slowloris.
     *
     * MasterTimeout only starts tracking after middleware runs — i.e. after
     * headers + body are fully received. A slowloris client that drip-feeds
     * headers 1 byte at a time bypasses the middleware timer entirely.
     * These socket-level defaults close such connections.
     *
     * Overridable per-instance:
     *   master.serverHeadersTimeout = 30_000;
     *   master.serverRequestTimeout = 120_000;
     *   master.serverKeepAliveTimeout = 5_000;
     *
     * Set to 0 to disable a specific timeout (not recommended).
     */
    _applyServerTimeoutDefaults(server) {
        if (!server) return;
        const headers = this.serverHeadersTimeout ?? 15_000;
        const request = this.serverRequestTimeout ?? 60_000;
        const keepAlive = this.serverKeepAliveTimeout ?? 5_000;
        if (headers >= 0) server.headersTimeout = headers;
        if (request >= 0) server.requestTimeout = request;
        if (keepAlive >= 0) server.keepAliveTimeout = keepAlive;
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
                // v2.1.0: bind the SecurityMiddleware singleton so its rate
                // limiter / CSRF / HSTS paths use master.getClientIp,
                // master.isRequestSecure, master._hstsMaxAge, etc.
                if (security && typeof security.bindMaster === 'function') {
                    security.bindMaster($that);
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

            // Initialize global error handlers, honoring master.exitOnUncaughtException.
            setupGlobalErrorHandlers({
                exitOnUncaught: $that.exitOnUncaughtException !== false
            });

            // Register core middleware that must run for framework to function
            $that._registerCoreMiddleware();

            if(type === "http"){
                $that.serverProtocol = "http";
                const server = http.createServer(async function(req, res) {
                    await $that.serverRun(req, res);
                });
                $that._applyServerTimeoutDefaults(server);
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
                    $that._applyServerTimeoutDefaults(server);
                    // Set server immediately so config can access it
                    $that.server = server;
                    return server;
                }else{
                    throw new Error("Credentials needed to setup https");
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
    startHttpToHttpsRedirect(redirectPort, bindHost, allowedHosts){
        // SECURITY: allowedHosts is required. Previously this was optional with
        // a console.warn, which meant any deployment that forgot it became an
        // open redirect ("Host: evil.com" → "Location: https://evil.com/..."
        // → phishing). v3.0 fails-fast at startup instead of at request time.
        if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) {
            throw new Error(
                'startHttpToHttpsRedirect: allowedHosts (non-empty array) is required to prevent ' +
                'open-redirect attacks via the Host header. Example:\n' +
                '  master.startHttpToHttpsRedirect(80, "0.0.0.0", ["example.com", "www.example.com"]);'
            );
        }

        // Validate hostnames in the allow-list (defensive — reject anything
        // that isn't a plain hostname so misconfiguration can't produce
        // surprising matches).
        const hostnameRe = /^[A-Za-z0-9.-]+$/;
        for (const h of allowedHosts) {
            if (typeof h !== 'string' || !hostnameRe.test(h)) {
                throw new Error(`startHttpToHttpsRedirect: invalid hostname in allowedHosts: ${h}`);
            }
        }

        return http.createServer(function (req, res) {
            try {
                const rawHost = req.headers['host'] || '';
                // Strip port for validation only. Reject CR/LF (response splitting),
                // null bytes, and any userinfo (`@` in host enables phishing-grade
                // redirects like `example.com:443@evil.com`).
                if (rawHost.includes('\r') || rawHost.includes('\n') || rawHost.includes('\0') || rawHost.includes('@')) {
                    res.statusCode = 400;
                    res.setHeader('Content-Type', 'text/plain');
                    res.end('Bad Request: malformed Host header');
                    return;
                }
                const colonIdx = rawHost.indexOf(':');
                const hostname = colonIdx >= 0 ? rawHost.slice(0, colonIdx) : rawHost;

                if (!allowedHosts.includes(hostname)) {
                    logger.warn({
                        code: 'MC_SECURITY_INVALID_HOST',
                        message: 'HTTP redirect blocked: host not in allow-list',
                        host: hostname,
                        ip: req.connection.remoteAddress
                    });
                    res.statusCode = 400;
                    res.setHeader('Content-Type', 'text/plain');
                    res.end('Bad Request: invalid host');
                    return;
                }

                // Build the redirect from the VALIDATED hostname, NOT the raw
                // Host header. Drops attacker-controlled port and userinfo.
                const location = 'https://' + hostname + req.url;
                // v2.1.0: 308 is method+body preserving. 301 silently rewrote
                // POST/PUT/DELETE into GET and dropped the body, breaking any
                // API client that hit HTTP by mistake (webhooks, mobile cold
                // starts, misconfigured CI).
                res.statusCode = 308;
                res.setHeader('Location', location);
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.end();
            } catch (e) {
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
            const cfg = this.env;
            if(!cfg || !cfg.server || !cfg.server.tls){
                return;
            }
            const tlsCfg = cfg.server.tls;

            const defaultCreds = this._buildSecureContextFromPaths(tlsCfg.default);
            let defaultContext = defaultCreds ? tls.createSecureContext(defaultCreds) : null;

            const sniMap = {};
            if(tlsCfg.sni && typeof tlsCfg.sni === 'object'){
                for (var domain in tlsCfg.sni){
                    if (Object.prototype.hasOwnProperty.call(tlsCfg.sni, domain)){
                        const domCreds = this._buildSecureContextFromPaths(tlsCfg.sni[domain]);
                        if(domCreds){
                            sniMap[domain] = tls.createSecureContext(domCreds);
                            // watch domain certs for reload
                            this._watchTlsFilesAndReload(tlsCfg.sni[domain], function(){
                                try{
                                    const updated = tls.createSecureContext(
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

            const options = defaultCreds ? Object.assign({}, defaultCreds) : {};
            options.SNICallback = function(servername, cb){
                let ctx = sniMap[servername];
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
            // v2.1.1: unify default with enableHSTS() → 1 year (matches
            // Chrome / Mozilla guidance and the HSTS preload list minimum
            // for domains that later opt-in). Previously two entry points
            // disagreed (1yr vs 180d), so which path enabled HSTS silently
            // changed the browser cache duration.
            this._hstsMaxAge = tlsCfg.hstsMaxAge || 31536000;
            if (typeof tlsCfg.hstsIncludeSubDomains === 'boolean') {
                this._hstsIncludeSubDomains = tlsCfg.hstsIncludeSubDomains;
            }
            if (typeof tlsCfg.hstsPreload === 'boolean') {
                this._hstsPreload = tlsCfg.hstsPreload;
            }

            // Watch default certs for reload
            if(tlsCfg.default){
                this._watchTlsFilesAndReload(tlsCfg.default, function(){
                    try{
                        const updatedCreds = this._buildSecureContextFromPaths(tlsCfg.default);
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
        const opts = {};
        try{
            if(desc.keyPath){ opts.key = fs.readFileSync(desc.keyPath); }
            if(desc.certPath){ opts.cert = fs.readFileSync(desc.certPath); }
            if(desc.caPath){ opts.ca = fs.readFileSync(desc.caPath); }
            if(desc.pfxPath){ opts.pfx = fs.readFileSync(desc.pfxPath); }
            if(desc.passphrase){ opts.passphrase = desc.passphrase; }
            // v2.1.1: fail-fast if the credential set is incomplete. Prior
            // behavior handed the partial object to https.createServer, which
            // produced an obscure ERR_TLS_CERT_ALTNAME_INVALID or "Missing
            // PFX or certificate + private key" at listen() time — a
            // startup-time DX cliff that historically drove users to
            // disable TLS while debugging.
            const hasPfx = !!opts.pfx;
            const hasKeyPair = !!(opts.key && opts.cert);
            if (!hasPfx && !hasKeyPair) {
                const keys = Object.keys(desc).filter(k => desc[k]).join(', ');
                throw new Error(
                    'TLS config invalid: must supply either pfxPath, or BOTH keyPath and certPath. ' +
                    `Got: ${keys || '(none)'}`
                );
            }
            return opts;
        }catch(e){
            console.error('Failed to build TLS context:', e.message);
            return null;
        }
    }

    _watchTlsFilesAndReload(desc, onChange){
        const paths = [];
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

        // 1. Static File Serving — ASP.NET / Rails / Express model
        //
        // SECURITY POSTURE:
        //   - Default staticRoot is <master.root>/public/. If that directory
        //     doesn't exist, static serving is disabled (every request flows
        //     to the router). NEVER falls back to master.root — source files,
        //     config/, node_modules/, etc. are not reachable via URL.
        //   - URL pattern is never consulted. The gate is file existence.
        //   - Dotfile filter applies to EVERY segment (blocks .git/config,
        //     .ssh/anything, .env, etc.), not just the leaf.
        //   - Containment check uses path separator to prevent prefix-confusion
        //     bypass (e.g. staticRoot=/var/www/app must not match /var/www/app2).
        //   - URL is decoded before traversal check (defeats %2e%2e attacks).
        //   - Symlinks are rejected (defeats arbitrary file read via planted
        //     symlinks in user-writable subdirectories).
        //   - Set master.staticRoot = false to disable static serving entirely.
        //   - Set master.staticRoot = '/some/path' to override the default.
        //
        // Resolve once at startup (not per request) for performance.
        let resolvedStaticRoot = null;
        if ($that.staticRoot === false) {
            resolvedStaticRoot = null;
        } else if ($that.staticRoot) {
            resolvedStaticRoot = path.resolve($that.staticRoot);
        } else if ($that.root) {
            const defaultPublic = path.join($that.root, 'public');
            if (fs.existsSync(defaultPublic) && fs.statSync(defaultPublic).isDirectory()) {
                resolvedStaticRoot = path.resolve(defaultPublic);
            }
            // If <root>/public doesn't exist, static serving is disabled.
        }
        $that._resolvedStaticRoot = resolvedStaticRoot;

        $that.pipeline.use(async (ctx, next) => {
            // No static root configured → never serve static, always route.
            if (!resolvedStaticRoot) return next();

            const requestedPath = ctx.request.url.split('?')[0].split('#')[0];

            // SECURITY: Decode URL before path operations so %2e%2e variants are
            // checked, not just literal "..". Malformed encoding → fall through.
            let decodedPath;
            try {
                decodedPath = decodeURIComponent(requestedPath);
            } catch (_) {
                return next();
            }

            // SECURITY: Reject NUL bytes (defeat poison-null-byte truncation
            // attacks on some filesystems) and any literal ".." path segment
            // (belt-and-suspenders before path.resolve).
            if (decodedPath.includes('\0') || decodedPath.split('/').some(s => s === '..')) {
                logger.warn({
                    code: 'MC_SECURITY_PATH_TRAVERSAL',
                    message: 'Path traversal attempt blocked from static serving',
                    requestedPath: requestedPath,
                    ip: ctx.request.connection?.remoteAddress
                });
                return next();
            }

            const resolvedPath = path.resolve(path.join(resolvedStaticRoot, decodedPath));

            // SECURITY: Containment check uses path separator boundary to
            // prevent prefix-confusion (staticRoot=/var/www/app must not
            // accidentally allow /var/www/app2/whatever).
            const rootWithSep = resolvedStaticRoot.endsWith(path.sep)
                ? resolvedStaticRoot
                : resolvedStaticRoot + path.sep;
            if (resolvedPath !== resolvedStaticRoot && !resolvedPath.startsWith(rootWithSep)) {
                logger.warn({
                    code: 'MC_SECURITY_PATH_TRAVERSAL',
                    message: 'Path traversal escape blocked from static serving',
                    requestedPath: requestedPath,
                    resolvedPath: resolvedPath,
                    ip: ctx.request.connection?.remoteAddress
                });
                return next();
            }

            // SECURITY: Dotfile filter applies to EVERY segment between
            // staticRoot and resolvedPath, not just the basename. This blocks
            // /.git/config, /.ssh/id_rsa, /subdir/.env, etc.
            //
            // v2.1.1: allow the standard `.well-known/` prefix so Let's
            // Encrypt HTTP-01 challenges and other RFC 8615 resources work
            // out of the box. Only the TOP-LEVEL `.well-known` is exempted;
            // dotfiles NESTED inside `.well-known/…/.env` still fail.
            const relSegments = path.relative(resolvedStaticRoot, resolvedPath).split(path.sep);
            const isWellKnown = relSegments[0] === '.well-known';
            const dotSegments = isWellKnown
                ? relSegments.slice(1).some(seg => seg.startsWith('.'))
                : relSegments.some(seg => seg.startsWith('.'));
            if (dotSegments) {
                logger.warn({
                    code: 'MC_SECURITY_DOTFILE_BLOCKED',
                    message: 'Dotfile access blocked from static serving',
                    context: {
                        requestedPath: requestedPath,
                        ip: ($that.getClientIp?.(ctx.request)) || ctx.request.connection?.remoteAddress
                    }
                });
                return next();
            }

            // v2.1.1: extension deny-list. Defends against accidental
            // deployments of secret / source-map / backup files under public/.
            // The check runs after the containment + dotfile filter so
            // legitimate `.well-known/` files are unaffected.
            const denyExts = $that.staticDenyExtensions;
            if (denyExts && denyExts.length > 0) {
                const ext = path.extname(resolvedPath).toLowerCase();
                if (ext && denyExts.includes(ext)) {
                    logger.warn({
                        code: 'MC_SECURITY_EXTENSION_BLOCKED',
                        message: 'Static serving blocked by extension deny-list',
                        context: {
                            requestedPath: requestedPath, ext,
                            ip: ($that.getClientIp?.(ctx.request)) || ctx.request.connection?.remoteAddress
                        }
                    });
                    return next();
                }
            }

            // SECURITY: lstat (not stat) so symlinks don't traverse our check.
            // If you need symlink support, use fs.realpathSync + re-verify
            // containment — most apps shouldn't need it.
            let stats;
            try {
                stats = fs.lstatSync(resolvedPath);
            } catch (_) {
                return next(); // not a static file → routing's turn
            }
            if (stats.isSymbolicLink()) {
                logger.warn({
                    code: 'MC_SECURITY_SYMLINK_BLOCKED',
                    message: 'Symlink blocked from static serving',
                    resolvedPath: resolvedPath,
                    ip: ctx.request.connection?.remoteAddress
                });
                return next();
            }

            // Directory → index.html (also lstat-checked).
            let finalPath = resolvedPath;
            if (stats.isDirectory()) {
                finalPath = path.join(resolvedPath, 'index.html');
                try {
                    stats = fs.lstatSync(finalPath);
                } catch (_) {
                    return next();
                }
                if (stats.isSymbolicLink() || !stats.isFile()) {
                    return next();
                }
            } else if (!stats.isFile()) {
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

        // 4. HSTS Header (per-request TLS check, honors trusted proxies)
        //
        // v2.1.0: previously gated on `serverProtocol === 'https'`, which is
        // the framework's own listener protocol — set at server start and
        // never changed. Standard production topology is nginx / ELB / CDN
        // terminating TLS and forwarding plain HTTP to the app, so
        // serverProtocol was always 'http' → HSTS never emitted. Now uses
        // the per-request `isRequestSecure` helper, which is honest about
        // `X-Forwarded-Proto: https` from trustedProxies.
        $that.pipeline.use(async (ctx, next) => {
            if ($that._hstsEnabled && $that.isRequestSecure(ctx.request)) {
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
        // SECURITY: do not log full request URLs by default — query strings
        // commonly contain secrets (?reset_token=, ?api_key=, ?access_token=,
        // ?_csrf=). Apps that want request logging should opt in via
        // requestLoggerMiddleware with explicit field redaction.

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
        let __portAttempts = 0;
        server.once('listening', () => {
            __isListening = true;
            const addr = server.address();
            if (addr && typeof addr === 'object') {
                $that.actualPort = addr.port;
            }
        });
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

            // Dev-only auto port bump — retry on the next port instead of exiting.
            // Only triggers for EADDRINUSE and only when explicitly opted in.
            // Refuses in production via the setter, so this branch is dev-safe.
            if (err.code === 'EADDRINUSE'
                && $that._autoIncrementPort
                && __portAttempts < ($that.maxPortIncrement || 10)) {
                __portAttempts++;
                const nextPort = (err.port || 0) + 1;
                try {
                    process.stderr.write(`[MasterController] port ${err.port} in use, retrying on ${nextPort} (attempt ${__portAttempts}/${$that.maxPortIncrement})\n`);
                } catch (_) {}
                // Re-listen on the next port, preserving the original bind host.
                // err.address is the host that was attempted; fall back to undefined
                // (Node's default — all interfaces) if missing.
                try {
                    if (err.address !== undefined) {
                        server.listen(nextPort, err.address);
                    } else {
                        server.listen(nextPort);
                    }
                } catch (retryErr) {
                    try { process.stderr.write(`[MasterController] retry on port ${nextPort} threw synchronously: ${retryErr.message}\n`); } catch (_) {}
                }
                return;
            }

            // Pre-listen error — fatal. Surface clearly and exit so process
            // managers (PM2, systemd, Docker) know the boot failed.
            let detail;
            if (err.code === 'EADDRINUSE') {
                if ($that._autoIncrementPort && __portAttempts >= ($that.maxPortIncrement || 10)) {
                    detail = `Tried ${__portAttempts} consecutive ports starting from ${(err.port || 0) - __portAttempts}; all in use. Stop conflicting processes or raise master.maxPortIncrement.`;
                } else {
                    detail = `Port ${err.port} is already in use. Stop the other process, pick a different port, or (dev only) set master.autoIncrementPort = true.`;
                }
            } else if (err.code === 'EACCES') {
                detail = `Permission denied binding port ${err.port} (ports < 1024 require root or CAP_NET_BIND_SERVICE).`;
            } else {
                detail = err.message;
            }
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
            // Flush async backends before exiting (same pattern as the
            // uncaughtException handler). 2s flush + 3s hard cap.
            const exitOnce = () => { try { process.exit(1); } catch (_) {} };
            logger.flushAsync().then(exitOnce, exitOnce);
            const hardTimer = setTimeout(exitOnce, 3000);
            if (hardTimer.unref) hardTimer.unref();
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
            // Generate a correlation ID so operators can find the full error
            // in logs without us having to include it in the response body.
            const errorId = `err_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

            logger.error({
                code: 'MC_ERR_PIPELINE',
                message: 'Error in middleware pipeline',
                errorId: errorId,
                error: error.message,
                stack: error.stack,
                path: ctx.request.url,
                method: ctx.type
            });

            if (!ctx.response.headersSent) {
                ctx.response.statusCode = 500;
                ctx.response.setHeader('Content-Type', 'application/json');
                // SECURITY (v3.0): never echo raw error.message to clients,
                // even outside production. Error messages frequently include
                // user input (validation errors echoing the bad value =
                // reflected XSS / JSON injection), database driver text
                // (schema disclosure), padding-oracle distinguishers, etc.
                // Operators correlate via errorId in the log.
                ctx.response.end(JSON.stringify({
                    error: 'Internal Server Error',
                    errorId: errorId
                }));
            }
        });
    }

    async startMVC(foldername){
        const rootFolderLocation = path.join(this.root, foldername);

        // Structure is always: {rootFolderLocation}/routes.js
        const routePath = path.join(rootFolderLocation, 'routes.js');
        const route = {
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
    
    
    // (Legacy `middleware(req, res)` helper was removed in v3.0 — it had a
    // path-traversal bug allowing `GET /../../etc/passwd.css` and was not
    // wired into the request pipeline anywhere. Static CSS files are served
    // by the secure static middleware registered in _registerCoreMiddleware.)
};

// Singleton default export. Users do `import master from 'mastercontroller'`.
// The class itself is also exported as a named export for advanced use cases.
const masterInstance = new MasterControl();
export default masterInstance;
export { MasterControl };
