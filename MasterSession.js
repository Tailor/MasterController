 
// version 0.0.22

var master = require('./MasterControl');
var cookie = require('cookie');
var toolClass =  require('./MasterTools');
var crypto = require('crypto');
var tools = new toolClass();

class MasterSession{
 
    sessions = {};
    options = {
        domain: undefined,
        encode : undefined,
        maxAge: 900000,
        expires : undefined ,
        secure:false,
        httpOnly:true,
        sameSite : true,
        path : '/',
        secret : this.createSessionID()
    };

    init(options){
        var $that = this;

        // Combine the rest of the options carefully
        this.options = {
            ...this.options,
            ...options
        };

        if(this.options.TID){
            this.options.secret = TID;
        }

        // Auto-register with pipeline if available
        if (master.pipeline) {
            master.pipeline.use(this.middleware());
        }

        return {
            setPath : function(path){
                $that.options.path = path === undefined ? '/' : path;
                return this;
            },
            sameSiteTrue : function(){
                $that.options.sameSite = true;
                return this;
            },
            sameSiteFalse : function(){
                $that.options.sameSite = false;
                return this;
            },
            httpOnlyTrue : function(){
                $that.options.httpOnly = true;
                return this;
            },
            httpOnlyFalse : function(){
                $that.options.httpOnly = false;
                return this;
            },
            secureTrue : function(){
                $that.options.secure = true;
                return this;
            },
            securefalse : function(){
                $that.options.secure = false;
                return this;
            },
            expires : function(exp){
                $that.options.expires = exp === undefined ? undefined : exp;
                return this;
            },
            maxAge : function(num){
                $that.options.maxAge = num === undefined ? 0 : num;
                return this;
            },
            encode: function(func){
                $that.options.encode = func;
                return this;
            },
            domain : function(dom){
                $that.options.domain = dom;
                return this;
            }
        };
    }

    createSessionID(){
        return crypto.randomBytes(20).toString('hex');
    }

    getSessionID(){
         return this.secret;
    }

    setCookie(name, payload, response, options){
        var cookieOpt = options === undefined? this.options : options;
        if(typeof options === "object"){
            if(options.secret){
                response.setHeader('Set-Cookie', cookie.serialize(name, tools.encrypt(payload, cookieOpt.secret), cookieOpt));
            }else{

                response.setHeader('Set-Cookie', cookie.serialize(name, payload, cookieOpt));
       
            }

        }
        else{
            response.setHeader('Set-Cookie', cookie.serialize(name, payload, cookieOpt));
        }
    }

    getCookie (name, request, secret){
        var cooks = cookie.parse(request.headers.cookie || '');

        if(cooks){
            if(cooks[name] === undefined){
                return -1;
            }
            if(secret === undefined){
                if(cooks[name]){
                    return cooks[name];
                }
                else{
                    return  -1;
                }
                //return cooks[name]? -1 : cooks[name];
            }
            else{
                return tools.decrypt(cooks[name], secret);
            }
        }
        else{
            return -1;
        }
    }

    deleteCookie (name, response, options){
        var cookieOpt = options === undefined? this.options : options;
        response.setHeader('Set-Cookie', cookie.serialize(name, "", cookieOpt));
        cookieOpt.expires = undefined;
    }

    // delete session and cookie
    delete(name, response){
        var sessionID = sessions[name];
        this.options.expires = new Date(0);
        response.setHeader('Set-Cookie', cookie.serialize(sessionID, "", this.options));
        delete this.sessions[name];
        this.options.expires = undefined;
    }

    // resets all sessions
    reset(){
        this.sessions = {};
    }

    // sets session with random id to get cookie
    set(name, payload, response, secret, options){
        var cookieOpt = options === undefined? this.options : options; 
        var sessionID = this.createSessionID();
        this.sessions[name] = sessionID;
        if(secret === undefined){
            response.setHeader('Set-Cookie', cookie.serialize(sessionID, JSON.stringify(payload), cookieOpt));
        }
        else{
            response.setHeader('Set-Cookie', cookie.serialize(sessionID, tools.encrypt(payload, secret), cookieOpt));
        }
    }

    // gets session then gets cookie
    get(name, request, secret){
        var sessionID = this.sessions[name];
        if(sessionID){
            var cooks = cookie.parse(request.headers.cookie || '');
            if(cooks){
                if(secret === undefined){
                    return cooks[sessionID];
                }
                else{
                   return tools.decrypt(cooks[sessionID], secret);
                }
            }
        }
        else{
            return -1;
        }
    }

    /**
     * Get session middleware for the pipeline
     * Sessions are accessed lazily via master.sessions in controllers
     */
    middleware() {
        var $that = this;

        return async (ctx, next) => {
            // Sessions are available via master.sessions.get/set in controllers
            // No action needed here - just continue pipeline
            await next();
        };
    }
}

master.extend("sessions", MasterSession);