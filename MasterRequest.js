
// version 0.0.2

const url = require('url');
const StringDecoder = require('string_decoder').StringDecoder;
const qs = require('qs');
const formidable = require('formidable');
const contentTypeManager = require("content-type");
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const { logger } = require('./error/MasterErrorLogger');

// Content Type Constants
const CONTENT_TYPES = {
    FORM_URLENCODED: 'application/x-www-form-urlencoded',
    MULTIPART_FORM: 'multipart/form-data',
    JSON: 'application/json',
    HTML: 'text/html',
    PLAIN: 'text/plain'
};

// Size Limit Constants (DoS Protection)
const SIZE_LIMITS = {
    MAX_FILES: 10,
    MAX_FILE_SIZE: 50 * 1024 * 1024,        // 50MB per file
    MAX_TOTAL_FILE_SIZE: 100 * 1024 * 1024, // 100MB total
    MAX_FIELDS: 1000,
    MAX_FIELDS_SIZE: 20 * 1024 * 1024,      // 20MB for all fields
    MAX_BODY_SIZE: 10 * 1024 * 1024,        // 10MB default
    MAX_JSON_SIZE: 1 * 1024 * 1024,         // 1MB for JSON
    MAX_TEXT_SIZE: 1 * 1024 * 1024          // 1MB for text
};

/**
 * MasterRequest - Request parsing and stream handling
 *
 * Handles all incoming request parsing including:
 * - URL-encoded form data
 * - Multipart form data (file uploads)
 * - JSON payloads
 * - Plain text/HTML
 * - Raw body preservation for webhook signature verification
 *
 * Includes DoS protection via configurable size limits
 *
 * @class MasterRequest
 */
class MasterRequest{
   parsedURL = {};
    request = {};
    response = {};
    __requestId = null;

    // Lazy-load master to avoid circular dependency (Google-style lazy initialization)
    get _master() {
        if (!this.__masterCache) {
            this.__masterCache = require('./MasterControl');
        }
        return this.__masterCache;
    }

