
// version 1.0.15 - beta -- node compatiable

var master = require('./MasterControl');
var url = require('url');
const StringDecoder = require('string_decoder').StringDecoder;
var qs = require('qs');
const formidable = require('formidable');
var contentTypeManager = require("content-type");
var path = require('path');
const fs = require('fs');

class MasterRequest{
   parsedURL = {};
    request = {};
    response = {};

   init(options){
     if(options){
        this.options = {};
        this.options.disableFormidableMultipartFormData = options.disableFormidableMultipartFormData === null? false : options.disableFormidableMultipartFormData;
        this.options.formidable = options.formidable === null? {}: options.formidable;
     }
   }

   getRequestParam(request, res){
    var $that = this;
    $that.response = res;
    try {
        return new Promise(function (resolve, reject) {
            var querydata = url.parse(request.requrl, true);
            $that.parsedURL.query = querydata.query;
            $that.form = new formidable.IncomingForm($that.options.formidable);
            if(request.headers['content-type'] || request.headers['transfer-encoding'] ){
                    var contentType = contentTypeManager.parse(request);
                    switch(contentType.type){
                        case "application/x-www-form-urlencoded":
                            $that.urlEncodeStream(request, function(data){
                                $that.parsedURL.formData = data;
                                resolve($that.parsedURL);
                            });                      
                        break 
                        case "multipart/form-data" :
                            // Offer operturnity to add options. find a way to add dependecy injection. to request
                            if(!$that.options.disableFormidableMultipartFormData){
                            
                                $that.parsedURL.formData = {
                                    files : {},
                                    fields : {}
                                };

                                $that.form.on('field', function(field, value) {
                                    $that.parsedURL.formData.fields[field] = value;
                                });

                                $that.form.on('file', function(field, file) {
                                    file.extension = path.extname(file.name);
                                    if(Array.isArray($that.parsedURL.formData.files[field])){
                                        $that.parsedURL.formData.files[field].push(file);
                                    }
                                    else{
                                        $that.parsedURL.formData.files[field] = [];
                                        $that.parsedURL.formData.files[field].push(file);
                                    }
                                });

                                $that.form.on('end', function() {
                                    resolve($that.parsedURL);
                                });

                                $that.form.parse(request);
                
                            }else{
                                
                                resolve($that.parsedURL);
                                console.log("skipped multipart/form-data")
                            }
                        break
                        case "application/json" :
                            $that.jsonStream(request, function(data){
                                $that.parsedURL.formData = data;
                                resolve($that.parsedURL);
                            });  

                        break
                        case "text/html" : 
                            $that.textStream(request, function(data){
                                $that.parsedURL.formData = {};
                                $that.parsedURL.formData.textField = data;
                                resolve(newbody);
                            });  

                        break
                        default:
                            resolve(newbody);
                            console.log(`Cannot parse - We currently support text/html, application/json, multipart/form-data, and application/x-www-form-urlencoded - your sending us = ${formType[0]}`);
                      }

                }
                else{
                    resolve($that.parsedURL);
                }
        });

      }
      catch (ex) {
          throw ex;
      }
  };

  deleteFileBuffer(filePath){
    fs.unlink(filePath, function (err) {
        if (err) {
          console.error(err);
        }
        console.log('Temp File Delete');
      });
}

  urlEncodeStream(request, func){
      const decoder = new StringDecoder('utf-8');
      //request.pipe(decoder);
      let buffer = '';
      request.on('data', (chunk) => {
          buffer += decoder.write(chunk);
      });

      request.on('end', () => {
          buffer += decoder.end();
          var buff = qs.parse(buffer);
          func(buff);
      });

  }
  
  jsonStream(request, func){
      //request.pipe(decoder);
      let buffer = '';
      request.on('data', (chunk) => {
          buffer += chunk;
      });

      request.on('end', () => {
          var buff = qs.parse(buffer);
          func(buff);
      });

  }

  textStream(request, func){
      const decoder = new StringDecoder('utf-8');
      //request.pipe(decoder);
      let buffer = '';
      request.on('data', (chunk) => {
          buffer += decoder.write(chunk);
      });

      request.on('end', () => {
          buffer += decoder.end();
          func(buffer);
      });

  }

  // have a clear all object that you can run that will delete all rununing objects
    clear(code, end){
        this.parsedURL = {}; 
        master.action.close(this.response, code, contentTypeManager.parse(this.request), end);
    }
}

master.extend({request: new MasterRequest()});