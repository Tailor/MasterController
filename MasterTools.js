/**
 * MasterTools - Utility toolkit for MasterController
 *
 * Provides essential utilities:
 * - String manipulation (case conversion, path parsing)
 * - Cryptography (AES-256 encryption, secure key generation)
 * - File conversion (base64, Buffer, streaming)
 * - Object utilities (merging, type checking)
 * - Random ID generation
 *
 * @version 1.0.0 - FAANG-level refactor with security hardening
 */

const crypto = require('crypto');
const { logger } = require('./error/MasterErrorLogger');

// Configuration Constants
const CRYPTO_CONFIG = {
    ALGORITHM: 'aes-256-cbc',
    IV_SIZE: 16,                    // 16 bytes for AES
    KEY_SIZE: 256,                  // 256-bit key
    HASH_ALGORITHM: 'sha256',
    VALID_HASH_ALGORITHMS: ['sha256', 'sha512', 'sha384', 'md5', 'sha1']
};

const FILE_CONFIG = {
    MAX_FILE_SIZE: 10 * 1024 * 1024,    // 10MB default
    STREAM_THRESHOLD: 10 * 1024 * 1024,  // Use streaming for files > 10MB
    MAX_PATH_LENGTH: 4096,               // Maximum file path length
    CHUNK_SIZE: 64 * 1024                // 64KB chunks for streaming
};

const STRING_CONFIG = {
    MAX_STRING_LENGTH: 1000000,      // 1MB string limit
    MAX_WORD_ID_LENGTH: 1000,        // Maximum word ID length
    BASE64_CHARSET: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='
};

class MasterTools{
    characters = STRING_CONFIG.BASE64_CHARSET;

    /**
     * Check if value is a plain object literal (not Array, Date, etc.)
     *
     * @param {*} _obj - Value to check
     * @returns {Boolean} True if plain object literal, false otherwise
     *
     * @example
     * isObjLiteral({})              // true
     * isObjLiteral({ a: 1 })        // true
     * isObjLiteral([])              // false
     * isObjLiteral(new Date())      // false
     * isObjLiteral(null)            // false
     */
    isObjLiteral(_obj) {
        let _test = _obj;
        return (typeof _obj !== 'object' || _obj === null ?
                    false :
                    (
                      (function () {
                        while (true) {
                          if (Object.getPrototypeOf(_test = Object.getPrototypeOf(_test)) === null) {
                            break;
                          }
                        }
                        return Object.getPrototypeOf(_obj) === _test;
                      })()
                    )
                );
    }

    /**
     * Remove sections from the end of a delimited string
     *
     * @param {String} string - Input string to process
     * @param {Number} amount - Number of sections to remove from end
     * @param {String} [type='\\'] - Delimiter character (default: backslash)
     * @returns {String} String with sections removed
     * @throws {TypeError} If string is not a string
     * @throws {Error} If amount is negative
     *
     * @example
     * removeBackwardSlashSection('a\\b\\c\\d', 2, '\\')  // 'a\\b'
     * removeBackwardSlashSection('a/b/c/d', 1, '/')      // 'a/b/c'
     */
    removeBackwardSlashSection(string, amount, type){
        // Input validation
        if (typeof string !== 'string') {
            throw new TypeError('Input must be a string');
        }

        if (typeof amount !== 'number' || amount < 0) {
            throw new Error('Amount must be a non-negative number');
        }

        type = type === undefined ? "\\" : type;
        const stringArray = string.split(type);
        for(let i = 0; i < amount; i++){
            stringArray.pop();
        }
        return stringArray.join(type);
    }

    /**
     * Extract sections from the end of a delimited string
     *
     * @param {String} string - Input string to process
     * @param {Number} amount - Number of sections to extract from end
     * @param {String} [type='\\'] - Delimiter character (default: backslash)
     * @returns {String} Extracted sections joined by delimiter
     * @throws {TypeError} If string is not a string
     * @throws {Error} If amount is negative
     *
     * @example
     * getBackSlashBySection('a\\b\\c\\d', 2, '\\')  // 'c\\d'
     * getBackSlashBySection('a/b/c/d', 1, '/')      // 'd'
     */
    getBackSlashBySection(string, amount, type){
        // Input validation
        if (typeof string !== 'string') {
            throw new TypeError('Input must be a string');
        }

        if (typeof amount !== 'number' || amount < 0) {
            throw new Error('Amount must be a non-negative number');
        }

        type = type === undefined ? "\\" : type;
        const stringArray = string.split(type);
        const newStringArray = [];
        for(let i = 0; i < amount; i++){
            newStringArray.unshift(stringArray.pop());
        }
        return newStringArray.join(type);
    }

