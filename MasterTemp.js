// version 0.1.0 - FAANG-level refactor with bug fixes and complete feature set

const { logger } = require('./error/MasterErrorLogger');

// Configuration Constants
const TEMP_CONFIG = {
    MAX_KEY_LENGTH: 255,
    MAX_VALUE_SIZE: 10 * 1024 * 1024, // 10MB
    MAX_KEYS: 10000
};

/**
 * MasterTemp - Temporary data storage utility
 *
 * Provides a simple key-value store for temporary data within a request lifecycle.
 * Thread-safe when used per-request (each request gets its own instance).
 *
 * Features:
 * - Type-safe storage with validation
 * - Reserved key protection
 * - Prototype pollution prevention
 * - Size limits for DoS protection
 * - Complete CRUD operations
 * - Utility methods (keys, size, isEmpty)
 *
 * @class MasterTemp
 */
class MasterTemp{

    temp = {};
    _reservedKeys = new Set(['temp', '_master', '__masterCache', '_reservedKeys', 'add', 'get', 'has', 'clear', 'clearAll', 'keys', 'size', 'isEmpty', 'toJSON']);

    // Lazy-load master to avoid circular dependency (Google-style lazy initialization)
    get _master() {
        if (!this.__masterCache) {
            this.__masterCache = require('./MasterControl');
        }
        return this.__masterCache;
    }

    /**
     * Validate key name for security and correctness
     *
     * @private
     * @param {string} name - Key name to validate
     * @throws {TypeError} If name is not a string
     * @throws {Error} If name is empty, reserved, too long, or contains dangerous characters
     */
    _validateKey(name) {
        if (typeof name !== 'string') {
            throw new TypeError('Key name must be a string');
        }

        if (!name || name.trim() === '') {
            throw new Error('Key name cannot be empty');
        }

        if (this._reservedKeys.has(name)) {
            throw new Error(`Key name '${name}' is reserved and cannot be used`);
        }

        if (name.length > TEMP_CONFIG.MAX_KEY_LENGTH) {
            throw new Error(`Key name exceeds maximum length (${TEMP_CONFIG.MAX_KEY_LENGTH} characters)`);
        }

        // Prevent prototype pollution
        if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
            throw new Error(`Key name '${name}' is forbidden (prototype pollution protection)`);
        }

