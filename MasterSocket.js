// version 0.1.2

const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { logger } = require('./error/MasterErrorLogger');

// Socket Configuration Constants
const SOCKET_CONFIG = {
    DEFAULT_TIMEOUT: 30000, // 30 seconds
    MAX_EVENT_NAME_LENGTH: 255,
    MAX_PAYLOAD_SIZE: 10 * 1024 * 1024 // 10MB
};

// Socket Event Names
const SOCKET_EVENTS = {
    CONNECTION: 'connection',
    DISCONNECT: 'disconnect',
    ERROR: 'error',
    CONNECT_ERROR: 'connect_error'
};

// Transport Types
const TRANSPORT_TYPES = {
    WEBSOCKET: 'websocket',
    POLLING: 'polling'
};

// HTTP Methods for CORS
const HTTP_METHODS = {
    GET: 'GET',
    POST: 'POST',
    PUT: 'PUT',
    DELETE: 'DELETE'
};

/**
 * Validate controller/action name for security
 *
 * @param {string} name - Name to validate
 * @param {string} type - Type (controller or action)
 * @throws {Error} If name is invalid
 */
function validateSocketIdentifier(name, type) {
    if (!name || typeof name !== 'string') {
        throw new TypeError(`${type} name must be a non-empty string`);
    }

    // Must be valid JavaScript identifier (no path traversal, no special chars)
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) {
        throw new Error(`Invalid ${type} name: ${name}. Must be a valid identifier.`);
    }

    // Check for path traversal attempts
    if (name.includes('..') || name.includes('/') || name.includes('\\')) {
        throw new Error(`Security violation: ${type} name contains path traversal characters`);
    }

    // Check max length
    if (name.length > SOCKET_CONFIG.MAX_EVENT_NAME_LENGTH) {
        throw new Error(`${type} name exceeds maximum length (${SOCKET_CONFIG.MAX_EVENT_NAME_LENGTH})`);
    }
}

/**
 * Validate socket data array
 *
 * @param {Array} data - Data array to validate
 * @throws {Error} If data is invalid
 */
function validateSocketData(data) {
    if (!Array.isArray(data)) {
        throw new TypeError('Socket data must be an array');
    }

    if (data.length < 2) {
        throw new Error('Socket data must contain [action, payload]');
    }

    const [action, payload] = data;

    if (!action || typeof action !== 'string') {
        throw new TypeError('Socket action (data[0]) must be a non-empty string');
    }

    validateSocketIdentifier(action, 'action');

    // Check payload size (prevent DoS)
    const payloadStr = JSON.stringify(payload || {});
    if (payloadStr.length > SOCKET_CONFIG.MAX_PAYLOAD_SIZE) {
        throw new Error(`Payload exceeds maximum size (${SOCKET_CONFIG.MAX_PAYLOAD_SIZE} bytes)`);
    }
}

/**
 * Uppercase first character of a string
 *
 * @param {string} string - String to transform
 * @returns {string} String with first character uppercased
 * @example
 * jsUcfirst("hello") // Returns: "Hello"
 */
const jsUcfirst = function(string){
    return string.charAt(0).toUpperCase() + string.slice(1);
};

/**
 * MasterSocket - WebSocket management with Socket.IO
 *
 * Handles:
 * - Socket.IO server initialization with CORS
 * - Event routing to socket controllers
 * - Cross-platform socket module loading
 * - Automatic CORS configuration from config/initializers/cors.json
 *
 * @class MasterSocket
 */
class MasterSocket{

    // Lazy-load master to avoid circular dependency (Google-style lazy initialization)
    get _master() {
        if (!this.__masterCache) {
            this.__masterCache = require('./MasterControl');
        }
        return this.__masterCache;
    }