    /**
     * Capitalize first letter of string
     *
     * @param {String} string - Input string
     * @returns {String} String with first letter capitalized
     * @throws {TypeError} If string is not a string
     * @throws {Error} If string is empty
     *
     * @example
     * firstLetterUppercase('hello')  // 'Hello'
     * firstLetterUppercase('world')  // 'World'
     */
    firstLetterUppercase(string){
        if (typeof string !== 'string') {
            throw new TypeError('Input must be a string');
        }

        if (string.length === 0) {
            throw new Error('String cannot be empty');
        }

        return string.charAt(0).toUpperCase() + string.slice(1);
    }

    /**
     * Lowercase first letter of string
     *
     * @param {String} string - Input string
     * @returns {String} String with first letter lowercased
     * @throws {TypeError} If string is not a string
     * @throws {Error} If string is empty
     *
     * @example
     * firstLetterlowercase('Hello')  // 'hello'
     * firstLetterlowercase('World')  // 'world'
     */
    firstLetterlowercase(string){
        if (typeof string !== 'string') {
            throw new TypeError('Input must be a string');
        }

        if (string.length === 0) {
            throw new Error('String cannot be empty');
        }

        return string.charAt(0).toLowerCase() + string.slice(1);
    }
   
    /**
     * Encrypt data using AES-256-CBC with random IV
     *
     * @param {*} payload - Data to encrypt (will be converted to string)
     * @param {String} secret - Encryption secret/password
     * @returns {String} Encrypted data with IV prepended (format: "iv:encryptedData")
     * @throws {TypeError} If secret is not provided
     * @throws {Error} If encryption fails
     *
     * @example
     * const encrypted = encrypt('sensitive data', 'mySecretKey123');
     * // Returns: "a1b2c3...iv...:d4e5f6...encrypted..."
     */
    encrypt(payload, secret){
        try {
            // Input validation
            if (!secret || typeof secret !== 'string') {
                throw new TypeError('Secret must be a non-empty string');
            }

            if (secret.length < 8) {
                logger.warn({
                    code: 'MC_CRYPTO_WEAK_SECRET',
                    message: 'Encryption secret is shorter than recommended (8+ characters)'
                });
            }

            // Generate random IV (16 bytes for AES)
            const iv = crypto.randomBytes(CRYPTO_CONFIG.IV_SIZE);

            // Create 256-bit key from secret
            const key = crypto.createHash(CRYPTO_CONFIG.HASH_ALGORITHM).update(String(secret)).digest();

            // Create cipher with AES-256-CBC
            const cipher = crypto.createCipheriv(CRYPTO_CONFIG.ALGORITHM, key, iv);

            // Encrypt payload
            let encrypted = cipher.update(String(payload), 'utf8', 'hex');
            encrypted += cipher.final('hex');

            // Prepend IV to encrypted data (IV is not secret, needed for decryption)
            return iv.toString('hex') + ':' + encrypted;

        } catch (error) {
            logger.error({
                code: 'MC_CRYPTO_ENCRYPT_ERROR',
                message: 'Encryption failed',
                error: error.message
            });
            throw new Error(`Encryption failed: ${error.message}`);
        }
    }

    /**
     * Decrypt AES-256-CBC encrypted data
     *
     * @param {String} encryption - Encrypted data with IV (format: "iv:encryptedData")
     * @param {String} secret - Decryption secret/password (must match encryption secret)
     * @returns {String} Decrypted plaintext data
     * @throws {TypeError} If inputs are invalid
     * @throws {Error} If decryption fails
     *
     * @example
     * const encrypted = encrypt('sensitive data', 'mySecretKey123');
     * const decrypted = decrypt(encrypted, 'mySecretKey123');
     * // Returns: "sensitive data"
     */
    decrypt(encryption, secret){
        try {
            // Input validation
            if (!encryption || typeof encryption !== 'string') {
                throw new TypeError('Encrypted data must be a non-empty string');
            }

            if (!secret || typeof secret !== 'string') {
                throw new TypeError('Secret must be a non-empty string');
            }

            // Split IV and encrypted data
            const parts = encryption.split(':');
            if (parts.length !== 2) {
                throw new Error('Invalid encrypted data format (expected "iv:encryptedData")');
            }

            const iv = Buffer.from(parts[0], 'hex');
            const encryptedData = parts[1];

            // Validate IV size
            if (iv.length !== CRYPTO_CONFIG.IV_SIZE) {
                throw new Error(`Invalid IV size (expected ${CRYPTO_CONFIG.IV_SIZE} bytes, got ${iv.length})`);
            }

            // Create 256-bit key from secret
            const key = crypto.createHash(CRYPTO_CONFIG.HASH_ALGORITHM).update(String(secret)).digest();

            // Create decipher
            const decipher = crypto.createDecipheriv(CRYPTO_CONFIG.ALGORITHM, key, iv);

            // Decrypt
            let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
            decrypted += decipher.final('utf8');

            return decrypted;

        } catch (error) {
            logger.error({
                code: 'MC_CRYPTO_DECRYPT_ERROR',
                message: 'Decryption failed',
                error: error.message
            });
            throw new Error(`Decryption failed: ${error.message}`);
        }
    }
    