   /**
    * Initialize request handler with configuration options
    *
    * @param {Object} options - Configuration options
    * @param {boolean} [options.disableFormidableMultipartFormData=false] - Disable multipart parsing
    * @param {Object} [options.formidable] - Formidable configuration
    * @param {number} [options.formidable.maxFiles=10] - Maximum number of files
    * @param {number} [options.formidable.maxFileSize=50MB] - Maximum file size in bytes
    * @param {number} [options.formidable.maxTotalFileSize=100MB] - Maximum total upload size
    * @param {number} [options.formidable.maxFields=1000] - Maximum number of form fields
    * @param {number} [options.formidable.maxFieldsSize=20MB] - Maximum size for all fields
    * @param {number} [options.maxBodySize=10MB] - Maximum URL-encoded body size
    * @param {number} [options.maxJsonSize=1MB] - Maximum JSON payload size
    * @param {number} [options.maxTextSize=1MB] - Maximum text payload size
    * @returns {void}
    * @example
    * masterRequest.init({
    *   formidable: { maxFileSize: 10 * 1024 * 1024 },
    *   maxJsonSize: 2 * 1024 * 1024
    * });
    */
   init(options){
     // Input validation
     if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options))) {
         throw new TypeError('init() options must be an object');
     }

     if(options){
        this.options = {};
        this.options.disableFormidableMultipartFormData = options.disableFormidableMultipartFormData === null? false : options.disableFormidableMultipartFormData;

        // CRITICAL FIX: Add file upload limits to prevent DoS attacks
        // Default formidable configuration with security limits
        this.options.formidable = {
            maxFiles: SIZE_LIMITS.MAX_FILES,
            maxFileSize: SIZE_LIMITS.MAX_FILE_SIZE,
            maxTotalFileSize: SIZE_LIMITS.MAX_TOTAL_FILE_SIZE,
            maxFields: SIZE_LIMITS.MAX_FIELDS,
            maxFieldsSize: SIZE_LIMITS.MAX_FIELDS_SIZE,
            allowEmptyFiles: false,
            minFileSize: 1,
            ...(options.formidable || {})
        };

        // Body size limits (DoS protection)
        this.options.maxBodySize = options.maxBodySize || SIZE_LIMITS.MAX_BODY_SIZE;
        this.options.maxJsonSize = options.maxJsonSize || SIZE_LIMITS.MAX_JSON_SIZE;
        this.options.maxTextSize = options.maxTextSize || SIZE_LIMITS.MAX_TEXT_SIZE;
     }
   }

   /**
    * Parse incoming request and extract parameters
    *
    * Supports both old pattern (request object) and new pattern (context object)
    * for backward compatibility. Automatically detects content-type and routes to
    * appropriate parser.
    *
    * Supported content types:
    * - application/x-www-form-urlencoded
    * - multipart/form-data (file uploads)
    * - application/json
    * - text/html
    * - text/plain
    *
    * @param {Object|Request} requestOrContext - Request or context object
    * @param {Object} requestOrContext.request - HTTP request (new pattern)
    * @param {string} requestOrContext.requrl - Pre-parsed URL (optional)
    * @param {Response} res - HTTP response object
    * @returns {Promise<Object>} Parsed request data
    * @returns {Object} parsedURL.query - Query string parameters
    * @returns {Object} parsedURL.formData - Parsed body data
    * @returns {Object} parsedURL.formData.fields - Form fields (multipart)
    * @returns {Object} parsedURL.formData.files - Uploaded files (multipart)
    * @returns {string} parsedURL.formData._rawBody - Raw body string (for webhook verification)
    * @throws {Error} If upload size exceeds limits
    * @throws {Error} If file upload fails
    * @throws {Error} If content type parsing fails
    * @example
    * const parsedData = await masterRequest.getRequestParam(req, res);
    * console.log(parsedData.query.id);
    * console.log(parsedData.formData.fields.username);
    */
   getRequestParam(requestOrContext, res){
    // Input validation
    if (!requestOrContext || typeof requestOrContext !== 'object') {
        return Promise.reject(new TypeError('getRequestParam() requires a request or context object'));
    }

    if (!res || typeof res !== 'object' || typeof res.writeHead !== 'function') {
        return Promise.reject(new TypeError('getRequestParam() requires a valid response object'));
    }

    const $that = this;
    $that.response = res;

    // Return Promise with proper error handling
    return new Promise(function (resolve, reject) {
        try {
            // BACKWARD COMPATIBILITY: Support both old and new patterns
            // New pattern (v1.3.x pipeline): Pass context with requrl property
            // Old pattern (pre-v1.3.x): Pass request with requrl property
            const request = requestOrContext.request || requestOrContext;

            // SECURITY: Validate headers before processing
            const securityCheck = $that._validateSecurityHeaders(request);
            if (!securityCheck.valid) {
                logger.warn({
                    code: 'MC_REQ_SECURITY_VALIDATION_FAILED',
                    message: 'Request failed security validation',
                    requestId: $that.getRequestId(),
                    reason: securityCheck.reason
                });
                reject(new Error(securityCheck.reason));
                return;
            }
            let requrl = requestOrContext.requrl || request.requrl;

            // Fallback: If requrl not set, parse from request.url
            if (!requrl) {
                requrl = url.parse(request.url, true);
            }

            const querydata = url.parse(requrl, true);
            $that.parsedURL.query = querydata.query;
            $that.form = new formidable.IncomingForm($that.options.formidable);
            if(request.headers['content-type'] || request.headers['transfer-encoding'] ){
                    var contentType = contentTypeManager.parse(request);
                    switch(contentType.type){
                        case CONTENT_TYPES.FORM_URLENCODED:
                            $that.urlEncodeStream(request, function(data){
                                $that.parsedURL.formData = data;
                                resolve($that.parsedURL);
                            });                      
                        break 
                        case CONTENT_TYPES.MULTIPART_FORM:
                            // Offer operturnity to add options. find a way to add dependecy injection. to request
                            if(!$that.options.disableFormidableMultipartFormData){

                                $that.parsedURL.formData = {
                                    files : {},
                                    fields : {}
                                };

                                // Track uploaded files for cleanup on error
                                const uploadedFiles = [];
                                let uploadAborted = false;
                                let totalUploadedSize = 0; // CRITICAL: Track total upload size

                                $that.form.on('field', function(field, value) {
                                    $that.parsedURL.formData.fields[field] = value;
                                });

                                $that.form.on('fileBegin', function(formname, file) {
                                    // Track file for potential cleanup
                                    uploadedFiles.push(file);
                                });

                                $that.form.on('file', function(field, file) {
                                    file.extension = file.name === undefined ? path.extname(file.originalFilename) : path.extname(file.name);

                                    // CRITICAL: Track total uploaded size across all files
                                    totalUploadedSize += file.size || 0;

                                    // CRITICAL: Enforce maxTotalFileSize limit
                                    const maxTotalSize = $that.options.formidable.maxTotalFileSize || 100 * 1024 * 1024;
                                    if (totalUploadedSize > maxTotalSize) {
                                        uploadAborted = true;
                                        logger.error({
                                            code: 'MC_REQ_UPLOAD_SIZE_EXCEEDED',
                                            message: 'Total upload size exceeds limit',
                                            requestId: $that.getRequestId(),
                                            totalSize: totalUploadedSize,
                                            maxSize: maxTotalSize
                                        });

                                        // Cleanup all uploaded files (async)
                                        Promise.all(
                                            uploadedFiles
                                                .filter(f => f.filepath)
                                                .map(f => $that.deleteFileBuffer(f.filepath))
                                        ).catch(() => {
                                            // Cleanup errors already logged by deleteFileBuffer
                                        });

                                        reject(new Error(`Total upload size exceeds limit (${maxTotalSize} bytes)`));
                                        return;
                                    }

                                    if(Array.isArray($that.parsedURL.formData.files[field])){
                                        $that.parsedURL.formData.files[field].push(file);
                                    }
                                    else{
                                        $that.parsedURL.formData.files[field] = [];
                                        $that.parsedURL.formData.files[field].push(file);
                                    }

                                    // CRITICAL: Log file upload for security audit trail
                                    logger.info({
                                        code: 'MC_REQ_FILE_UPLOADED',
                                        message: 'File uploaded',
                                        requestId: $that.getRequestId(),
                                        filename: file.originalFilename || file.name,
                                        size: file.size
                                    });
                                });

                                $that.form.on('error', function(err) {
                                    // CRITICAL: Handle upload errors
                                    uploadAborted = true;
                                    logger.error({
                                        code: 'MC_REQ_UPLOAD_ERROR',
                                        message: 'File upload error',
                                        requestId: $that.getRequestId(),
                                        error: err.message
                                    });

                                    // Cleanup temporary files (async)
                                    Promise.all(
                                        uploadedFiles
                                            .filter(file => file.filepath)
                                            .map(file => $that.deleteFileBuffer(file.filepath))
                                    ).catch(() => {
                                        // Cleanup errors already logged by deleteFileBuffer
                                    });

                                    reject(new Error(`File upload failed: ${err.message}`));
                                });

                                $that.form.on('aborted', function() {
                                    // CRITICAL: Handle client abort (connection closed)
                                    uploadAborted = true;
                                    logger.warn({
                                        code: 'MC_REQ_UPLOAD_ABORTED',
                                        message: 'File upload aborted by client',
                                        requestId: $that.getRequestId()
                                    });

                                    // Cleanup temporary files (async)
                                    Promise.all(
                                        uploadedFiles
                                            .filter(file => file.filepath)
                                            .map(file => $that.deleteFileBuffer(file.filepath))
                                    ).catch(() => {
                                        // Cleanup errors already logged by deleteFileBuffer
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
                                logger.debug({
                                    code: 'MC_REQ_MULTIPART_SKIPPED',
                                    message: 'Multipart form-data parsing disabled',
                                    requestId: $that.getRequestId()
                                });
                            }
                        break
                        case CONTENT_TYPES.JSON:
                            $that.jsonStream(request, function(data){
                                $that.parsedURL.formData = data;
                                resolve($that.parsedURL);
                            });  

                        break
                        case CONTENT_TYPES.HTML: 
                            $that.textStream(request, function(data){
                                $that.parsedURL.formData = {};
                                $that.parsedURL.formData.textField = data;
                                resolve($that.parsedURL);
                            });  

                        break
                        case CONTENT_TYPES.PLAIN: 
                        $that.fetchData(request, function(data){
                            $that.parsedURL.formData = data;
                            resolve($that.parsedURL);

                        });

                        break
                        default:
                            var errorMessage = `Cannot parse - We currently support text/plain, text/html, application/json, multipart/form-data, and application/x-www-form-urlencoded - your sending us = ${contentType.type}`;
                            resolve(errorMessage);
                            logger.warn({
                                code: 'MC_REQ_UNSUPPORTED_CONTENT_TYPE',
                                message: 'Unsupported content type',
                                requestId: $that.getRequestId(),
                                contentType: contentType.type
                            });
                      }

                }
                else{
                    resolve($that.parsedURL);
                }
        } catch (error) {
            // Catch any synchronous errors in Promise executor
            logger.error({
                code: 'MC_REQ_PARSE_ERROR',
                message: 'Failed to parse request',
                requestId: $that.getRequestId(),
                error: error.message,
                stack: error.stack
            });
            reject(new Error(`Request parsing failed: ${error.message}`));
        }
    }).catch((error) => {
        // Catch any unhandled promise rejections
        logger.error({
            code: 'MC_REQ_UNHANDLED_REJECTION',
            message: 'Unhandled promise rejection in getRequestParam',
            requestId: this.getRequestId(),
            error: error.message,
            stack: error.stack
        });
        // Re-throw to propagate to caller
        throw error;
    });
  };

  /**
   * Validate security-related headers and request properties
   *
   * Checks for common security issues:
   * - Content-Length bomb attacks
   * - Suspicious content-type values
   * - Oversized headers
   *
   * @private
   * @param {Request} request - HTTP request object
   * @returns {Object} Validation result
   * @returns {boolean} result.valid - Whether request passes validation
   * @returns {string} result.reason - Reason for validation failure
   */
  _validateSecurityHeaders(request) {
      // Check content-length header
      const contentLength = parseInt(request.headers['content-length'], 10);
      if (!isNaN(contentLength) && contentLength > 200 * 1024 * 1024) { // 200MB hard limit
          return {
              valid: false,
              reason: 'Content-Length exceeds maximum allowed size (200MB)'
          };
      }

      // Check for suspiciously long header values (potential header injection)
      for (const [key, value] of Object.entries(request.headers)) {
          if (typeof value === 'string' && value.length > 8192) { // 8KB per header
              return {
                  valid: false,
                  reason: `Header ${key} exceeds maximum length`
              };
          }
      }

      // Check for null bytes in headers (potential injection)
      for (const [key, value] of Object.entries(request.headers)) {
          if (typeof value === 'string' && value.includes('\0')) {
              return {
                  valid: false,
                  reason: `Header ${key} contains null bytes`
              };
          }
      }

      return { valid: true };
  }

  /**
   * Get or generate request ID for tracing
   *
   * Checks for x-request-id header first, then generates a unique ID.
   * Used for correlating logs and tracking requests through the system.
   *
   * @returns {string} Unique request identifier
   * @example
   * const reqId = this.getRequestId();
   * logger.info({ requestId: reqId, message: 'Processing request' });
   */
  getRequestId() {
      if (!this.__requestId) {
          // Check for existing request ID header
          const headerReqId = this.request?.headers?.['x-request-id'];
          if (headerReqId) {
              this.__requestId = headerReqId;
          } else {
              // Generate new request ID: req_timestamp_random
              this.__requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          }
      }
      return this.__requestId;
  }

  /**
   * Handle stream errors with structured logging
   *
   * Centralized error handler for all stream parsing methods. Logs error
   * and calls callback with error object.
   *
   * @private
   * @param {string} code - Error code for logging
   * @param {string} message - Human-readable error message
   * @param {Function} callback - Callback function to invoke with error
   * @param {Object} details - Additional error details
   * @returns {void}
   */
  _handleStreamError(code, message, callback, details = {}) {
      logger.error({
          code,
          message,
          requestId: this.getRequestId(),
          ...details
      });

      callback({
          error: message,
          ...details
      });
  }

  /**
   * Parse text/plain request body with DoS protection
   *
   * Implements size limits and stream error handling. Destroys request
   * stream if payload exceeds maxBytes limit.
   *
   * @private
   * @param {Request} request - HTTP request stream
   * @param {Function} func - Callback function (data) => void
   * @param {string|Object} func.data - Parsed text or error object
   * @param {string} func.data.error - Error message if failed
   * @param {number} func.data.maxSize - Maximum allowed size if exceeded
   * @returns {void}
   * @example
   * this.fetchData(req, (data) => {
   *   if (data.error) {
   *     console.error('Parse failed:', data.error);
   *   } else {
   *     console.log('Text:', data);
   *   }
   * });
   */
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
              request.destroy();
              this._handleStreamError(
                  'MC_REQ_TEXT_PAYLOAD_TOO_LARGE',
                  'Payload too large',
                  func,
                  { receivedBytes, maxBytes, maxSize: maxBytes }
              );
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
                this._handleStreamError(
                    'MC_REQ_TEXT_PROCESSING_ERROR',
                    'Error processing text/plain',
                    func,
                    { error: err.message }
                );
              }

        });

        request.on('error', (err) => {
            if (errorOccurred) return;
            errorOccurred = true;
            this._handleStreamError(
                'MC_REQ_STREAM_ERROR',
                'Stream error in fetchData',
                func,
                { error: err.message }
            );
        });

        request.on('aborted', () => {
            if (errorOccurred) return;
            errorOccurred = true;
            logger.warn({
                code: 'MC_REQ_ABORTED',
                message: 'Request aborted in fetchData',
                requestId: this.getRequestId()
            });
            func({ error: 'Request aborted' });
        });

    } catch (error) {
      this._handleStreamError(
          'MC_REQ_FETCH_FAILED',
          'Failed to fetch data',
          func,
          { error: error.message }
      );
    }
  }

  /**
   * Delete temporary file buffer (async operation)
   *
   * Used to cleanup uploaded files after processing or on error.
   * Logs success/failure via structured logger. Uses fs.promises for
   * proper error propagation.
   *
   * @param {string} filePath - Absolute path to temporary file
   * @returns {Promise<void>}
   * @throws {Error} If file deletion fails (error is logged but not thrown)
   * @example
   * await this.deleteFileBuffer('/tmp/upload-12345.tmp');
   * // Or with error handling:
   * try {
   *   await this.deleteFileBuffer(filePath);
   * } catch (err) {
   *   console.error('Cleanup failed:', err);
   * }
   */
  async deleteFileBuffer(filePath){
    // Input validation
    if (!filePath || typeof filePath !== 'string') {
        logger.error({
            code: 'MC_REQ_INVALID_FILE_PATH',
            message: 'deleteFileBuffer() requires a valid file path string',
            requestId: this.getRequestId(),
            filePath
        });
        return;
    }

    try {
        await fsPromises.unlink(filePath);
        logger.debug({
            code: 'MC_REQ_FILE_DELETED',
            message: 'Temporary file deleted',
            requestId: this.getRequestId(),
            filePath
        });
    } catch (err) {
        logger.error({
            code: 'MC_REQ_FILE_DELETE_FAILED',
            message: 'Failed to delete temporary file',
            requestId: this.getRequestId(),
            filePath,
            error: err.message
        });
        // Don't throw - cleanup failures shouldn't break the request
    }
}

  /**
   * Parse application/x-www-form-urlencoded request body
   *
   * Uses StringDecoder for proper UTF-8 handling. Includes DoS protection
   * via configurable size limits. Preserves raw body string for webhook
   * signature verification (accessible via data._rawBody).
   *
   * @private
   * @param {Request} request - HTTP request stream
   * @param {Function} func - Callback function (data) => void
   * @param {Object} func.data - Parsed form data object or error object
   * @param {string} func.data._rawBody - Original raw body string
   * @param {string} func.data.error - Error message if failed
   * @param {number} func.data.maxSize - Maximum allowed size if exceeded
   * @returns {void}
   * @example
   * this.urlEncodeStream(req, (data) => {
   *   console.log(data.username, data.password);
   *   // Verify webhook signature using data._rawBody
   * });
   */
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
              this._handleStreamError(
                  'MC_REQ_FORM_DATA_TOO_LARGE',
                  'Payload too large',
                  func,
                  { receivedBytes, maxBytes, maxSize: maxBytes }
              );
              return;
          }

          buffer += decoder.write(chunk);
      });

      request.on('end', () => {
          if (errorOccurred) return;

          buffer += decoder.end();
          const buff = qs.parse(buffer);
          // Preserve raw body for signature verification
          buff._rawBody = buffer;
          func(buff);
      });

      request.on('error', (err) => {
          if (errorOccurred) return;
          errorOccurred = true;
          this._handleStreamError(
              'MC_REQ_STREAM_ERROR',
              'Stream error in urlEncodeStream',
              func,
              { error: err.message }
          );
      });

      request.on('aborted', () => {
          if (errorOccurred) return;
          errorOccurred = true;
          logger.warn({
              code: 'MC_REQ_ABORTED',
              message: 'Request aborted in urlEncodeStream',
              requestId: this.getRequestId()
          });
          func({ error: 'Request aborted' });
      });

  }

  /**
   * Parse application/json request body
   *
   * Includes DoS protection via size limits. Handles empty bodies gracefully.
   * Preserves raw body string for webhook signature verification (required
   * by Stripe, GitHub, Shopify, etc. for HMAC validation).
   *
   * SECURITY: Does NOT fallback to qs.parse to prevent prototype pollution.
   *
   * @private
   * @param {Request} request - HTTP request stream
   * @param {Function} func - Callback function (data) => void
   * @param {Object} func.data - Parsed JSON object or error object
   * @param {string} func.data._rawBody - Original raw body string
   * @param {string} func.data.error - Error message if failed
   * @param {string} func.data.details - Error details if JSON parsing failed
   * @param {number} func.data.maxSize - Maximum allowed size if exceeded
   * @returns {void}
   * @example
   * this.jsonStream(req, (data) => {
   *   if (data.error) {
   *     res.statusCode = 400;
   *     res.end(JSON.stringify({ error: data.details }));
   *   } else {
   *     console.log('Received:', data);
   *     // Verify signature: hmac(data._rawBody, secret)
   *   }
   * });
   */
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
              this._handleStreamError(
                  'MC_REQ_JSON_PAYLOAD_TOO_LARGE',
                  'JSON payload too large',
                  func,
                  { receivedBytes, maxBytes, maxSize: maxBytes }
              );
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
                const buff = JSON.parse(buffer);
                // IMPORTANT: Preserve raw body for webhook signature verification
                // Many webhook providers (Stripe, GitHub, Shopify, etc.) require the
                // exact raw body string to verify HMAC signatures
                buff._rawBody = buffer;
                func(buff);
            } catch (e) {
                // Security: Don't fallback to qs.parse to avoid prototype pollution
                this._handleStreamError(
                    'MC_REQ_INVALID_JSON',
                    'Invalid JSON',
                    func,
                    { details: e.message, error: e.message }
                );
            }
      });

      request.on('error', (err) => {
          if (errorOccurred) return;
          errorOccurred = true;
          this._handleStreamError(
              'MC_REQ_STREAM_ERROR',
              'Stream error in jsonStream',
              func,
              { error: err.message }
          );
      });

      request.on('aborted', () => {
          if (errorOccurred) return;
          errorOccurred = true;
          logger.warn({
              code: 'MC_REQ_ABORTED',
              message: 'Request aborted in jsonStream',
              requestId: this.getRequestId()
          });
          func({ error: 'Request aborted' });
      });

  }

  /**
   * Parse text/html request body
   *
   * Uses StringDecoder for proper UTF-8 handling. Includes DoS protection
   * via configurable size limits. Returns raw string (no parsing).
   *
   * @private
   * @param {Request} request - HTTP request stream
   * @param {Function} func - Callback function (data) => void
   * @param {string|Object} func.data - Raw text string or error object
   * @param {string} func.data.error - Error message if failed
   * @param {number} func.data.maxSize - Maximum allowed size if exceeded
   * @returns {void}
   * @example
   * this.textStream(req, (html) => {
   *   if (html.error) {
   *     res.statusCode = 413;
   *     res.end('Payload too large');
   *   } else {
   *     console.log('HTML:', html);
   *   }
   * });
   */
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
              this._handleStreamError(
                  'MC_REQ_TEXT_PAYLOAD_TOO_LARGE',
                  'Text payload too large',
                  func,
                  { receivedBytes, maxBytes, maxSize: maxBytes }
              );
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
          this._handleStreamError(
              'MC_REQ_STREAM_ERROR',
              'Stream error in textStream',
              func,
              { error: err.message }
          );
      });

      request.on('aborted', () => {
          if (errorOccurred) return;
          errorOccurred = true;
          logger.warn({
              code: 'MC_REQ_ABORTED',
              message: 'Request aborted in textStream',
              requestId: this.getRequestId()
          });
          func({ error: 'Request aborted' });
      });

  }

  /**
   * Clear parsed request data and close response
   *
   * Resets parsedURL object and delegates to MasterAction.close() to send
   * final response with appropriate content-type and status code.
   *
   * @param {number} code - HTTP status code
   * @param {string} end - Response body content
   * @returns {void}
   * @example
   * this.clear(200, 'OK');
   * this.clear(404, JSON.stringify({ error: 'Not Found' }));
   */
    clear(code, end){
        // Input validation
        if (typeof code !== 'number' || code < 100 || code > 599) {
            throw new TypeError('clear() code must be a valid HTTP status code (100-599)');
        }

        if (end === undefined || end === null) {
            throw new TypeError('clear() end parameter is required');
        }

        this.parsedURL = {};
        this._master.action.close(this.response, code, contentTypeManager.parse(this.request), end);
    }
}

module.exports = { MasterRequest };