// MasterControl - by Alexander Batista - Tailor 2017 - MIT Licensed
// version 1.0.15
// TODO: CONTROL MaxRequestLength IN SETTINGS SO THAT WE CAN CHECK AND RETURN

var url = require('url');
var fileserver = require('fs');

class MasterControl {
    controllerList = {}
    viewList = {}
    requestList = {}
    _root = null
    _environmentType = null

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
    
    register(name, param){
        if(name && param){
            this.requestList[name] = param;
        }
    }

    get env(){
        return require(`${this.root}/config/environments/env.${this.environmentType}.json`);
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

    setupServer(http, httpPort, requestTimeout){
        if(http || httpPort || requestTimeout){
            this.server.timeout = requestTimeout;
            this.server.listen(httpPort, http);          
        }
        else{
            throw "HTTP, HTTPPORT and REQUEST TIMEOUT MISSING";
        }

    }

    // builds and calls all the required tools to have master running completely
    start(server, requiredList){
        this.server = server;
        if(!requiredList){
            requiredList =  ["MasterError", "MasterRouter", "MasterHtml", "MasterTemp" , "MasterAction", "MasterActionFilters", "MasterSocket", "MasterJWT", "MasterSession", "MasterRequest"];
        }
        for(var i = 0; i < requiredList.length; i++){
            require('./' + requiredList[i]);
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
