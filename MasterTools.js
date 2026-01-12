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

    /**
     * @deprecated This custom base64 implementation ONLY works for TEXT strings, NOT binary files.
     * For binary files (images, PDFs, videos), use Node.js Buffer API or the new file conversion methods below.
     * This method will be removed in v2.0.
     *
     * @example
     * // ❌ WRONG - Corrupts binary files
     * const base64 = tools.base64().encode(binaryData);
     *
     * // ✅ CORRECT - Use Node.js Buffer
     * const base64 = Buffer.from(binaryData).toString('base64');
     *
     * // ✅ CORRECT - Use new helper methods
     * const base64 = tools.fileToBase64('/path/to/file.jpg');
     */
    base64(){
        console.warn('[DEPRECATED] MasterTools.base64() only works for TEXT strings, not binary files. Use Buffer.toString("base64") or tools.fileToBase64() instead. This method will be removed in v2.0.');

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

    // ============================================================================
    // FILE CONVERSION UTILITIES (Production-Grade)
    // ============================================================================

    /**
     * Convert file to base64 string (binary-safe)
     *
     * @param {String|Object} filePathOrFile - File path or formidable file object
     * @param {Object} options - Conversion options
     * @param {Number} options.maxSize - Maximum file size in bytes (default: 10MB)
     * @param {Boolean} options.includeDataURI - Include data URI prefix (default: false)
     * @returns {String} Base64 encoded string
     *
     * @example
     * // Convert uploaded file to base64
     * const file = obj.params.formData.files.image[0];
     * const base64 = master.tools.fileToBase64(file);
     *
     * @example
     * // Convert file by path with data URI
     * const base64 = master.tools.fileToBase64('/path/to/image.jpg', {
     *     includeDataURI: true,
     *     maxSize: 5 * 1024 * 1024  // 5MB limit
     * });
     * // Returns: "data:image/jpeg;base64,/9j/4AAQSkZJRg..."
     */
    fileToBase64(filePathOrFile, options = {}) {
        const fs = require('fs');
        const path = require('path');

        // Extract file path from formidable file object or use as-is
        const filepath = typeof filePathOrFile === 'object' && filePathOrFile.filepath
            ? filePathOrFile.filepath
            : filePathOrFile;

        // Validate file path
        if (!filepath || typeof filepath !== 'string') {
            throw new Error('Invalid file path provided');
        }

        if (!fs.existsSync(filepath)) {
            throw new Error(`File not found: ${filepath}`);
        }

        // Get file stats
        const stats = fs.statSync(filepath);

        // Check file size
        const maxSize = options.maxSize || 10 * 1024 * 1024; // 10MB default
        if (stats.size > maxSize) {
            throw new Error(`File size (${stats.size} bytes) exceeds maximum (${maxSize} bytes). Use streaming for large files.`);
        }

        // Security: Check if it's actually a file
        if (!stats.isFile()) {
            throw new Error('Path is not a file');
        }

        try {
            // Read file as binary buffer
            const buffer = fs.readFileSync(filepath);

            // Convert to base64
            const base64 = buffer.toString('base64');

            // Include data URI if requested
            if (options.includeDataURI) {
                const mimetype = filePathOrFile.mimetype || this._getMimeTypeFromPath(filepath);
                return `data:${mimetype};base64,${base64}`;
            }

            return base64;
        } catch (error) {
            throw new Error(`Failed to convert file to base64: ${error.message}`);
        }
    }

    /**
     * Convert base64 string to file (binary-safe)
     *
     * @param {String} base64String - Base64 encoded string (with or without data URI)
     * @param {String} outputPath - Output file path
     * @param {Object} options - Conversion options
     * @param {Boolean} options.overwrite - Overwrite existing file (default: false)
     * @returns {Object} File information {path, size, mimetype}
     *
     * @example
     * const fileInfo = master.tools.base64ToFile(
     *     'data:image/jpeg;base64,/9j/4AAQSkZJRg...',
     *     '/path/to/output.jpg',
     *     { overwrite: true }
     * );
     * console.log(fileInfo);
     * // { path: '/path/to/output.jpg', size: 51234, mimetype: 'image/jpeg' }
     */
    base64ToFile(base64String, outputPath, options = {}) {
        const fs = require('fs');
        const path = require('path');

        // Validate inputs
        if (!base64String || typeof base64String !== 'string') {
            throw new Error('Invalid base64 string provided');
        }

        if (!outputPath || typeof outputPath !== 'string') {
            throw new Error('Invalid output path provided');
        }

        // Check if file exists
        if (fs.existsSync(outputPath) && !options.overwrite) {
            throw new Error(`File already exists: ${outputPath}. Set overwrite: true to replace.`);
        }

        // Extract mimetype and base64 data from data URI if present
        let mimetype = null;
        let base64Data = base64String;

        const dataURIMatch = base64String.match(/^data:([^;]+);base64,(.+)$/);
        if (dataURIMatch) {
            mimetype = dataURIMatch[1];
            base64Data = dataURIMatch[2];
        }

        // Validate base64 format
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64Data)) {
            throw new Error('Invalid base64 string format');
        }

        try {
            // Convert base64 to buffer
            const buffer = Buffer.from(base64Data, 'base64');

            // Ensure output directory exists
            const dir = path.dirname(outputPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // Write buffer to file
            fs.writeFileSync(outputPath, buffer);

            // Get file stats
            const stats = fs.statSync(outputPath);

            return {
                path: outputPath,
                size: stats.size,
                mimetype: mimetype || this._getMimeTypeFromPath(outputPath)
            };
        } catch (error) {
            throw new Error(`Failed to convert base64 to file: ${error.message}`);
        }
    }

    /**
     * Convert file to Node.js Buffer (binary-safe)
     *
     * @param {String|Object} filePathOrFile - File path or formidable file object
     * @param {Object} options - Conversion options
     * @param {Number} options.maxSize - Maximum file size in bytes (default: 10MB)
     * @returns {Buffer} Node.js Buffer containing file data
     *
     * @example
     * const file = obj.params.formData.files.document[0];
     * const buffer = master.tools.fileToBuffer(file);
     * console.log(buffer.length);  // File size in bytes
     */
    fileToBuffer(filePathOrFile, options = {}) {
        const fs = require('fs');

        const filepath = typeof filePathOrFile === 'object' && filePathOrFile.filepath
            ? filePathOrFile.filepath
            : filePathOrFile;

        if (!filepath || typeof filepath !== 'string') {
            throw new Error('Invalid file path provided');
        }

        if (!fs.existsSync(filepath)) {
            throw new Error(`File not found: ${filepath}`);
        }

        const stats = fs.statSync(filepath);
        const maxSize = options.maxSize || 10 * 1024 * 1024; // 10MB default

        if (stats.size > maxSize) {
            throw new Error(`File size (${stats.size} bytes) exceeds maximum (${maxSize} bytes)`);
        }

        if (!stats.isFile()) {
            throw new Error('Path is not a file');
        }

        try {
            return fs.readFileSync(filepath);
        } catch (error) {
            throw new Error(`Failed to read file to buffer: ${error.message}`);
        }
    }

    /**
     * Convert file to Uint8Array byte array (binary-safe)
     *
     * @param {String|Object} filePathOrFile - File path or formidable file object
     * @param {Object} options - Conversion options
     * @param {Number} options.maxSize - Maximum file size in bytes (default: 10MB)
     * @returns {Uint8Array} Byte array
     *
     * @example
     * const file = obj.params.formData.files.data[0];
     * const bytes = master.tools.fileToBytes(file);
     * console.log(bytes[0]);       // First byte
     * console.log(bytes.length);   // Total bytes
     */
    fileToBytes(filePathOrFile, options = {}) {
        const buffer = this.fileToBuffer(filePathOrFile, options);
        return new Uint8Array(buffer);
    }

    /**
     * Convert Buffer or Uint8Array to base64 string
     *
     * @param {Buffer|Uint8Array} bytes - Binary data
     * @returns {String} Base64 encoded string
     *
     * @example
     * const buffer = fs.readFileSync('/path/to/file.pdf');
     * const base64 = master.tools.bytesToBase64(buffer);
     */
    bytesToBase64(bytes) {
        if (!bytes) {
            throw new Error('Invalid bytes provided');
        }

        try {
            // Convert Uint8Array to Buffer if needed
            const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
            return buffer.toString('base64');
        } catch (error) {
            throw new Error(`Failed to convert bytes to base64: ${error.message}`);
        }
    }

    /**
     * Convert base64 string to Buffer
     *
     * @param {String} base64String - Base64 encoded string (with or without data URI)
     * @returns {Buffer} Node.js Buffer
     *
     * @example
     * const base64 = 'SGVsbG8gV29ybGQ=';
     * const buffer = master.tools.base64ToBytes(base64);
     * console.log(buffer.toString('utf8'));  // "Hello World"
     */
    base64ToBytes(base64String) {
        if (!base64String || typeof base64String !== 'string') {
            throw new Error('Invalid base64 string provided');
        }

        // Strip data URI prefix if present
        let base64Data = base64String;
        const dataURIMatch = base64String.match(/^data:[^;]+;base64,(.+)$/);
        if (dataURIMatch) {
            base64Data = dataURIMatch[1];
        }

        // Validate base64 format
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64Data)) {
            throw new Error('Invalid base64 string format');
        }

        try {
            return Buffer.from(base64Data, 'base64');
        } catch (error) {
            throw new Error(`Failed to convert base64 to bytes: ${error.message}`);
        }
    }

    /**
     * Stream large file to base64 (for files > 10MB)
     * Returns a Promise that resolves with base64 string
     *
     * @param {String|Object} filePathOrFile - File path or formidable file object
     * @param {Object} options - Streaming options
     * @param {Function} options.onProgress - Progress callback (percent: number) => void
     * @returns {Promise<String>} Base64 encoded string
     *
     * @example
     * // Stream 500MB video file
     * const base64 = await master.tools.streamFileToBase64('/path/to/video.mp4', {
     *     onProgress: (percent) => console.log(`${percent}% complete`)
     * });
     */
    async streamFileToBase64(filePathOrFile, options = {}) {
        const fs = require('fs');
        const { Transform } = require('stream');

        const filepath = typeof filePathOrFile === 'object' && filePathOrFile.filepath
            ? filePathOrFile.filepath
            : filePathOrFile;

        if (!filepath || !fs.existsSync(filepath)) {
            throw new Error(`File not found: ${filepath}`);
        }

        const stats = fs.statSync(filepath);
        if (!stats.isFile()) {
            throw new Error('Path is not a file');
        }

        return new Promise((resolve, reject) => {
            const chunks = [];
            let bytesRead = 0;

            const readStream = fs.createReadStream(filepath);

            readStream.on('data', (chunk) => {
                chunks.push(chunk);
                bytesRead += chunk.length;

                // Progress callback
                if (options.onProgress && typeof options.onProgress === 'function') {
                    const percent = Math.round((bytesRead / stats.size) * 100);
                    options.onProgress(percent);
                }
            });

            readStream.on('end', () => {
                try {
                    const buffer = Buffer.concat(chunks);
                    const base64 = buffer.toString('base64');
                    resolve(base64);
                } catch (error) {
                    reject(new Error(`Failed to convert stream to base64: ${error.message}`));
                }
            });

            readStream.on('error', (error) => {
                reject(new Error(`Stream error: ${error.message}`));
            });
        });
    }

    /**
     * Get MIME type from file path
     * @private
     */
    _getMimeTypeFromPath(filepath) {
        const path = require('path');
        const ext = path.extname(filepath).toLowerCase();

        const mimeTypes = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.svg': 'image/svg+xml',
            '.pdf': 'application/pdf',
            '.txt': 'text/plain',
            '.json': 'application/json',
            '.xml': 'application/xml',
            '.zip': 'application/zip',
            '.mp4': 'video/mp4',
            '.mp3': 'audio/mpeg',
            '.wav': 'audio/wav'
        };

        return mimeTypes[ext] || 'application/octet-stream';
    }

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