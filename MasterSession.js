// MasterSession - by Alexander Batista - Tailer 2017 - MIT Licensed 
// version 1.0.12 - beta -- node compatiable

var master = require('./MasterControl');
var crypto = require('crypto');
var cookie = require('cookie');

var encrypt = function(payload, secret, algorithm ){
    const hash = crypto.createHash("sha1");
    hash.update(secret);
    var key = Buffer.from(hash.digest("hex").substring(0, 16), "hex");
    var algorithm = algorithm === undefined ? 'aes-256-ctr': algorithm;
    var cipher = crypto.createCipher(algorithm,  key);
    var crypted = cipher.update(payload,'utf8','hex');
    crypted += cipher.final('hex');
    return crypted;
};

var decrypt = function(encryption, secret, algorithm){
      const hash = crypto.createHash("sha1");
      hash.update(secret);
      var key = Buffer.from(hash.digest("hex").substring(0, 16), "hex");
      var algorithm = algorithm === undefined ? 'aes-256-ctr': algorithm;
      var decipher = crypto.createDecipher(algorithm, key);
      var dec = decipher.update(encryption,'hex','utf8');
      dec += decipher.final('utf8');
      return dec;
};

var combine = function(obj, src) {
    Object.keys(src).forEach(function(key) { obj[key] = src[key]; });
    return obj;
};

var generateRandomKey = function(hash) {
    var sha = crypto.createHash(hash);
    sha.update(Math.random().toString());
    return sha.digest('hex');
};

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

        this.options = combine(options, defaultOpt);
    }

    setCookie(name, payload, encrypted, response, opt){

        opt = typeof opt === "undefined" ? {} : opt;
        var options = combine(this.options, opt);
        var encrypted = encrypted === undefined ? false : true;
        if(encrypted === true){
            response.setHeader('Set-Cookie', cookie.serialize(name, encrypt(payload, options.secret), options));
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
                    return decrypt(cooks[name], this.options.secret);
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
        var options = combine(this.options, opt);
        var encrypted = encrypted === undefined ? false : true;

        var sessionID = generateRandomKey('sha256');
        this.sessions[name] = sessionID;
        if(encrypted === true){
            response.setHeader('Set-Cookie', cookie.serialize(sessionID, encrypt(payload, options.secret), options));
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
                   return decrypt(cooks[sessionID], this.options.secret);
                }
            }
        }
        else{
            return -1;
        }
    }
}

master.extend({sessions: new MasterSession() });