// MasterControl - by Alexander rich
// version 1.0.18

var url = require('url');
var fileserver = require('fs');
var http = require('http');
var https = require('https');
var fs = require('fs');
var url = require('url');
var path = require('path');

class MasterControl {
    controllerList = {}
    viewList = {}
    requestList = {}
    _root = null
    _environmentType = null
    _serverProtocol = null

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
    extend(){
        var i = arguments.length;

        while (i--) {

            for (var m in arguments[i]) {
                this[m] = arguments[i][m];
            }
        }

        return MasterControl;
    }

    // extends class methods to be used inside of the view class using the THIS keyword
    extendView( name, element){
        var $that = this;
        var propertyNames = Object.getOwnPropertyNames( element.__proto__);
        this.viewList[name] = {};
        for(var i in propertyNames){
            if(propertyNames !== "constructor"){
                if (propertyNames.hasOwnProperty(i)) {
                    $that.viewList[name][propertyNames[i]] = element[propertyNames[i]];
                }
            }
        };
    }

    // extends class methods to be used inside of the controller class using the THIS keyword
    extendController(element){
        
        var $that = this;
        var propertyNames = Object.getOwnPropertyNames( element.__proto__);
        for(var i in propertyNames){
            if(propertyNames !== "constructor"){
                if (propertyNames.hasOwnProperty(i)) {
                    $that.controllerList[propertyNames[i]] = element[propertyNames[i]];
                }
            }
        };
    }
    
    // adds your class to the --------- todo
    register(name, param){
        if(name && param){
            this.requestList[name] = param;
        }
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
            require(`${this.root}/config/load`)(requestObject);
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
