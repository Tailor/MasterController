// MasterControl - by Alexander rich
// version 1.0.247

var url = require('url');
var fileserver = require('fs');
var http = require('http');
var https = require('https');
var tls = require('tls');
var fs = require('fs');
var url = require('url');
var path = require('path');
var globSearch = require("glob");


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

        var rootFolderLocation = path.join(this.root, folderLocation, innerFolder);
        var files = globSearch.sync("**/*config.js", { cwd: rootFolderLocation, absolute: true });
        if(files && files.length > 0){
            require(files[0]);
        }else{
            this.error.log(`Cannot find config file under ${rootFolderLocation}`, "error");
        }
        var routeFiles = globSearch.sync("**/*routes.js", { cwd: rootFolderLocation, absolute: true });
        var route = routeFiles && routeFiles.length > 0 ? routeFiles[0] : null;
        var routeObject = {
            isComponent : true,
            root : rootFolderLocation
        }
        this.router.setup(routeObject);
        if(route){
            require(route);
        }else{
            this.error.log(`Cannot find routes file under ${rootFolderLocation}`, "error");
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

    async serverRun(req, res){
        var $that = this;
        console.log("path", `${req.method} ${req.url}`);

          // Handle CORS preflight (OPTIONS) requests early and positively
        if (req.method === 'OPTIONS') {
            try {
                if (this.cors && typeof this.cors.load === 'function') {
                    if (!this.cors.options) {
                        this.cors.init({
                            origin: true,
                            methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
                            allowedHeaders: true,
                            credentials: false,
                            maxAge: 86400
                        });
                    }
                    this.cors.load({ request: req, response: res });
                } else {
                    res.setHeader('access-control-allow-origin', '*');
                    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
                    if (req.headers['access-control-request-headers']) {
                        res.setHeader('access-control-allow-headers', req.headers['access-control-request-headers']);
                    }
                    res.setHeader('access-control-max-age', '86400');
                }
            } catch (e) {
                res.setHeader('access-control-allow-origin', '*');
                res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
                if (req.headers['access-control-request-headers']) {
                    res.setHeader('access-control-allow-headers', req.headers['access-control-request-headers']);
                }
                res.setHeader('access-control-max-age', '86400');
            }
            res.statusCode = 204;
            res.setHeader('content-length', '0');
            res.end();
            return;
        }

        // parse URL
        const parsedUrl = url.parse(req.url);
        // extract URL path
        let pathname = `.${parsedUrl.pathname}`;
      
        // based on the URL path, extract the file extension. e.g. .js, .doc, ...
        const ext = path.parse(pathname).ext;
      
        // handle simple preflight configuration - might need a complex approch for all scenarios
    

        // if extension exist then its a file.
        if(ext === ""){
          var requestObject = await this.middleware(req, res);
          if(requestObject !== -1){
            // HSTS header if enabled
            if(this.serverProtocol === 'https' && this._hstsEnabled){
                res.setHeader('strict-transport-security', `max-age=${this._hstsMaxAge}; includeSubDomains`);
            }
            var loadedDone = false;
            if (typeof $that._loadedFunc === 'function') {
               loadedDone = $that._loadedFunc(requestObject);
                if (loadedDone){
                    require(`${this.root}/config/load`)(requestObject);
                } 
            }
            else{
                require(`${this.root}/config/load`)(requestObject);
            }
           
          
          }
        }
        else{
      
            fs.exists(pathname, function (exist) {
      
                if(!exist) {
                  // if the file is not found, return 404
                  res.statusCode = 404;
                  res.end(`File ${pathname} not found!`);
                  return;
                }
      
                // if is a directory search for index file matching the extension
                if (fs.statSync(pathname).isDirectory()) pathname += '/index' + ext;
      
                // read file from file system
                fs.readFile(pathname, function(err, data){
                  if(err){
                    res.statusCode = 500;
                    res.end(`Error getting the file: ${err}.`);
                  } else {
                    const mimeType = $that.router.findMimeType(ext);
                    
                    // if the file is found, set Content-type and send data
                    res.setHeader('Content-type', mimeType || 'text/plain' );
                    res.end(data);
                  }
                });
      
            });
        }
     
    } // end server()

    start(server){
        this.server = server;
    }

    startMVC(foldername){
        var rootFolderLocation = path.join(this.root, foldername);
        var files = globSearch.sync("**/*routes.js", { cwd: rootFolderLocation, absolute: true });
        var route = {
            isComponent : false, 
            root : `${this.root}`
        }
        this.router.setup(route);
        if(files && files.length > 0){
            require(files[0]);
        }else{
            master.error.log(`Cannot find routes file under ${rootFolderLocation}`, "error");
        }
    }
    
    
    // builds and calls all the required tools to have master running completely
    addInternalTools(requiredList){
        if(requiredList.constructor === Array){
            for(var i = 0; i < requiredList.length; i++){
                require('./' + requiredList[i]);
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
