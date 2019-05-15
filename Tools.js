var busboy = require('busboy');
var url = require('url');

class Tools{
    static combineObjandArray(data, objParams){

        if(Array.isArray(data)=== false){
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

    static isFunction(obj) {
        return !!(obj && obj.constructor && obj.call && obj.apply);
    };

    static combineObjects(obj, src) {
        obj = Object.prototype.toString.call(obj) === "[object Object]" ?  obj : {};
        Object.keys(src).forEach(function(key) { obj[key] = src[key]; });
        return obj;
    };

    static convertArrayToObject(obj, keyPath, value) {
        lastKeyIndex = keyPath.length-1;
        for (var i = 0; i < lastKeyIndex; ++ i) {
          key = keyPath[i];
          if (!(key in obj))
            obj[key] = {}
          obj = obj[key];
        }
        obj[keyPath[lastKeyIndex]] = value;
     };
    
    static _getRequestParam(request, type){
        var $that = this;
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
                        $that.convertArrayToObject(body, dotNotation, val);
                    
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
    
}


module.exports = Tools;