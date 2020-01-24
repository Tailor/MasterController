 
// version 0.0.15

var master = require('./MasterControl');
var cookie = require('cookie');
var tools = master.tools;
var crypto = require('crypto');

class MasterSession{

    sessions = {};
    
    init(options){
        options.secret = this.createSessionID();

        var defaultOpt = {
            domain: undefined,
            encode : undefined,
            maxAge: 60 * 60 * 24 * 7 ,
            expires : undefined ,
            secure:false,
            httpOnly:true,
            sameSite : false,
        };

        this.options = tools.combineObjects(options, defaultOpt);
        var $that = this;
        return {
            cookieName : function(name){
                $that.options.cookieName = name;
            },
            setPath : function(path){
                $that.options.path = path === undefined ? '/' : path;
            }
        };
    }

    createSessionID(){
        return crypto.randomBytes(20).toString('hex');
    }

    getSessionID(){
         return this.secret;
    }

    setCookie(name, payload, response, secret, options){
        var cookieOpt = options === undefined? this.options : options;
        if(secret){
            response.setHeader('Set-Cookie', cookie.serialize(name, tools.encrypt(payload, secret), cookieOpt));
        }
        else{
            response.setHeader('Set-Cookie', cookie.serialize(name, JSON.stringify(payload), cookieOpt));
        }
    }

    getCookie (name, request, secret){
        var cooks = cookie.parse(request.headers.cookie || '');

        if(cooks){
            if(cooks[name] === undefined){
                return -1;
            }
            if(secret === undefined){
                return cooks[name] === undefined ? -1 : cooks[name];
            }
            else{
                return tools.decrypt(cooks[name], secret);
            }
        }
        else{
            return -1;
        }
    }

    deleteCookie (name, response){
        this.options.expires = new Date(0);
        response.setHeader('Set-Cookie', cookie.serialize(name, "", this.options));
        this.options.expires = undefined;
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
    set(name, payload, response, secret){
        var sessionID = this.createSessionID();
        this.sessions[name] = sessionID;
        if(secret === undefined){
            response.setHeader('Set-Cookie', cookie.serialize(sessionID, JSON.stringify(payload), this.options));
        }
        else{
            response.setHeader('Set-Cookie', cookie.serialize(sessionID, tools.encrypt(payload, secret), this.options));
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
}

master.extend({sessions: new MasterSession() });