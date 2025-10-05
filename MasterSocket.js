// version 0.1.2

var master = require('./MasterControl');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

var jsUcfirst = function(string){
    return string.charAt(0).toUpperCase() + string.slice(1);
};

class MasterSocket{
    
    init(serverOrIo, options = {}){
        this._baseurl = master.root;

        // Build Socket.IO options using master cors initializer when available
        const defaults = this._buildDefaultIoOptions();
        const ioOptions = mergeDeep(defaults, options || {});

        // Determine whether we're given an io instance or an HTTP server
        if (serverOrIo && typeof serverOrIo.of === 'function') {
            // It's already an io instance
            this.io = serverOrIo;
        } else {
            // Prefer explicit server, fallback to master.server
            const httpServer = serverOrIo || master.server;
            if (!httpServer) {
                throw new Error('MasterSocket.init requires an HTTP server or a pre-created Socket.IO instance');
            }
            this.io = new Server(httpServer, ioOptions);
        }

        this._bind();
    }

    _buildDefaultIoOptions(){
        const corsCfg = this._loadCorsConfig();
        const transports = ['websocket', 'polling'];
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
                cors.methods = ['GET','POST'];
            }
        } catch (_) {}
        return { cors, transports };
    }

    _loadCorsConfig(){
        try {
            const cfgPath = path.join(master.root, 'config', 'initializers', 'cors.json');
            if (fs.existsSync(cfgPath)) {
                const raw = fs.readFileSync(cfgPath, 'utf8');
                return JSON.parse(raw);
            }
        } catch (e) {
            try { console.warn('[MasterSocket] Failed to load cors.json:', e && e.message ? e.message : e); } catch(_){}
        }
        return null;
    }

    _bind(){
        const io = this.io;
        io.on('connection', (socket) => {
            try{
                // Route all events through MasterSocket loader
                socket.onAny((eventName, payload) => {
                    try{
                        // MasterSocket.load expects [action, payload]
                        const data = [eventName, payload];
                        if (master && master.socket && typeof master.socket.load === 'function') {
                            master.socket.load(data, socket, io);
                        }
                    }catch(e){
                        try { console.error('Socket routing error:', e?.message || e); } catch(_){}
                    }
                });
            }catch(e){
                try { console.error('Socket connection handler error:', e?.message || e); } catch(_){}
            }
        });
    }

    async load(data, socket, io){
        var controller = jsUcfirst(socket.handshake.query.socket);
        if(controller){
            try{
                // Try case-sensitive first (PascalCase), then fallback to camelCase for cross-platform compatibility
                var moduleName = this._baseurl + "/app/sockets/" + controller + "Socket";
                var BoardSocket;
                try {
                    BoardSocket = require(moduleName);
                } catch (e) {
                    // If PascalCase fails (Linux case-sensitive), try camelCase
                    if (e.code === 'MODULE_NOT_FOUND') {
                        var camelCaseModuleName = this._baseurl + "/app/sockets/" + controller.charAt(0).toLowerCase() + controller.slice(1) + "Socket";
                        BoardSocket = require(camelCaseModuleName);
                    } else {
                        throw e;
                    }
                }
                var bs = new BoardSocket();
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

                bs[data[0]](data[1], socket, io);
            }
            catch(ex){
                master.error.log(ex, "warn");
            }

        }
    }
}

master.extend("socket", MasterSocket);

// shallow+deep merge helper
function isObject(item) {
    return (item && typeof item === 'object' && !Array.isArray(item));
}
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
 * It loads CORS and methods from config/initializers/cors.json automatically. During init, it reads master.root/config/initializers/cors.json and builds the Socket.IO options from:
origin, credentials, methods, allowedHeaders (if present)
transports defaults to ['websocket', 'polling']
If cors.json is missing or a field isn’t present, it falls back to:
cors: { origin: true, credentials: true, methods: ['GET','POST'] }
transports: ['websocket','polling']
You can still override anything explicitly:
master.socket.init(master.server, { cors: { origin: ['https://foo.com'], methods: ['GET','POST','PUT'] }, transports: ['websocket'] })

If you don’t pass a server/io, init() falls back to master.server:
master.socket.init() → uses master.server automatically
You can pass overrides as the second arg:
master.socket.init(undefined, { cors: { origin: ['https://app.com'] }, transports: ['websocket'] })
Or pass a prebuilt io:
const io = new Server(master.server, opts); master.socket.init(io)
 */