    /**
     * Generate cryptographically secure random key
     *
     * SECURITY FIX: Now uses crypto.randomBytes() instead of Math.random()
     * for cryptographically secure random number generation
     *
     * @param {String} [hash='sha256'] - Hash algorithm (sha256, sha512, sha384, md5, sha1)
     * @returns {String} Hex-encoded random key
     * @throws {Error} If hash algorithm is invalid
     *
     * @example
     * const key256 = generateRandomKey('sha256');  // 64 character hex string
     * const key512 = generateRandomKey('sha512');  // 128 character hex string
     */
    generateRandomKey(hash = CRYPTO_CONFIG.HASH_ALGORITHM){
        // Input validation
        if (!CRYPTO_CONFIG.VALID_HASH_ALGORITHMS.includes(hash)) {
            throw new Error(
                `Invalid hash algorithm: ${hash}. ` +
                `Valid options: ${CRYPTO_CONFIG.VALID_HASH_ALGORITHMS.join(', ')}`
            );
        }

        try {
            // CRITICAL SECURITY FIX: Use crypto.randomBytes() instead of Math.random()
            // Math.random() is NOT cryptographically secure and must never be used for keys
            const randomBytes = crypto.randomBytes(32); // 32 bytes = 256 bits of entropy

            const sha = crypto.createHash(hash);
            sha.update(randomBytes);
            return sha.digest('hex');

        } catch (error) {
            logger.error({
                code: 'MC_CRYPTO_KEY_GENERATION_ERROR',
                message: 'Failed to generate random key',
                hash,
                error: error.message
            });
            throw new Error(`Key generation failed: ${error.message}`);
        }
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
        logger.warn({
            code: 'MC_TOOLS_DEPRECATED_BASE64',
            message: 'MasterTools.base64() is deprecated and only works for TEXT strings, not binary files',
            recommendation: 'Use Buffer.toString("base64") or tools.fileToBase64() instead',
            removal: 'This method will be removed in v2.0'
        });

        const $that = this;
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

    /**
     * Combine object or array of objects into target object
     *
     * @param {Object|Array} data - Source object or array of objects
     * @param {Object} objParams - Target object to merge into
     * @returns {Object} Combined object
     * @throws {TypeError} If objParams is not an object
     *
     * @example
     * combineObjandArray({ a: 1, b: 2 }, {})           // { a: 1, b: 2 }
     * combineObjandArray([{ a: 1 }, { b: 2 }], {})     // { a: 1, b: 2 }
     */
    combineObjandArray(data, objParams){
        // Input validation
        if (!objParams || typeof objParams !== 'object') {
            throw new TypeError('objParams must be an object');
        }

        if (!data) {
            return objParams;
        }

        // Prototype pollution protection
        const isSafeKey = (key) => {
            return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
        };

        if(Array.isArray(data) === false){
            // if data is object
            for (const key in data) {
                if (Object.prototype.hasOwnProperty.call(data, key) && isSafeKey(key)) {
                    objParams[key] = data[key];
                }
            }
        }
        else{
            for(let y = 0; y < data.length; y++){
                // inside array we have an object
                if (data[y] && typeof data[y] === 'object') {
                    for (const key in data[y]) {
                        if (Object.prototype.hasOwnProperty.call(data[y], key) && isSafeKey(key)) {
                            objParams[key] = data[y][key];
                        }
                    }
                }
            }
        }

        return objParams;
    }

    /**
     * Check if value is a function
     *
     * @param {*} obj - Value to check
     * @returns {Boolean} True if value is a function
     *
     * @example
     * isFunction(() => {})              // true
     * isFunction(function() {})         // true
     * isFunction({})                    // false
     */
    isFunction(obj) {
        return !!(obj && obj.constructor && obj.call && obj.apply);
    }

    /**
     * Merge source object properties into target object
     *
     * @param {Object} obj - Target object
     * @param {Object} src - Source object to merge from
     * @returns {Object} Merged object
     * @throws {TypeError} If src is not an object
     *
     * @example
     * combineObjects({ a: 1 }, { b: 2 })  // { a: 1, b: 2 }
     */
    combineObjects(obj, src) {
        // Input validation
        if (!src || typeof src !== 'object') {
            throw new TypeError('Source must be an object');
        }

        if(!obj || typeof obj !== 'object'){
            return {};
        }

        // Prototype pollution protection
        const isSafeKey = (key) => {
            return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
        };

        for(const i in src){
            if (Object.prototype.hasOwnProperty.call(src, i) && isSafeKey(i)) {
                obj[i] = src[i];
            }
        }
        return obj;
    }

    /**
     * Generate random alphanumeric ID
     *
     * WARNING: Uses Math.random() which is NOT cryptographically secure.
     * For secure keys, use generateRandomKey() instead.
     *
     * @param {Number} length - Length of ID to generate
     * @returns {String} Random alphanumeric string
     * @throws {TypeError} If length is not a number
     * @throws {Error} If length is invalid
     *
     * @example
     * makeWordId(8)   // 'aBcDeFgH'
     * makeWordId(16)  // 'xYzAbCdEfGhIjKlM'
     */
    makeWordId(length) {
        // Input validation
        if (typeof length !== 'number' || isNaN(length)) {
            throw new TypeError('Length must be a number');
        }

        if (length <= 0 || length > STRING_CONFIG.MAX_WORD_ID_LENGTH) {
            throw new Error(
                `Length must be between 1 and ${STRING_CONFIG.MAX_WORD_ID_LENGTH}`
            );
        }

        let result = '';
        const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
        const charactersLength = characters.length;
        for (let i = 0; i < length; i++) {
           result += characters.charAt(Math.floor(Math.random() * charactersLength));
        }
        return result;
    }
    
    /**
     * Merge source object properties into target object prototype
     *
     * WARNING: Modifying prototypes can be dangerous. Use with caution.
     *
     * @param {Function} obj - Constructor function with prototype to modify
     * @param {Object} src - Source object with properties to add to prototype
     * @returns {Function} Modified constructor function
     * @throws {TypeError} If obj is not a function or src is not an object
     *
     * @example
     * function MyClass() {}
     * combineObjectPrototype(MyClass, { method1: function() {} })
     * // MyClass.prototype.method1 is now available
     */
    combineObjectPrototype(obj, src) {
        // Input validation
        if (typeof obj !== 'function') {
            throw new TypeError('Object must be a constructor function');
        }

        if (!src || typeof src !== 'object') {
            throw new TypeError('Source must be an object');
        }

        // Prototype pollution protection
        const isSafeKey = (key) => {
            return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
        };

        for(const i in src){
            if (Object.prototype.hasOwnProperty.call(src, i) && isSafeKey(i)) {
                obj.prototype[i] = src[i];
            }
        }
        return obj;
    }

    /**
     * Convert array path to nested object structure
     *
     * @param {Object} obj - Target object to modify
     * @param {Array} keyPath - Array of keys representing path (e.g., ['a', 'b', 'c'])
     * @param {*} value - Value to set at the path
     * @returns {void}
     * @throws {TypeError} If obj is not an object or keyPath is not an array
     *
     * @example
     * const obj = {};
     * convertArrayToObject(obj, ['user', 'name'], 'John')
     * // obj is now: { user: { name: 'John' } }
     */
    convertArrayToObject(obj, keyPath, value) {
        // Input validation
        if (!obj || typeof obj !== 'object') {
            throw new TypeError('Object must be an object');
        }

        if (!Array.isArray(keyPath) || keyPath.length === 0) {
            throw new TypeError('keyPath must be a non-empty array');
        }

        // Prototype pollution protection
        const isSafeKey = (key) => {
            return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
        };

        let key = null;
        const lastKeyIndex = keyPath.length - 1;

        for (let i = 0; i < lastKeyIndex; ++i) {
            key = keyPath[i];

            // Security check
            if (!isSafeKey(key)) {
                throw new Error(`Unsafe key in path: ${key}`);
            }

            if (!(key in obj)) {
                obj[key] = {};
            }
            obj = obj[key];
        }

        // Security check for final key
        if (!isSafeKey(keyPath[lastKeyIndex])) {
            throw new Error(`Unsafe key in path: ${keyPath[lastKeyIndex]}`);
        }

        obj[keyPath[lastKeyIndex]] = value;
    }
    
    
}

module.exports = MasterTools;