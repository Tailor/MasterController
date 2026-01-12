
// version 1.0.21 - improved console/error logging with syntax error code frames
var winston = require('winston');
var fileserver = require('fs');
const { request } = require('http');

class MasterError{
    logger = "";
    statuses = [];
    
    init(error){
        var that = this;
        var stat = error;
        this.addStatuses(stat);

        this.logger = winston.createLogger({
            format: winston.format.json(),
            transports: [
                  new winston.transports.Console(),
                  new winston.transports.File({ filename: `${master.root}/log/${master.environmentType}.log` })
              ]
          });
        
		// Global error handlers with better diagnostics (stack and code frame)
		process.on('uncaughtException', function (err) {
			that._reportError(err, 'uncaughtException');
		});

		// will catch all promise exceptions
		process.on('unhandledRejection', function (reason, promise) {
			that._reportError(reason instanceof Error ? reason : new Error(String(reason)), 'unhandledRejection');
		});

		process.on('rejectionHandled', function (reason, promise) {
			that._reportError(reason instanceof Error ? reason : new Error(String(reason)), 'rejectionHandled');
		});

		process.on('warning', function (warning) {
			that._reportError(warning instanceof Error ? warning : new Error(String(warning)), 'warning');
		});
        
    }

    clearStatuses(){
        this.statuses = [];
    }

    // add error status functions
    addStatuses(status){
        // loop through object and add all codes
        for (var code in status) {
            // skip loop if the property is from prototype
            if (!status.hasOwnProperty(code)) continue;

            this.statuses.push({
                code: code,
                route : status[code]
            });
           
        }
    }

    // call error status by status code
    callHttpStatus(statusCode, response){
        try{

            var status = this.statuses;
            var res = response;
            if(status.length !== 0){
                if(Number.isInteger(statusCode) ){
                    for (var i = 0; i < status.length; i++) {
                            if(parseInt(status[i].code) === statusCode){
                                var location = status[i].route;
                                var html = fileserver.readFileSync(`${master.root}/${status[i].route.replace(/^\/|\/$/g, '')}`, 'utf8' );
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
            throw err;
        }
    }

    // log your error
    log(msg, level){

        var level = level === undefined ? "info": level;
        if(msg === undefined){
            throw "error has been thrown with no message.";
        };
        if(this.logger === ""){
            throw "error init function has not been called.";
        };
        
        var message = msg.message === undefined ? msg : msg.message;
    
        this.logger.log({
            level: level,
            message: message,
            stack : msg.stack
        });
    }

	// Enhanced error reporter: logs formatted stack and nearby source code
	_reportError(err, tag){
		try{
			const name = err && err.name ? err.name : 'Error';
			const message = err && err.message ? err.message : String(err);
			const stack = err && err.stack ? String(err.stack) : '';
			const header = `[${tag}] ${name}: ${message}`;
			console.error('\u001b[31m' + header + '\u001b[0m');
			if (stack) {
				console.error(stack);
				const loc = this._extractTopFrame(stack);
				if (loc && loc.file && loc.line) {
					const frame = this._buildCodeFrame(loc.file, loc.line, loc.column);
					if (frame) {
						console.error('\n\u001b[33mCode frame:\u001b[0m');
						console.error(frame);
					}
				}
			}
			this.log(err, 'error');
		} catch(e){
			try { console.error('Error while reporting error:', e); } catch(_) {}
		}
	}

	_extractTopFrame(stack){
		try{
			const lines = stack.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const m = lines[i].match(/\((.*):(\d+):(\d+)\)/) || lines[i].match(/at ([^\s]+):(\d+):(\d+)/);
				if (m) {
					return { file: m[1], line: parseInt(m[2]), column: parseInt(m[3]||'0') };
				}
			}
			return null;
		} catch(_) { return null; }
	}

	_buildCodeFrame(file, line, column){
		try{
			if (!fileserver.existsSync(file)) return null;
			const src = fileserver.readFileSync(file, 'utf8').split(/\r?\n/);
			const start = Math.max(1, line - 3);
			const end = Math.min(src.length, line + 3);
			const digits = String(end).length;
			let out = '';
			for (let i = start; i <= end; i++) {
				const prefix = (i === line ? '>' : ' ') + String(i).padStart(digits, ' ') + ' | ';
				out += prefix + src[i - 1] + '\n';
				if (i === line && column && column > 0) {
					out += ' '.repeat(prefix.length + column - 1) + '^\n';
				}
			}
			return out;
		} catch(_) { return null; }
	}
}

module.exports = { MasterError };

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
