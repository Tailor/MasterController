// MasterSession - by Alexander Batista - Tailer 2017 - MIT Licensed 
// version 1.0.12 - beta -- node compatiable

var master = require('./MasterControl');
var cookie = require('cookie');
var tools = master.tools;

class MasterSession{

    sessions = {};
    
    init(options){

        if(options.secret === undefined){
            throw "sessions must have secret";
        };
        var defaultOpt = {
            path:'/',
            domain: undefined,
            encode : undefined,
            maxAge: 60 * 60 * 24 * 7 ,
            expires : undefined ,
            secure:false,
            httpOnly:true,
            sameSite : false,
        };

        this.options = tools.combineObjects(options, defaultOpt);
    }

    setCookie(name, payload, encrypted, response, opt){

        opt = typeof opt === "undefined" ? {} : opt;
        var options = tools.combineObjects(this.options, opt);
        var encrypted = encrypted === undefined ? false : true;
        if(encrypted === true){
            response.setHeader('Set-Cookie', cookie.serialize(name, tools.encrypt(payload, options.secret), options));
        }
        else{
            response.setHeader('Set-Cookie', cookie.serialize(name, JSON.stringify(payload), options));
        }
    }

    getCookie (name, request, encrypted){
        var encrypted = encrypted === undefined ? false : true;
        var cooks = cookie.parse(request.headers.cookie || '');
        if(cooks !== undefined){
            if(encrypted === false){
                return cooks[name] === undefined ? -1 : cooks[name];
            }
            else{
                if(cooks[name] === undefined){
                    return -1
                }
                else{
                    return tools.decrypt(cooks[name], this.options.secret);
                }
               
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

    delete(name, response){
        var sessionID = sessions[name];
        this.options.expires = new Date(0);
        response.setHeader('Set-Cookie', cookie.serialize(sessionID, "", this.options));
        delete this.sessions[name];
        this.options.expires = undefined;
    }

    reset(){
        this.sessions = {};
    }

    set(name, payload, encrypted, opt, response){
        opt = typeof opt === "undefined" ? {} : opt;
        var options = tools.combineObjects(this.options, opt);
        var encrypted = encrypted === undefined ? false : true;

        var sessionID = tools.generateRandomKey('sha256');
        this.sessions[name] = sessionID;
        if(encrypted === true){
            response.setHeader('Set-Cookie', cookie.serialize(sessionID, tools.encrypt(payload, options.secret), options));
        }
        else{
            response.setHeader('Set-Cookie', cookie.serialize(sessionID, JSON.stringify(payload), options));
        }
    }

    get(name, encrypted, request){
        var encrypted = encrypted === undefined ? false : true;
        var sessionID = this.sessions[name];
        if(sessionID !== undefined){
            var cooks = cookie.parse(request.headers.cookie || '');
            if(cooks !== undefined){
                if(encrypted === false){
                    return cooks[sessionID];
                }
                else{
                   return tools.decrypt(cooks[sessionID], this.options.secret);
                }
            }
        }
        else{
            return -1;
        }
    }
}

master.extend({sessions: new MasterSession() });