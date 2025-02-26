// MasterControl - by Alexander rich
// version 1.0.22

var url = require('url');
var fileserver = require('fs');
var http = require('http');
var https = require('https');
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

        var rootFolderLocation = `${this.root}/${folderLocation}/${innerFolder}`;
        var search = `${rootFolderLocation}/**/*config.js`;
        var files = globSearch.sync(search, rootFolderLocation);
        require(files[0]);
        var searchRoutes = `${rootFolderLocation}/**/*routes.js`;
        var routeFiles = globSearch.sync(searchRoutes, rootFolderLocation);
        var route = routeFiles[0];
        var routeObject = {
            isComponent : true, 
            root : rootFolderLocation
        }
        this.router.setup(routeObject);
        require(route);
    }


    // adds all the server settings needed
    serverSettings(settings){

        if(settings.httpPort || settings.requestTimeout){
            this.server.timeout = settings.requestTimeout;
            if(settings.http){
                this.server.listen(settings.httpPort, settings.http);   
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
        var $that = this;
        if(type === "http"){
            $that.serverProtocol = "http";
            return http.createServer(async function(req, res) {
                $that.serverRun(req, res);
            });
        }
        if(type === "https"){
            $that.serverProtocol = "https";
            if(credentials){
                return https.createServer(credentials, async function(req, res) {
                    $that.serverRun(req, res);
                  });
            }else{
                throw "Credentials needed to setup https"
            }
        }
    }

    async serverRun(req, res){
        var $that = this;
        console.log("path", `${req.method} ${req.url}`);
        // parse URL
        const parsedUrl = url.parse(req.url);
        // extract URL path
        let pathname = `.${parsedUrl.pathname}`;
      
        // based on the URL path, extract the file extension. e.g. .js, .doc, ...
        const ext = path.parse(pathname).ext;
      
        // if extension exist then its a file.
        if(ext === ""){
          var requestObject = await this.middleware(req, res);
          if(requestObject !== -1){
            var loadedDone = false;
            if (typeof $that._loadedFunc === 'function') {
               loadedDone = $that._loadedFunc(requestObject);
               
            }
            if (loadedDone){
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
        var rootFolderLocation = `${this.root}/${foldername}`;
        var search = `${rootFolderLocation}/**/*routes.js`;
        var files = globSearch.sync(search, rootFolderLocation);
        var route = {
            isComponent : false, 
            root : `${this.root}`
        }
        this.router.setup(route);
        require(files[0]);
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