    /**
     * Initialize Socket.IO server
     *
     * Supports three initialization patterns:
     * 1. Pass HTTP server: init(server, options)
     * 2. Pass Socket.IO instance: init(io)
     * 3. Use master server: init(undefined, options) or init()
     *
     * Automatically loads CORS config from config/initializers/cors.json
     *
     * @param {Server|Object} [serverOrIo] - HTTP server or Socket.IO instance
     * @param {Object} [options={}] - Socket.IO options to merge with defaults
     * @param {Object} [options.cors] - CORS configuration
     * @param {string|string[]|boolean} [options.cors.origin] - Allowed origins
     * @param {boolean} [options.cors.credentials] - Allow credentials
     * @param {string[]} [options.cors.methods] - Allowed HTTP methods
     * @param {string[]} [options.transports] - Transport types ['websocket', 'polling']
     * @throws {Error} If no HTTP server is available
     * @returns {void}
     *
     * @example
     * // Pattern 1: Pass server explicitly
     * this._master.socket.init(server, { cors: { origin: 'https://app.com' }});
     *
     * // Pattern 2: Pass pre-configured Socket.IO instance
     * const io = new Server(server, opts);
     * this._master.socket.init(io);
     *
     * // Pattern 3: Use master server (call after this._master.start(server))
     * this._master.socket.init();
     */
    init(serverOrIo, options = {}){
        // Input validation
        if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options))) {
            throw new TypeError('Socket options must be an object');
        }

        this._baseurl = this._master.root;

        // Build Socket.IO options using master cors initializer when available
        const defaults = this._buildDefaultIoOptions();
        const ioOptions = mergeDeep(defaults, options || {});

        // Determine whether we're given an io instance or an HTTP server
        if (serverOrIo && typeof serverOrIo.of === 'function') {
            // It's already an io instance
            this.io = serverOrIo;
        } else {
            // Prefer explicit server, fallback to this._master.server
            const httpServer = serverOrIo || this._master.server;
            if (!httpServer) {
                throw new Error(
                    'MasterSocket.init requires an HTTP server. ' +
                    'Either pass the server explicitly: this._master.socket.init(server) ' +
                    'or call this._master.start(server) before socket.init(). ' +
                    'Current initialization order issue: socket.init() called before this._master.start()'
                );
            }
            this.io = new Server(httpServer, ioOptions);
        }

        this._bind();
    }

    /**
     * Build default Socket.IO options with CORS configuration
     *
     * Loads CORS settings from config/initializers/cors.json if available.
     * Falls back to sensible defaults for development.
     *
     * @private
     * @returns {Object} Socket.IO options object
     * @returns {Object} result.cors - CORS configuration
     * @returns {string[]} result.transports - Transport types
     *
     * @example
     * const opts = this._buildDefaultIoOptions();
     * // Returns: { cors: { origin: true, credentials: true, methods: ['GET', 'POST'] }, transports: ['websocket', 'polling'] }
     */
    _buildDefaultIoOptions(){
        const corsCfg = this._loadCorsConfig();
        const transports = [TRANSPORT_TYPES.WEBSOCKET, TRANSPORT_TYPES.POLLING];
        const cors = {};
        try {
            if (corsCfg) {
                if (typeof corsCfg.origin !== 'undefined') cors.origin = corsCfg.origin;
                if (typeof corsCfg.credentials !== 'undefined') cors.credentials = !!corsCfg.credentials;
                if (Array.isArray(corsCfg.methods)) cors.methods = corsCfg.methods;
                if (Array.isArray(corsCfg.allowedHeaders)) cors.allowedHeaders = corsCfg.allowedHeaders;
            } else {
                // sensible defaults for dev
                cors.origin = true;
                cors.credentials = true;
                cors.methods = [HTTP_METHODS.GET, HTTP_METHODS.POST];
            }
        } catch (_) {}
        return { cors, transports };
    }

    /**
     * Load CORS configuration from config/initializers/cors.json
     *
     * @private
     * @returns {Object|null} CORS configuration object or null if not found
     * @returns {string|string[]|boolean} result.origin - Allowed origins
     * @returns {boolean} result.credentials - Allow credentials
     * @returns {string[]} result.methods - Allowed HTTP methods
     * @returns {string[]} result.allowedHeaders - Allowed request headers
     *
     * @example
     * const corsCfg = this._loadCorsConfig();
     * // Returns: { origin: ['https://app.com'], credentials: true, methods: ['GET', 'POST'] }
     * // or null if file not found
     */
    _loadCorsConfig(){
        try {
            const cfgPath = path.join(this._master.root, 'config', 'initializers', 'cors.json');
            if (fs.existsSync(cfgPath)) {
                const raw = fs.readFileSync(cfgPath, 'utf8');
                return JSON.parse(raw);
            }
        } catch (e) {
            logger.warn({
                code: 'MC_SOCKET_CORS_LOAD_FAILED',
                message: 'Failed to load cors.json configuration',
                error: e.message,
                path: cfgPath
            });
        }
        return null;
    }

    /**
     * Bind Socket.IO event handlers
     *
     * Sets up connection handler and routes all socket events through
     * the MasterSocket.load() method for controller dispatch.
     *
     * @private
     * @returns {void}
     *
     * @example
     * // Called internally by init()
     * this._bind();
     */
    _bind(){
        const io = this.io;
        io.on(SOCKET_EVENTS.CONNECTION, (socket) => {
            try{
                logger.info({
                    code: 'MC_SOCKET_CONNECTED',
                    message: 'Socket client connected',
                    socketId: socket.id,
                    controller: socket.handshake?.query?.socket
                });

                // Route all events through MasterSocket loader
                socket.onAny((eventName, payload) => {
                    try{
                        // MasterSocket.load expects [action, payload]
                        const data = [eventName, payload];
                        // CRITICAL FIX: Use this._master instead of undefined 'master'
                        if (this._master && this._master.socket && typeof this._master.socket.load === 'function') {
                            this._master.socket.load(data, socket, io);
                        }
                    }catch(e){
                        logger.error({
                            code: 'MC_SOCKET_ROUTING_ERROR',
                            message: 'Socket event routing failed',
                            socketId: socket.id,
                            eventName,
                            error: e.message,
                            stack: e.stack
                        });
                    }
                });

                // MEMORY LEAK FIX: Add disconnect handler for cleanup
                socket.on(SOCKET_EVENTS.DISCONNECT, (reason) => {
                    try {
                        logger.info({
                            code: 'MC_SOCKET_DISCONNECTED',
                            message: 'Socket client disconnected',
                            socketId: socket.id,
                            reason,
                            controller: socket.handshake?.query?.socket
                        });

                        // Clean up event listeners
                        socket.offAny();
                        socket.removeAllListeners();
                    } catch (cleanupError) {
                        logger.error({
                            code: 'MC_SOCKET_CLEANUP_ERROR',
                            message: 'Socket cleanup failed',
                            socketId: socket.id,
                            error: cleanupError.message
                        });
                    }
                });

                // Handle socket errors
                socket.on(SOCKET_EVENTS.ERROR, (error) => {
                    logger.error({
                        code: 'MC_SOCKET_ERROR',
                        message: 'Socket error occurred',
                        socketId: socket.id,
                        error: error.message || error
                    });
                });

            }catch(e){
                logger.error({
                    code: 'MC_SOCKET_CONNECTION_ERROR',
                    message: 'Socket connection handler failed',
                    error: e.message,
                    stack: e.stack
                });
            }
        });
    }

    /**
     * Load and execute socket controller action
     *
     * Routes socket events to appropriate controller actions. Supports:
     * - PascalCase and camelCase controller names (cross-platform)
     * - Before action filters via callBeforeAction()
     * - Automatic error handling and logging
     *
     * Controller file location: {root}/app/sockets/{Controller}Socket.js
     * Controller must be specified in socket.handshake.query.socket
     *
     * @param {Array} data - [eventName, payload] tuple
     * @param {string} data[0] - Action/event name to call
     * @param {*} data[1] - Payload to pass to action
     * @param {Socket} socket - Socket.IO socket instance
     * @param {Server} io - Socket.IO server instance
     * @returns {Promise<void>}
     * @throws {Error} If controller not found or action fails
     *
     * @example
     * // Client emits: socket.emit('updateBoard', { boardId: 123 })
     * // Routes to: app/sockets/BoardSocket.js -> updateBoard(payload, socket, io)
     * await this.load(['updateBoard', { boardId: 123 }], socket, io);
     */
    async load(data, socket, io){
        try {
            // Input validation
            validateSocketData(data);

            if (!socket || typeof socket !== 'object') {
                throw new TypeError('Socket parameter must be a valid Socket.IO socket object');
            }

            if (!io || typeof io !== 'object') {
                throw new TypeError('IO parameter must be a valid Socket.IO server object');
            }

            // Validate socket has required properties
            if (!socket.handshake || !socket.handshake.query) {
                throw new Error('Socket handshake.query is required');
            }

            const controllerName = socket.handshake.query.socket;

            if (!controllerName) {
                logger.warn({
                    code: 'MC_SOCKET_NO_CONTROLLER',
                    message: 'Socket connection missing controller name in handshake.query.socket'
                });
                socket.emit(SOCKET_EVENTS.ERROR, {
                    error: 'Missing controller name',
                    code: 'MC_SOCKET_NO_CONTROLLER'
                });
                return;
            }

            validateSocketIdentifier(controllerName, 'controller');

            const controller = jsUcfirst(controllerName);

        if(controller){
            try{
                // Try case-sensitive first (PascalCase), then fallback to camelCase for cross-platform compatibility
                const moduleName = path.join(this._baseurl, 'app', 'sockets', controller + 'Socket');
                let BoardSocket;
                try {
                    BoardSocket = require(moduleName);
                } catch (e) {
                    // If PascalCase fails (Linux case-sensitive), try camelCase
                    if (e.code === 'MODULE_NOT_FOUND') {
                        const camelCaseModuleName = path.join(this._baseurl, 'app', 'sockets', controller.charAt(0).toLowerCase() + controller.slice(1) + 'Socket');
                        BoardSocket = require(camelCaseModuleName);
                    } else {
                        throw e;
                    }
                }
                const bs = new BoardSocket();
                bs.request = socket.request;
                bs.response = socket.response;
                bs.namespace = (controller).toLowerCase();
                bs.action = data[0];
                bs.type = "socket";

                data.request = socket.request;
                data.response = socket.response;
                data.namespace = (controller).toLowerCase();
                data.action = data[0];
                data.type = "socket";
                
                if(bs.callBeforeAction){
                    await bs.callBeforeAction(data);
                }

                // Check if action method exists
                if (typeof bs[data[0]] !== 'function') {
                    throw new Error(`Action '${data[0]}' not found in socket controller ${controller}`);
                }

                bs[data[0]](data[1], socket, io);
            }
            catch(ex){
                logger.error({
                    code: 'MC_SOCKET_LOAD_ERROR',
                    message: 'Socket controller load failed',
                    controller,
                    action: data[0],
                    error: ex.message,
                    stack: ex.stack
                });

                // Send error back to client
                socket.emit(SOCKET_EVENTS.ERROR, {
                    error: 'Controller action failed',
                    code: 'MC_SOCKET_LOAD_ERROR',
                    action: data[0]
                });
            }

        }
        } catch (error) {
            // Validation or unexpected errors
            logger.error({
                code: 'MC_SOCKET_VALIDATION_ERROR',
                message: 'Socket load validation failed',
                error: error.message,
                stack: error.stack
            });

            if (socket && typeof socket.emit === 'function') {
                socket.emit(SOCKET_EVENTS.ERROR, {
                    error: error.message,
                    code: 'MC_SOCKET_VALIDATION_ERROR'
                });
            }
        }
    }
}

