// version 0.0.2
var crypto = require('crypto');

class MasterTools{
    characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

    isObjLiteral(_obj) {
        var _test  = _obj;
        return (  typeof _obj !== 'object' || _obj === null ?
                    false :  
                    (
                      (function () {
                        while (!false) {
                          if (  Object.getPrototypeOf( _test = Object.getPrototypeOf(_test)  ) === null) {
                            break;
                          }      
                        }
                        return Object.getPrototypeOf(_obj) === _test;
                      })()
                    )
                );
    }

    // this will remove everthing from back slash amount
    removeBackwardSlashSection(string, amount, type){
        type = type === undefined ? "\\" : type;
        var stringArray =  string.split(type);
        for(var i = 0; i < amount; i++){
            stringArray.pop();
        }
        return stringArray.join(type);
    }

    // return only the number of back slash amount
    getBackSlashBySection(string, amount, type){
        type = type === undefined ? "\\" : type;
        var stringArray =  string.split(type);
        var newStringArray = [];
        for(var i = 0; i < amount; i++){
            newStringArray.unshift(stringArray.pop());
        }
        return newStringArray.join(type);
    }

    firstLetterUppercase(string){
        return string.charAt(0).toUpperCase() + string.slice(1);
    };
   
    firstLetterlowercase(string){
       return string.charAt(0).toLowerCase() + string.slice(1);
    };
   
    encrypt(payload, secret){
        // Generate random IV (16 bytes for AES)
        const iv = crypto.randomBytes(16);

        // Create 256-bit key from secret
        const key = crypto.createHash('sha256').update(String(secret)).digest();

        // Create cipher with AES-256-CBC
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);

        // Encrypt payload
        let encrypted = cipher.update(String(payload), 'utf8', 'hex');
        encrypted += cipher.final('hex');

        // Prepend IV to encrypted data (IV is not secret, needed for decryption)
        return iv.toString('hex') + ':' + encrypted;
    }

    decrypt(encryption, secret){
        try {
            // Split IV and encrypted data
            const parts = encryption.split(':');
            if (parts.length !== 2) {
                throw new Error('Invalid encrypted data format');
            }

            const iv = Buffer.from(parts[0], 'hex');
            const encryptedData = parts[1];

            // Create 256-bit key from secret
            const key = crypto.createHash('sha256').update(String(secret)).digest();

            // Create decipher
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);

            // Decrypt
            let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
            decrypted += decipher.final('utf8');

            return decrypted;
        } catch (error) {
            throw new Error('Decryption failed: ' + error.message);
        }
    }
    
    generateRandomKey(hash){
        var sha = crypto.createHash(hash);
        sha.update(Math.random().toString());
        return sha.digest('hex');
    }

    base64(){
        var $that = this;
        return {
            encode: function(string){

                var result     = '';

                var i = 0;
                do {
                    var a = string.charCodeAt(i++);
                    var b = string.charCodeAt(i++);
                    var c = string.charCodeAt(i++);

                    a = a ? a : 0;
                    b = b ? b : 0;
                    c = c ? c : 0;

                    var b1 = ( a >> 2 ) & 0x3F;
                    var b2 = ( ( a & 0x3 ) << 4 ) | ( ( b >> 4 ) & 0xF );
                    var b3 = ( ( b & 0xF ) << 2 ) | ( ( c >> 6 ) & 0x3 );
                    var b4 = c & 0x3F;

                    if( ! b ) {
                        b3 = b4 = 64;
                    } else if( ! c ) {
                        b4 = 64;
                    }

                    result += $that.characters.charAt( b1 ) + $that.characters.charAt( b2 ) + $that.characters.charAt( b3 ) + $that.characters.charAt( b4 );

                } while ( i < string.length );

                return result;
            },

            decode : function( string ){
                var result     = '';

                var i = 0;
                do {
                    var b1 = $that.characters.indexOf( string.charAt(i++) );
                    var b2 = $that.characters.indexOf( string.charAt(i++) );
                    var b3 = $that.characters.indexOf( string.charAt(i++) );
                    var b4 = $that.characters.indexOf( string.charAt(i++) );

                    var a = ( ( b1 & 0x3F ) << 2 ) | ( ( b2 >> 4 ) & 0x3 );
                    var b = ( ( b2 & 0xF  ) << 4 ) | ( ( b3 >> 2 ) & 0xF );
                    var c = ( ( b3 & 0x3  ) << 6 ) | ( b4 & 0x3F );

                    result += String.fromCharCode(a) + (b?String.fromCharCode(b):'') + (c?String.fromCharCode(c):'');

                } while( i < string.length );

                return result;
            }
        }
    };

    combineObjandArray(data, objParams){

        if(Array.isArray(data) === false){
            // if data is object
            for (var key in data) {
                if (data.hasOwnProperty(key)) {
                    objParams[key] = data[key];
                }
            };
        }
        else{
            for(var y = 0; y < data.length; y++){
                // inside array we have an object
                for (var key in data[y]) {
                    if (data[y].hasOwnProperty(key)) {
                        objParams[key] = data[y][key];
                    }
                };
            }
        };
    
        return objParams;
    };

    isFunction(obj) {
        return !!(obj && obj.constructor && obj.call && obj.apply);
    };

    combineObjects(obj, src) {
        if(obj){
            for(var i in src){
                obj[i] = src[i];
            };
            return obj;
        }
        else{
            return {}
        }

    };

    makeWordId(length) {
        var result           = '';
        var characters       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
        var charactersLength = characters.length;
        for ( var i = 0; i < length; i++ ) {
           result += characters.charAt(Math.floor(Math.random() * charactersLength));
        }
        return result;
    };
    
    combineObjectPrototype(obj, src) {
        for(var i in src){
            obj.prototype[i] = src[i];
        };
        return obj;
    };

    convertArrayToObject(obj, keyPath, value) {
        var key = null;
       var lastKeyIndex = keyPath.length-1;
        for (var i = 0; i < lastKeyIndex; ++ i) {
          key = keyPath[i];
          if (!(key in obj))
            obj[key] = {}
          obj = obj[key];
        }
        obj[keyPath[lastKeyIndex]] = value;
     };
    
    
}

module.exports = MasterTools;