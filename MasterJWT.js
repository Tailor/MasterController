// MasterSession - by Alexander Batista - Tailer 2017 - MIT Licensed 
// version 1.0.12 - beta -- node compatiable

var master = require('./MasterControl');
var crypto = require('crypto');
var tools =  master.tools;

 //https://www.youtube.com/watch?v=67mezK3NzpU&t=2492s
class MasterJWT{
    
        init(options){
            this.alg = typeof options.algorithm === "undefined" ? "sha256": options.algorithm;

            if(options.secret === undefined){
                throw "jwt must have secret";
            };
            
            this.secret = options.secret;
        }

        create(payload, encrypted, encryptionKey){
            var hmac = null;
            var now = new Date();
            var twoHoursLater = new Date(now.getTime() + (2*1000*60*60))
            var encrypted = typeof encrypted === "undefined" ? false : true;
            var encodePayload = null;
            
            if(typeof payload === "string"){
                throw "payload must be object not string";
            }

            var header = {
                    typ: 'JWT',
                    alg: this.alg
            };

            var body = {
                jti: tools.generateRandomKey('sha256'),
                iat: Math.floor(new Date() / 1000),
                exp: twoHoursLater
                };

            body = tools.combineObjects(body, payload);
            
            if(encrypted === true){
                header["encrypt"] = 'aes-256-ctr';
                if(encryptionKey ===  undefined){
                    encodePayload =  tools.base64().encode(tools.encrypt(JSON.stringify(body), this.secret));
                }else{
                    encodePayload =  tools.base64().encode(tools.encrypt(JSON.stringify(body), encryptionKey));
                }
            }
            else{
                encodePayload =  tools.base64().encode(JSON.stringify(body));
            }

            
            if(encryptionKey ===  undefined){
                hmac = crypto.createHmac(this.alg, this.secret);
            }else{
                hmac = crypto.createHmac(this.alg, encryptionKey);
            }

            var encodeHeader = tools.base64().encode(JSON.stringify(header));
            hmac.update(encodeHeader + "." + encodePayload);
            var sig = hmac.digest('base64');
            
            return encodeHeader + "." + encodePayload + "." + sig;
        }

        verify(signature, encrypted, secret){
            var secret = secret === undefined ? this.secret : secret;
            var encrypted = typeof encrypted === "undefined" ? false : true;
            var jwt = signature.split(".");
            var decodeHeader = JSON.parse(tools.base64().decode(jwt[0]));

            var hmac = crypto.createHmac(decodeHeader.alg, secret );
            hmac.update(jwt[0] + "." + jwt[1]);
            var ourSignature = hmac.digest('base64');

            if(ourSignature === jwt[2]){
                // if they are the same return json payload or un ecrypt payload
                var decodePayload = tools.base64().decode(jwt[1]);
                if(encrypted === true){
                    var decryptPayload = JSON.parse(tools.decrypt(decodePayload, secret ));
                    return decryptPayload;
                }
                else{
                    return decodePayload;
                }
            }
            else{
                return -1;
            }
        }

        // creates and sends to cookie
        // set(name, payload, encrypted, response, encryptionKey){
        //     if(typeof payload === "string"){
        //         throw "payload must be object not string";
        //     }
        //     var encrypted = typeof encrypted === "undefined" ? false : encrypted;
        //     var sig = this.sign(payload, encrypted, encryptionKey);
        //     master.sessions.setCookie(name, sig, encrypted, response);
        //     return sig;
        // }

        // get(name, request, encrypted){
        //     var encrypted = typeof encrypted === "undefined" ? false : true;
        //     var cook = master.sessions.getCookie(name, request, encrypted );
        //     var valid = "";
        //     if(cook !== -1 && cook !== ""){
        //         valid = this.verify(cook, encrypted);
        //         if(valid !== -1){
        //             return valid;
        //         }
        //     }else{
        //         return -1;
        //     }
        // }
}


master.extend({jwt: new MasterJWT() });