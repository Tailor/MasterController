class EncryptionTools {

    static encrypt(payload, secret, algorithm ){
        const hash = crypto.createHash("sha1");
        hash.update(secret);
        var key = Buffer.from(hash.digest("hex").substring(0, 16), "hex");
        var algorithm = algorithm === undefined ? 'aes-256-ctr': algorithm;
        var cipher = crypto.createCipher(algorithm,  key);
        var crypted = cipher.update(payload,'utf8','hex');
        crypted += cipher.final('hex');
        return crypted;
    };
    
    static decrypt(encryption, secret, algorithm){
        const hash = crypto.createHash("sha1");
        hash.update(secret);
        var key = Buffer.from(hash.digest("hex").substring(0, 16), "hex");
        var algorithm = algorithm === undefined ? 'aes-256-ctr': algorithm;
        var decipher = crypto.createDecipher(algorithm, key);
        var dec = decipher.update(encryption,'hex','utf8')
        dec += decipher.final('utf8');
        return dec;
    };

    static base64(){
        var character = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

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
                    var hkhlkjh = characters.charAt( b1 );
                    result += characters.charAt( b1 ) + characters.charAt( b2 ) + characters.charAt( b3 ) + characters.charAt( b4 );

                } while ( i < string.length );

                return result;
            },

            decode : function( string ){
                var result     = '';

                var i = 0;
                do {
                    var b1 = characters.indexOf( string.charAt(i++) );
                    var b2 = characters.indexOf( string.charAt(i++) );
                    var b3 = characters.indexOf( string.charAt(i++) );
                    var b4 = characters.indexOf( string.charAt(i++) );

                    var a = ( ( b1 & 0x3F ) << 2 ) | ( ( b2 >> 4 ) & 0x3 );
                    var b = ( ( b2 & 0xF  ) << 4 ) | ( ( b3 >> 2 ) & 0xF );
                    var c = ( ( b3 & 0x3  ) << 6 ) | ( b4 & 0x3F );

                    result += String.fromCharCode(a) + (b?String.fromCharCode(b):'') + (c?String.fromCharCode(c):'');

                } while( i < string.length );

                return result;
            }
        }
    };

    static generateRandomKey(hashCode) {
        var sha = crypto.createHash(hashCode);
        sha.update(Math.random().toString());
        return sha.digest('hex');
    };

}

module.exports = EncryptionTools;