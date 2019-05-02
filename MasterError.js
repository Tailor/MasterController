// MasterError- by Alexander Batista - Tailer 2017 - MIT Licensed 
// version 1.0.12 - beta -- node compatiable

var master = require('./MasterControl');
var winston = require('winston');
var fileserver = require('fs');
var logger = "";
var statuses = [];


class MasterError{

    init(statusCodes){

        var that = this;
        this.statusCodes = statusCodes;
        this.env = master.env.type;
        this._baseUrl = master.root;

        logger = winston.createLogger({
            format: winston.format.json(),
            transports: [
                  new winston.transports.Console(),
                  new winston.transports.File({ filename: this._baseUrl + '/log/'+ that.env +'.log' })
              ]
          });
        
        // will catch all promise exceptions
        process.on('unhandledRejection', function (reason, promise) {
            that.log(reason, "warn");
        });
    }
    
    // log your error
    log(msg, level){

        var level = level === undefined ? "info": level;
        if(msg === undefined){
            throw "error has been thrown with no message.";
        };
        if(logger === ""){
            throw "error init function has not been called.";
        };
        
        var message = msg.message === undefined ? msg : msg.message;
    
        logger.log({
            level: level,
            message: message,
            stack : msg.stack
        });
    }

    clearStatuses(){
        statuses = [];
    }

    // add error status functions
    httpStatus(){
        // loop through object and add all codes
        for (var code in this.statusCodes.error) {
            // skip loop if the property is from prototype
            if (!statusCodes.error.hasOwnProperty(code)) continue;

            statuses.push({
                code: code,
                route : statusCodes.error[code],
                folder: statusCodes.publicfolder
            });
           
        }
    }

    // call error status by status code
    callHttpStatus(statusCode, response){
        try{
            var that = this;
            var status = statuses;
            var res = response;
            if(status.length !== 0){
                if(Number.isInteger(statusCode) ){
                    for (var i = 0; i < status.length; i++) {
                            if(parseInt(status[i].code) === statusCode){
                                var location = status[i].route.replace(/^\/|\/$/g, '');
                                var html = fileserver.readFileSync(that._baseUrl + "/" + status[i].folder + "/" + location, 'utf8' );
                                if (!res.headersSent) {
                                        res.writeHead(200, {'Content-Type': 'text/html'});
                                        res.write(html, 'utf8');
                                        res.end();
                                }
                            }
                    };
                }
                else{
                    this.log("The HTTP status added is not a number","error");
                    throw "The HTTP status added is not a number";
                }
            }
            else{
                this.log("No error http statuses have been added", "error");
                throw "No error http statuses have been added";
            }
        }
        catch(err){
            this.log(err, "error");
            throw err;
        }
    }
}

master.extend({error: new MasterError()});

// ================ CODES YOU CAN USE ================ //
// ACCEPTED    202 Accepted
// BAD_GATEWAY 502 Bad Gateway
// BAD_REQUEST 400 Bad Request
// CONFLICT    409 Conflict
// CONTINUE    100 Continue
// CREATED 201 Created
// EXPECTATION_FAILED  417 Expectation Failed
// FAILED_DEPENDENCY   424 Failed Dependency
// FORBIDDEN   403 Forbidden
// GATEWAY_TIMEOUT 504 Gateway Timeout
// GONE    410 Gone
// HTTP_VERSION_NOT_SUPPORTED  505 HTTP Version Not Supported
// IM_A_TEAPOT 418 I'm a teapot
// INSUFFICIENT_SPACE_ON_RESOURCE  419 Insufficient Space on Resource
// INSUFFICIENT_STORAGE    507 Insufficient Storage
// INTERNAL_SERVER_ERROR   500 Server Error
// LENGTH_REQUIRED 411 Length Required
// LOCKED  423 Locked
// METHOD_FAILURE  420 Method Failure
// METHOD_NOT_ALLOWED  405 Method Not Allowed
// MOVED_PERMANENTLY   301 Moved Permanently
// MOVED_TEMPORARILY   302 Moved Temporarily
// MULTI_STATUS    207 Multi-Status
// MULTIPLE_CHOICES    300 Multiple Choices
// NETWORK_AUTHENTICATION_REQUIRED 511 Network Authentication Required
// NO_CONTENT  204 No Content
// NON_AUTHORITATIVE_INFORMATION   203 Non Authoritative Information
// NOT_ACCEPTABLE  406 Not Acceptable
// NOT_FOUND   404 Not Found
// NOT_IMPLEMENTED 501 Not Implemented
// NOT_MODIFIED    304 Not Modified
// OK  200 OK
// PARTIAL_CONTENT 206 Partial Content
// PAYMENT_REQUIRED    402 Payment Required
// PERMANENT_REDIRECT  308 Permanent Redirect
// PRECONDITION_FAILED 412 Precondition Failed
// PRECONDITION_REQUIRED   428 Precondition Required
// PROCESSING  102 Processing
// PROXY_AUTHENTICATION_REQUIRED   407 Proxy Authentication Required
// REQUEST_HEADER_FIELDS_TOO_LARGE 431 Request Header Fields Too Large
// REQUEST_TIMEOUT 408 Request Timeout
// REQUEST_TOO_LONG    413 Request Entity Too Large
// REQUEST_URI_TOO_LONG    414 Request-URI Too Long
// REQUESTED_RANGE_NOT_SATISFIABLE 416 Requested Range Not Satisfiable
// RESET_CONTENT   205 Reset Content
// SEE_OTHER   303 See Other
// SERVICE_UNAVAILABLE 503 Service Unavailable
// SWITCHING_PROTOCOLS 101 Switching Protocols
// TEMPORARY_REDIRECT  307 Temporary Redirect
// TOO_MANY_REQUESTS   429 Too Many Requests
// UNAUTHORIZED    401 Unauthorized
// UNPROCESSABLE_ENTITY    422 Unprocessable Entity
// UNSUPPORTED_MEDIA_TYPE  415 Unsupported Media Type
// USE_PROXY   305 Use Proxy
