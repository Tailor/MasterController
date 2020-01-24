// MasterControl - by Alexander Batista - Tailor 2017 - MIT Licensed
// version 1.0.3
var url = require('url');
var fileserver = require('fs');
var busboy = require('busboy');

// gets and converts data and puts it into the params object
var _getRequestParam = function(request, type){

    try {
            // routing get data sent through request
            if(type === "get"){
                var parsedURL = url.parse(request.requrl, true);
                return parsedURL.query;
            }

            // routing Post data sent through request
            if (type === "post" || type === "put") {

                var body = {};
                body.files = [];

                var form = new busboy({ headers: request.headers });

                form.on('field', function(fieldname, val, fieldnameTruncated, valTruncated) {
                    var dotNotation = fieldname.replace(/[\[\]']+/g,',').replace(/,\s*$/, "").split(",");
                    master.tools.convertArrayToObject(body, dotNotation, val);

                });

                form.on('file', function(fieldname, file, filename, encoding, mimetype) {

                    if(body.files){
                        body.files.push({
                            fieldname : fieldname,
                            file : file,
                            filename : filename,
                            mimetype :  mimetype
                        });
                    }

                });

                request.pipe(form);

                return new Promise(function (resolve, reject) {
                    request.on('end', function () {
                        //var query = qs.parse(body);
                        return resolve(body);
                    });
                });
            }
        }
        catch (ex) {
            throw ex;
        }
};

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


    // extends class methods to be used inside of the controller class using the THIS keyword
    extendController(element){
        if(element.prototype === undefined) {
            throw "cannot extend controller using an instantiated class";
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

    // extends class methods to be used inside of the view class using the THIS keyword
    extendView(element, name){
        if(element.prototype === undefined) {
            throw "cannot extend view using an instantiated class";
        }
        else{
            var propertyNames = Object.getOwnPropertyNames(element.prototype);
            var elementInstance = new element();
            var name = elementInstance.constructor.name;
            this.viewList[name] = {};
            for(var i in propertyNames){
                if (propertyNames.hasOwnProperty(i)) {
                    this.viewList[name][propertyNames[i]] = elementInstance[propertyNames[i]];
				}
            };
        }
    }

    register(param, name){
        var className = name === undefined ? param.constructor.name : name;
        this.requestList[className] = param;
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
        this.server.timeout = requestTimeout;
        this.server.listen(httpPort, http);
    }

    // builds and calls all the required tools to have master running completely
    start(server){
        this.server = server;
        var requiredList = ["MasterError", "MasterTools", "MasterRouter", "MasterHtml", "MasterTemp" , "MasterAction", "MasterActionFilters", "MasterSocket", "MasterJWT", "MasterSession"]
        for(var i = 0; i < requiredList.length; i++){
            require('./' + requiredList[i]);
        }
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
            var params = await _getRequestParam(request, request.method.toLowerCase());
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

var master = require('./MasterControl');