module.exports = { MasterSocket };

/**
 * Check if value is a plain object
 *
 * @param {*} item - Value to check
 * @returns {boolean} True if plain object, false otherwise
 * @example
 * isObject({}) // true
 * isObject([]) // false
 * isObject(null) // false
 */
function isObject(item) {
    return (item && typeof item === 'object' && !Array.isArray(item));
}

/**
 * Deep merge two objects
 *
 * Recursively merges source into target, creating a new object.
 * Arrays and primitives are replaced, objects are merged.
 *
 * @param {Object} target - Target object
 * @param {Object} source - Source object to merge
 * @returns {Object} New merged object
 *
 * @example
 * const a = { cors: { origin: 'a' }, port: 3000 };
 * const b = { cors: { credentials: true }, host: 'localhost' };
 * mergeDeep(a, b);
 * // Returns: { cors: { origin: 'a', credentials: true }, port: 3000, host: 'localhost' }
 */
function mergeDeep(target, source) {
    const output = Object.assign({}, target);
    if (isObject(target) && isObject(source)) {
        Object.keys(source).forEach(key => {
            if (isObject(source[key])) {
                if (!(key in target)) Object.assign(output, { [key]: source[key] });
                else output[key] = mergeDeep(target[key], source[key]);
            } else {
                Object.assign(output, { [key]: source[key] });
            }
        });
    }
    return output;
}

/**
 * 
 * 
 * 
 * It loads CORS and methods from config/initializers/cors.json automatically. During init, it reads this._master.root/config/initializers/cors.json and builds the Socket.IO options from:
origin, credentials, methods, allowedHeaders (if present)
transports defaults to ['websocket', 'polling']
If cors.json is missing or a field isn’t present, it falls back to:
cors: { origin: true, credentials: true, methods: ['GET','POST'] }
transports: ['websocket','polling']
You can still override anything explicitly:
this._master.socket.init(this._master.server, { cors: { origin: ['https://foo.com'], methods: ['GET','POST','PUT'] }, transports: ['websocket'] })

If you don’t pass a server/io, init() falls back to this._master.server:
this._master.socket.init() → uses this._master.server automatically
You can pass overrides as the second arg:
this._master.socket.init(undefined, { cors: { origin: ['https://app.com'] }, transports: ['websocket'] })
Or pass a prebuilt io:
const io = new Server(this._master.server, opts); this._master.socket.init(io)
 */