        // Check for dangerous characters
        if (/[<>{}[\]\\^`|]/.test(name)) {
            throw new Error(`Key name contains invalid characters: ${name}`);
        }
    }

    /**
     * Validate value size for DoS protection
     *
     * @private
     * @param {*} data - Value to validate
     * @throws {Error} If value exceeds maximum size
     */
    _validateValue(data) {
        try {
            const jsonStr = JSON.stringify(data);
            if (jsonStr.length > TEMP_CONFIG.MAX_VALUE_SIZE) {
                throw new Error(`Value exceeds maximum size (${TEMP_CONFIG.MAX_VALUE_SIZE} bytes)`);
            }
        } catch (e) {
            if (e.message.includes('circular')) {
                throw new Error('Value contains circular references and cannot be stored');
            }
            throw e;
        }
    }

    /**
     * Add or update temporary data
     *
     * @param {string} name - Key name for the data
     * @param {*} data - Data to store (any JSON-serializable value)
     * @returns {boolean} True if successful, false otherwise
     * @throws {TypeError} If name is not a string
     * @throws {Error} If name is reserved, invalid, or value is too large
     *
     * @example
     * temp.add('userId', 123);
     * temp.add('userData', { name: 'John', email: 'john@example.com' });
     * temp.add('items', [1, 2, 3]);
     */
    add(name, data){
        try {
            this._validateKey(name);
            this._validateValue(data);

            // Check max keys limit
            if (!this.has(name) && this.size() >= TEMP_CONFIG.MAX_KEYS) {
                throw new Error(`Maximum number of keys (${TEMP_CONFIG.MAX_KEYS}) exceeded`);
            }

            // CRITICAL FIX: Store in this.temp[name] not this[name]
            this.temp[name] = data;

            logger.debug({
                code: 'MC_TEMP_ADD',
                message: 'Temporary data added',
                key: name
            });

            return true;

        } catch (error) {
            logger.error({
                code: 'MC_TEMP_ADD_ERROR',
                message: 'Failed to add temporary data',
                key: name,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Get temporary data by key
     *
     * @param {string} name - Key name
     * @param {*} [defaultValue] - Default value if key doesn't exist
     * @returns {*} Stored value or defaultValue if not found
     *
     * @example
     * const userId = temp.get('userId');
     * const theme = temp.get('theme', 'dark'); // Returns 'dark' if not set
     */
    get(name, defaultValue = undefined) {
        try {
            this._validateKey(name);
            return this.has(name) ? this.temp[name] : defaultValue;
        } catch (error) {
            logger.warn({
                code: 'MC_TEMP_GET_ERROR',
                message: 'Failed to get temporary data',
                key: name,
                error: error.message
            });
            return defaultValue;
        }
    }

    /**
     * Check if key exists in temporary storage
     *
     * @param {string} name - Key name to check
     * @returns {boolean} True if key exists, false otherwise
     *
     * @example
     * if (temp.has('userId')) {
     *   console.log('User ID is set');
     * }
     */
    has(name) {
        try {
            this._validateKey(name);
            return Object.prototype.hasOwnProperty.call(this.temp, name);
        } catch (error) {
            return false;
        }
    }

    /**
     * Delete a single key from temporary storage
     *
     * @param {string} name - Key name to delete
     * @returns {boolean} True if key was deleted, false if it didn't exist
     *
     * @example
     * temp.clear('userId'); // Remove userId from storage
     */
    clear(name) {
        try {
            this._validateKey(name);

            if (this.has(name)) {
                delete this.temp[name];

                logger.debug({
                    code: 'MC_TEMP_CLEAR',
                    message: 'Temporary data cleared',
                    key: name
                });

                return true;
            }

            return false;

        } catch (error) {
            logger.error({
                code: 'MC_TEMP_CLEAR_ERROR',
                message: 'Failed to clear temporary data',
                key: name,
                error: error.message
            });
            return false;
        }
    }

    /**
     * Clear all temporary data
     *
     * @returns {number} Number of keys cleared
     *
     * @example
     * const cleared = temp.clearAll();
     * console.log(`Cleared ${cleared} keys`);
     */
    clearAll(){
        try {
            const count = this.size();

            // CRITICAL FIX: Iterate over this.temp, not this
            for (const key in this.temp) {
                if (Object.prototype.hasOwnProperty.call(this.temp, key)) {
                    delete this.temp[key];
                }
            }

            logger.debug({
                code: 'MC_TEMP_CLEAR_ALL',
                message: 'All temporary data cleared',
                count
            });

            return count;

        } catch (error) {
            logger.error({
                code: 'MC_TEMP_CLEAR_ALL_ERROR',
                message: 'Failed to clear all temporary data',
                error: error.message
            });
            return 0;
        }
    }

    /**
     * Get all keys in temporary storage
     *
     * @returns {string[]} Array of key names
     *
     * @example
     * const keys = temp.keys();
     * console.log('Stored keys:', keys); // ['userId', 'theme', 'items']
     */
    keys() {
        return Object.keys(this.temp);
    }

    /**
     * Get number of keys in temporary storage
     *
     * @returns {number} Number of stored keys
     *
     * @example
     * console.log(`Storage contains ${temp.size()} items`);
     */
    size() {
        return Object.keys(this.temp).length;
    }

    /**
     * Check if temporary storage is empty
     *
     * @returns {boolean} True if no keys stored, false otherwise
     *
     * @example
     * if (temp.isEmpty()) {
     *   console.log('No temporary data stored');
     * }
     */
    isEmpty() {
        return this.size() === 0;
    }

    /**
     * Convert temporary storage to plain JSON object
     *
     * @returns {Object} Plain object containing all key-value pairs
     *
     * @example
     * const snapshot = temp.toJSON();
     * console.log(JSON.stringify(snapshot));
     */
    toJSON() {
        return { ...this.temp };
    }
}

module.exports = { MasterTemp };
