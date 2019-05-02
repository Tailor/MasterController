
var url = require('url');
var fileserver = require('fs');
var tools = require('./Tools');

// MasterControl - by Alexander Batista - Tailor 2017 - MIT Licensed 
// version 1.0.14 - beta -- node compatiable
class MasterControl {
    constructor() {
        this.controllerList = {};
    }

    // this extends master framework
    extend(){
        var i = arguments.length;

        while (i--) {

            for (var m in arguments[i]) {
                this[m] = arguments[i][m];
            }
        }
        
        return MasterControl;
    }


    // extends class methods to be used inside of the controller class using the THIS keyword
    extendController(element){
        if(element.prototype === undefined) {
            throw "cannot extend extend controller using an instantiated class";
        }
        else{
            var propertyNames = Object.getOwnPropertyNames(element.prototype);
            var elementInstance = new element();
            for(var i in propertyNames){
                if (propertyNames.hasOwnProperty(i)) {
                    this.controllerList[propertyNames[i]] = elementInstance[propertyNames[i]];
				}
            };
        }
    }

    appendControllerMethodsToClass(that){
        for(var i in this.controllerList){
            that.prototype[i] = this.controllerList[i];
        };
        return that;
    }

    // builds and calls all the required tools to have master running completely
    require(requ){
        var requiredList = requ;
        this.controllerObject = {};
        // call all the required parts
        for(var i = 0; i < requiredList.length; i++){
            require('./' + requiredList[i]);
        }
    }

    init(env){
        env = env === undefined ? "development" : env;
        var masterEnv = require(this.root + "/config/environments/env." + env);
        if(Object.keys(masterEnv).length === 0 && masterEnv.constructor === Object){
            throw("Environment " + this._env + " not defined", "error");
        };
        this.env = masterEnv;
        this.env.type = env;
    }

    // will take the repsonse and request objetc and add to it
    async middleware(request, response){
        request.requrl = url.parse(request.url, true);

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
            var params = await tools._getRequestParam(request, request.method.toLowerCase());
            return {
                request : request,
                response : response,
                baseUrl : this.root,
                environment : this._env,
                pathName : request.requrl.pathname,
                type: request.method.toLowerCase(),
                params : params
            }

        }
    }
};


module.exports = new MasterControl();
