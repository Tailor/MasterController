
// version 0.0.2

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

    // Lazy-load master to avoid circular dependency (Google-style lazy initialization)
    get _master() {
        if (!this.__masterCache) {
            this.__masterCache = require('./MasterControl');
        }
        return this.__masterCache;
    }

   init(options){
     if(options){
        this.options = {};
        this.options.disableFormidableMultipartFormData = options.disableFormidableMultipartFormData === null? false : options.disableFormidableMultipartFormData;
        this.options.formidable = options.formidable === null? {}: options.formidable;
        // Body size limits (DoS protection)
        this.options.maxBodySize = options.maxBodySize || 10 * 1024 * 1024; // 10MB default
        this.options.maxJsonSize = options.maxJsonSize || 1 * 1024 * 1024;  // 1MB default for JSON
        this.options.maxTextSize = options.maxTextSize || 1 * 1024 * 1024;  // 1MB default for text
     }
   }

   getRequestParam(requestOrContext, res){
    var $that = this;
    $that.response = res;
    try {
        return new Promise(function (resolve, reject) {
            // BACKWARD COMPATIBILITY: Support both old and new patterns
            // New pattern (v1.3.x pipeline): Pass context with requrl property
            // Old pattern (pre-v1.3.x): Pass request with requrl property
            const request = requestOrContext.request || requestOrContext;
            let requrl = requestOrContext.requrl || request.requrl;

            // Fallback: If requrl not set, parse from request.url
            if (!requrl) {
                requrl = url.parse(request.url, true);
            }

            var querydata = url.parse(requrl, true);
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

                                // Track uploaded files for cleanup on error
                                const uploadedFiles = [];
                                let uploadAborted = false;

                                $that.form.on('field', function(field, value) {
                                    $that.parsedURL.formData.fields[field] = value;
                                });

                                $that.form.on('fileBegin', function(formname, file) {
                                    // Track file for potential cleanup
                                    uploadedFiles.push(file);
                                });

                                $that.form.on('file', function(field, file) {
                                    file.extension = file.name === undefined ? path.extname(file.originalFilename) : path.extname(file.name);

                                    if(Array.isArray($that.parsedURL.formData.files[field])){
                                        $that.parsedURL.formData.files[field].push(file);
                                    }
                                    else{
                                        $that.parsedURL.formData.files[field] = [];
                                        $that.parsedURL.formData.files[field].push(file);
                                    }
                                });

                                $that.form.on('error', function(err) {
                                    // CRITICAL: Handle upload errors
                                    uploadAborted = true;
                                    console.error('[MasterRequest] File upload error:', err.message);

                                    // Cleanup temporary files
                                    uploadedFiles.forEach(file => {
                                        if (file.filepath) {
                                            try {
                                                $that.deleteFileBuffer(file.filepath);
                                            } catch (cleanupErr) {
                                                console.error('[MasterRequest] Failed to cleanup temp file:', cleanupErr.message);
                                            }
                                        }
                                    });

                                    reject(new Error(`File upload failed: ${err.message}`));
                                });

                                $that.form.on('aborted', function() {
                                    // CRITICAL: Handle client abort (connection closed)
                                    uploadAborted = true;
                                    console.warn('[MasterRequest] File upload aborted by client');

                                    // Cleanup temporary files
                                    uploadedFiles.forEach(file => {
                                        if (file.filepath) {
                                            try {
                                                $that.deleteFileBuffer(file.filepath);
                                            } catch (cleanupErr) {
                                                console.error('[MasterRequest] Failed to cleanup temp file:', cleanupErr.message);
                                            }
                                        }
                                    });

                                    reject(new Error('File upload aborted by client'));
                                });

                                $that.form.on('end', function() {
                                    // Only resolve if upload wasn't aborted
                                    if (!uploadAborted) {
                                        resolve($that.parsedURL);
                                    }
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
                                resolve($that.parsedURL);
                            });  

                        break
                        case "text/plain" : 
                        $that.fetchData(request, function(data){
                            $that.parsedURL.formData = data;
                            resolve($that.parsedURL);

                        });

                        break
                        default:
                            var errorMessage = `Cannot parse - We currently support text/plain, text/html, application/json, multipart/form-data, and application/x-www-form-urlencoded - your sending us = ${contentType.type}`;
                            resolve(errorMessage);
                            console.log(errorMessage);
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


  fetchData(request, func) {

    let body = '';
    let receivedBytes = 0;
    const maxBytes = 1 * 1024 * 1024; // 1MB limit
    let errorOccurred = false;

    try {

        request.on('data', (chunk) => {
            if (errorOccurred) return;

            receivedBytes += chunk.length;

            // Prevent memory overload
            if (receivedBytes > maxBytes) {
              errorOccurred = true;
              request.destroy(); // ✅ Fixed: was 'req', now 'request'
              console.error(`Plain text payload too large: ${receivedBytes} bytes (max: ${maxBytes})`);
              func({ error: 'Payload too large', maxSize: maxBytes });
              return;
            }

            // Append chunk to body
            body += chunk.toString('utf8');
        });

        request.on('end', () => {
            if (errorOccurred) return;

            try {
                // Process the plain text data here
                const responseData = body;
                func(responseData);
              } catch (err) {
                console.error('Processing error handling text/plain:', err);
                func({ error: err.message });
              }

        });

        request.on('error', (err) => {
            if (errorOccurred) return;
            errorOccurred = true;
            console.error('[MasterRequest] Stream error in fetchData:', err.message);
            func({ error: err.message });
        });

        request.on('aborted', () => {
            if (errorOccurred) return;
            errorOccurred = true;
            console.warn('[MasterRequest] Request aborted in fetchData');
            func({ error: 'Request aborted' });
        });

    } catch (error) {
      console.error("Failed to fetch data:", error);
      func({ error: error.message });
    }
  }

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
      let buffer = '';
      let receivedBytes = 0;
      const maxBytes = this.options.maxBodySize || 10 * 1024 * 1024; // 10MB limit
      let errorOccurred = false;

      request.on('data', (chunk) => {
          if (errorOccurred) return;

          receivedBytes += chunk.length;

          // Prevent memory overload (DoS protection)
          if (receivedBytes > maxBytes) {
              errorOccurred = true;
              request.destroy();
              console.error(`Form data too large: ${receivedBytes} bytes (max: ${maxBytes})`);
              func({ error: 'Payload too large', maxSize: maxBytes });
              return;
          }

          buffer += decoder.write(chunk);
      });

      request.on('end', () => {
          if (errorOccurred) return;

          buffer += decoder.end();
          var buff = qs.parse(buffer);
          func(buff);
      });

      request.on('error', (err) => {
          if (errorOccurred) return;
          errorOccurred = true;
          console.error('[MasterRequest] Stream error in urlEncodeStream:', err.message);
          func({ error: err.message });
      });

      request.on('aborted', () => {
          if (errorOccurred) return;
          errorOccurred = true;
          console.warn('[MasterRequest] Request aborted in urlEncodeStream');
          func({ error: 'Request aborted' });
      });

  }

  jsonStream(request, func){
      let buffer = '';
      let receivedBytes = 0;
      const maxBytes = this.options.maxJsonSize || 1 * 1024 * 1024; // 1MB limit
      let errorOccurred = false;

      request.on('data', (chunk) => {
          if (errorOccurred) return;

          receivedBytes += chunk.length;

          // Prevent memory overload (DoS protection)
          if (receivedBytes > maxBytes) {
              errorOccurred = true;
              request.destroy();
              console.error(`JSON payload too large: ${receivedBytes} bytes (max: ${maxBytes})`);
              func({ error: 'JSON payload too large', maxSize: maxBytes });
              return;
          }

          buffer += chunk;
      });

      request.on('end', () => {
            if (errorOccurred) return;

            // Handle empty body (GET requests, etc.)
            if (buffer.trim() === '') {
                func({});
                return;
            }

            try {
                var buff = JSON.parse(buffer);
                func(buff);
            } catch (e) {
                // Security: Don't fallback to qs.parse to avoid prototype pollution
                console.error('Invalid JSON payload:', e.message);
                func({ error: 'Invalid JSON', details: e.message });
            }
      });

      request.on('error', (err) => {
          if (errorOccurred) return;
          errorOccurred = true;
          console.error('[MasterRequest] Stream error in jsonStream:', err.message);
          func({ error: err.message });
      });

      request.on('aborted', () => {
          if (errorOccurred) return;
          errorOccurred = true;
          console.warn('[MasterRequest] Request aborted in jsonStream');
          func({ error: 'Request aborted' });
      });

  }

  textStream(request, func){
      const decoder = new StringDecoder('utf-8');
      let buffer = '';
      let receivedBytes = 0;
      const maxBytes = this.options.maxTextSize || 1 * 1024 * 1024; // 1MB limit
      let errorOccurred = false;

      request.on('data', (chunk) => {
          if (errorOccurred) return;

          receivedBytes += chunk.length;

          // Prevent memory overload (DoS protection)
          if (receivedBytes > maxBytes) {
              errorOccurred = true;
              request.destroy();
              console.error(`Text payload too large: ${receivedBytes} bytes (max: ${maxBytes})`);
              func({ error: 'Text payload too large', maxSize: maxBytes });
              return;
          }

          buffer += decoder.write(chunk);
      });

      request.on('end', () => {
          if (errorOccurred) return;
          buffer += decoder.end();
          func(buffer);
      });

      request.on('error', (err) => {
          if (errorOccurred) return;
          errorOccurred = true;
          console.error('[MasterRequest] Stream error in textStream:', err.message);
          func({ error: err.message });
      });

      request.on('aborted', () => {
          if (errorOccurred) return;
          errorOccurred = true;
          console.warn('[MasterRequest] Request aborted in textStream');
          func({ error: 'Request aborted' });
      });

  }

  // have a clear all object that you can run that will delete all rununing objects
    clear(code, end){
        this.parsedURL = {}; 
        this._master.action.close(this.response, code, contentTypeManager.parse(this.request), end);
    }
}

module.exports = { MasterRequest };