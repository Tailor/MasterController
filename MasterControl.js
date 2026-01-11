// MasterControl - by Alexander rich
// version 1.0.252

var url = require('url');
var fileserver = require('fs');
var http = require('http');
var https = require('https');
var tls = require('tls');
var fs = require('fs');
var url = require('url');
var path = require('path');
var globSearch = require("glob");

// Enhanced error handling - setup global handlers
const { setupGlobalErrorHandlers } = require('./error/MasterErrorMiddleware');
const { logger } = require('./error/MasterErrorLogger');

// Security - Initialize security features
const { security, securityHeaders } = require('./security/SecurityMiddleware');
const { csp } = require('./security/CSPConfig');
const { session } = require('./security/SessionSecurity');

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

    #loadTransientListClasses(name, params){
        Object.defineProperty(this.requestList, name, {
            get: function() { 
              return  new params();
            }
          });
    }

    get env(){
        return require(`${this.root}/config/environments/env.${this.environmentType}.json`);
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

    // extends class methods to be used inside of the view class using the THIS keyword
    extendView( name, element){
        element = new element();
        var $that = this;
        var propertyNames = Object.getOwnPropertyNames( element.__proto__);
        this.viewList[name] = {};
        for(var i in propertyNames){
            if(propertyNames[i] !== "constructor"){
                if (propertyNames.hasOwnProperty(i)) {
                    $that.viewList[name][propertyNames[i]] = element[propertyNames[i]];
                }
            }
        };
    }

    // extends class methods to be used inside of the controller class using the THIS keyword
    extendController(element){
        element = new element();
        var $that = this;
        var propertyNames = Object.getOwnPropertyNames( element.__proto__);
        for(var i in propertyNames){
            if(propertyNames[i] !== "constructor"){
                if (propertyNames.hasOwnProperty(i)) {
                    $that.controllerList[propertyNames[i]] = element[propertyNames[i]];
                }
            }
        };
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

    component(folderLocation, innerFolder){

        // Enhanced: Support both relative (to master.root) and absolute paths
        // If folderLocation is absolute, use it directly; otherwise join with master.root
        var rootFolderLocation;
        if (path.isAbsolute(folderLocation)) {
            // Absolute path provided - use it directly
            rootFolderLocation = path.join(folderLocation, innerFolder);
        } else {
            // Relative path - join with master.root (original behavior)
            rootFolderLocation = path.join(this.root, folderLocation, innerFolder);
        }

        // Structure is always: {rootFolderLocation}/config/initializers/config.js
        var configPath = path.join(rootFolderLocation, 'config', 'initializers', 'config.js');
        if(fs.existsSync(configPath)){
            require(configPath);
        }else{
            this.error.log(`Cannot find config file at ${configPath}`, "error");
        }

        // Structure is always: {rootFolderLocation}/config/routes.js
        var routePath = path.join(rootFolderLocation, 'config', 'routes.js');
        var routeObject = {
            isComponent : true,
            root : rootFolderLocation
        }
        this.router.setup(routeObject);
        if(fs.existsSync(routePath)){
            require(routePath);
        }else{
            this.error.log(`Cannot find routes file at ${routePath}`, "error");
        }
    }


    // adds all the server settings needed
    serverSettings(settings){

        if(settings.httpPort || settings.requestTimeout){
            this.server.timeout = settings.requestTimeout;
            var host = settings.hostname || settings.host || settings.http;
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
            var $that = this;
            // Auto-load internal master tools so services (request, error, router, etc.) are available
            // before user config initializes them.
            try {
                $that.addInternalTools([
                    'MasterPipeline',
                    'MasterTimeout',
                    'MasterErrorRenderer',
                    'MasterAction',
                    'MasterActionFilters',
                    'MasterRouter',
                    'MasterRequest',
                    'MasterError',
                    'MasterCors',
                    'MasterSession',
                    'SessionSecurity',
                    'MasterSocket',
                    'MasterHtml',
                    'MasterTemplate',
                    'MasterTools',
                    'TemplateOverwrite'
                ]);
            } catch (e) {
                console.error('[MasterControl] Failed to load internal tools:', e && e.message);
            }

            // Register core middleware that must run for framework to function
            $that._registerCoreMiddleware();

            if(type === "http"){
                $that.serverProtocol = "http";
                return http.createServer(async function(req, res) {
                    $that.serverRun(req, res);
                });
            }
            if(type === "https"){
                $that.serverProtocol = "https";
                // Initialize TLS from env if no credentials passed
                if(!credentials){
                    $that._initializeTlsFromEnv();
                    credentials = $that._tlsOptions;
                }
                // Apply secure defaults if missing
                if(credentials){
                    if(!credentials.minVersion){ credentials.minVersion = 'TLSv1.2'; }
                    if(credentials.honorCipherOrder === undefined){ credentials.honorCipherOrder = true; }
                    if(!credentials.ALPNProtocols){ credentials.ALPNProtocols = ['h2', 'http/1.1']; }
                    return https.createServer(credentials, async function(req, res) {
                        $that.serverRun(req, res);
                    });
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

    // Creates an HTTP server that 301-redirects to HTTPS counterpart
    startHttpToHttpsRedirect(redirectPort, bindHost){
        var $that = this;
        return http.createServer(function (req, res) {
            try{
                var host = req.headers['host'] || '';
                // Force original host, just change scheme
                var location = 'https://' + host + req.url;
                res.statusCode = 301;
                res.setHeader('Location', location);
                res.end();
            }catch(e){
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
        var $that = this;

        // 1. Static File Serving
        $that.pipeline.use(async (ctx, next) => {
            if (ctx.isStatic) {
                // Serve static files
                let pathname = `.${ctx.request.url}`;

                fs.exists(pathname, function (exist) {
                    if (!exist) {
                        ctx.response.statusCode = 404;
                        ctx.response.end(`File ${pathname} not found!`);
                        return;
                    }

                    if (fs.statSync(pathname).isDirectory()) {
                        pathname += '/index' + path.parse(pathname).ext;
                    }

                    fs.readFile(pathname, function(err, data) {
                        if (err) {
                            ctx.response.statusCode = 500;
                            ctx.response.end(`Error getting the file: ${err}.`);
                        } else {
                            const mimeType = $that.router.findMimeType(path.parse(pathname).ext);
                            ctx.response.setHeader('Content-type', mimeType || 'text/plain');
                            ctx.response.end(data);
                        }
                    });
                });

                return; // Terminal - don't call next()
            }

            await next(); // Not static, continue pipeline
        });

        // 2. Timeout Tracking (optional - disabled by default until init)
        // Will be configured by user in config.js with master.timeout.init()
        // This is just a placeholder registration - actual timeout is set in user config

        // 3. Request Body Parsing (always needed)
        $that.pipeline.use(async (ctx, next) => {
            // Parse body using MasterRequest
            const params = await $that.request.getRequestParam(ctx.request, ctx.response);

            // Merge parsed params into context
            if (params && params.query) {
                ctx.params.query = params.query;
            }
            if (params && params.formData) {
                ctx.params.formData = params.formData;
            }

            await next();
        });

        // 4. Load Scoped Services (per request - always needed)
        $that.pipeline.use(async (ctx, next) => {
            for (var key in $that._scopedList) {
                var className = $that._scopedList[key];
                $that.requestList[key] = new className();
            }
            await next();
        });

        // 4. HSTS Header (if enabled for HTTPS)
        $that.pipeline.use(async (ctx, next) => {
            if ($that.serverProtocol === 'https' && $that._hstsEnabled) {
                ctx.response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
            }
            await next();
        });

        // 5. Routing (TERMINAL - always needed)
        $that.pipeline.run(async (ctx) => {
            // Load config/load which triggers routing
            require(`${$that.root}/config/load`)(ctx);
        });

        // 6. Global Error Handler
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

    async serverRun(req, res){
        var $that = this;
        console.log("path", `${req.method} ${req.url}`);

        // Create request context for middleware pipeline
        const parsedUrl = url.parse(req.url);
        const pathname = parsedUrl.pathname;
        const ext = path.parse(pathname).ext;

        const context = {
            request: req,
            response: res,
            requrl: url.parse(req.url, true),
            pathName: pathname.replace(/^\/|\/$/g, '').toLowerCase(),
            type: req.method.toLowerCase(),
            params: {},
            state: {},       // User-defined state shared across middleware
            master: $that,   // Access to framework instance
            isStatic: ext !== '' // Is this a static file request?
        };

        // Execute middleware pipeline
        try {
            await $that.pipeline.execute(context);
        } catch (error) {
            console.error('Pipeline execution failed:', error);
            if (!res.headersSent) {
                res.statusCode = 500;
                res.end('Internal Server Error');
            }
        }

    } // end serverRun()

    start(server){
        this.server = server;
    }

    startMVC(foldername){
        var rootFolderLocation = path.join(this.root, foldername);

        // Structure is always: {rootFolderLocation}/routes.js
        var routePath = path.join(rootFolderLocation, 'routes.js');
        var route = {
            isComponent : false,
            root : `${this.root}`
        }
        this.router.setup(route);
        if(fs.existsSync(routePath)){
            require(routePath);
        }else{
            this.error.log(`Cannot find routes file at ${routePath}`, "error");
        }
    }
    
    
    // builds and calls all the required tools to have master running completely
    addInternalTools(requiredList){
        if(requiredList.constructor === Array){
            // Map module names to their new organized paths
            const modulePathMap = {
                'MasterPipeline': './MasterPipeline',
                'MasterTimeout': './MasterTimeout',
                'MasterErrorRenderer': './error/MasterErrorRenderer',
                'MasterError': './error/MasterError',
                'MasterAction': './MasterAction',
                'MasterActionFilters': './MasterActionFilters',
                'MasterRouter': './MasterRouter',
                'MasterRequest': './MasterRequest',
                'MasterCors': './MasterCors',
                'MasterSession': './MasterSession',
                'SessionSecurity': './security/SessionSecurity',
                'MasterSocket': './MasterSocket',
                'MasterHtml': './MasterHtml',
                'MasterTemplate': './MasterTemplate',
                'MasterTools': './MasterTools',
                'TemplateOverwrite': './TemplateOverwrite'
            };

            for(var i = 0; i < requiredList.length; i++){
                const moduleName = requiredList[i];
                const modulePath = modulePathMap[moduleName] || './' + moduleName;
                require(modulePath);
            }
        }
    }

    // will take the repsonse and request objetc and add to it
    async middleware(request, response){
        request.requrl = url.parse(request.url, true);
        // check if its css
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

module.exports = new MasterControl();
