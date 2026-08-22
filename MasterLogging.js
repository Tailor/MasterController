/**
 * MasterLogging — application logging modeled on ASP.NET Core's ILogger:
 *
 *   ASP.NET Core                                     MasterController
 *   ILogger<T> / ILoggerFactory.CreateLogger(cat)    master.createLogger('Orders.Service') / this.logger in controllers
 *   LogLevel Trace..Critical                         trace, debug, info, warn, error, critical (+ log(level, …))
 *   "Logging:LogLevel:Default" / per-category        master.configuration 'Logging:LogLevel:Default' | 'Logging:LogLevel:Orders' (prefix match)
 *   ILogger.BeginScope(state)                        logger.beginScope({ orderId }) -> dispose(); scopes flow through async code
 *   HttpContext.TraceIdentifier / X-Request-Id       every request runs in a scope { requestId, method, path }; response gets X-Request-Id
 *   providers (Console / JSON / custom)              master.logging.addProvider(fn | { write, minimumLevel }) ; console provider: pretty in dev, JSON in production
 *   structured message + properties                  logger.info('order {id} shipped', { id }) -> message rendered, properties kept
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';

export const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'critical', 'none'];
const LEVEL_RANK = Object.fromEntries(LEVELS.map((l, i) => [l, i]));
const ALIASES = { verbose: 'trace', information: 'info', warning: 'warn', fatal: 'critical', off: 'none', silent: 'none' };
export function normalizeLevel(level) {
    const l = String(level || '').toLowerCase();
    const n = ALIASES[l] || l;
    return LEVEL_RANK[n] !== undefined ? n : 'info';
}

const storage = new AsyncLocalStorage();   // scope stack: [{...state}, ...]

/** Render "{name}" placeholders from props (message templates, like Microsoft.Extensions.Logging). */
function render(template, props) {
    if (typeof template !== 'string' || !props || typeof props !== 'object') return String(template);
    return template.replace(/\{(\w+)\}/g, (m, k) => (props[k] === undefined ? m : (typeof props[k] === 'object' ? JSON.stringify(props[k]) : String(props[k]))));
}

function serializeError(err) {
    if (!err) return undefined;
    if (!(err instanceof Error)) return err;
    return { name: err.name, message: err.message, stack: err.stack, code: err.code, ...(err.cause ? { cause: serializeError(err.cause) } : {}) };
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const COLORS = { trace: '\x1b[90m', debug: '\x1b[36m', info: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m', critical: '\x1b[35m' };
const RESET = '\x1b[0m';

/** Console provider: JSON lines in production (or json:true), readable lines otherwise. */
export function consoleProvider({ json = process.env.NODE_ENV === 'production', stream = process.stdout, errStream = process.stderr, colors = true } = {}) {
    return {
        name: 'console',
        write(entry) {
            const out = LEVEL_RANK[entry.level] >= LEVEL_RANK.error ? errStream : stream;
            if (json) { out.write(JSON.stringify(entry) + '\n'); return; }
            const c = colors && out.isTTY ? COLORS[entry.level] || '' : '';
            const r = c ? RESET : '';
            const scope = entry.scope && Object.keys(entry.scope).length ? ' ' + JSON.stringify(entry.scope) : '';
            const props = entry.properties && Object.keys(entry.properties).length ? ' ' + JSON.stringify(entry.properties) : '';
            const err = entry.error ? `\n  ${entry.error.stack || entry.error.message || entry.error}` : '';
            out.write(`${c}[${entry.timestamp}] ${entry.level.toUpperCase().padEnd(8)}${r} ${entry.category}: ${entry.message}${scope}${props}${err}\n`);
        },
    };
}
/** Collect entries in memory (tests / in-process inspection). */
export function memoryProvider(limit = 1000) {
    const entries = [];
    return { name: 'memory', entries, write(e) { entries.push(e); if (entries.length > limit) entries.shift(); }, clear() { entries.length = 0; } };
}

// ---------------------------------------------------------------------------
// Factory + logger
// ---------------------------------------------------------------------------

export class LoggerFactory {
    /**
     * @param {{configuration?:Object, minimumLevel?:string, providers?:Array, environment?:string, redact?:string[]}} [opts]
     *   configuration: master.configuration (reads Logging:LogLevel:*, Logging:Console:Json)
     */
    constructor(opts = {}) {
        this._configuration = opts.configuration || null;
        this._defaultLevel = normalizeLevel(opts.minimumLevel || 'info');
        this._rules = [];                  // [{ prefix, level }], longest prefix wins
        this._providers = [];
        this._loggers = new Map();
        this._enrichers = [];
        this.redact = new Set((opts.redact || ['password', 'passwordHash', 'secret', 'token', 'authorization', 'cookie', 'apiKey', 'api_key', 'creditCard']).map(s => s.toLowerCase()));
        if (opts.providers) for (const p of opts.providers) this.addProvider(p);
        this.applyConfiguration();
        if (this._configuration && typeof this._configuration.onChange === 'function') this._configuration.onChange(() => this.applyConfiguration());
    }

    /** Read Logging:LogLevel:{Default|Category prefix} (+ Logging:MinimumLevel) from configuration. */
    applyConfiguration() {
        const cfg = this._configuration;
        if (!cfg) return this;
        const section = (typeof cfg.getSection === 'function' ? cfg.getSection('Logging:LogLevel') : null) || {};
        const rules = [];
        for (const [k, v] of Object.entries(section)) {
            if (k.toLowerCase() === 'default') this._defaultLevel = normalizeLevel(v);
            else rules.push({ prefix: k, level: normalizeLevel(v) });
        }
        const min = typeof cfg.get === 'function' ? cfg.get('Logging:MinimumLevel') : undefined;
        if (min) this._defaultLevel = normalizeLevel(min);
        this._rules = rules;
        return this;
    }

    setMinimumLevel(level, categoryPrefix) {
        if (categoryPrefix) { this._rules = this._rules.filter(r => r.prefix.toLowerCase() !== categoryPrefix.toLowerCase()); this._rules.push({ prefix: categoryPrefix, level: normalizeLevel(level) }); }
        else this._defaultLevel = normalizeLevel(level);
        return this;
    }
    levelFor(category) {
        let best = null;
        for (const r of this._rules) {
            if (String(category).toLowerCase().startsWith(r.prefix.toLowerCase()) && (!best || r.prefix.length > best.prefix.length)) best = r;
        }
        return best ? best.level : this._defaultLevel;
    }

    /** Provider: function(entry) or { name, write(entry), minimumLevel? } */
    addProvider(provider) {
        if (typeof provider === 'function') provider = { name: provider.name || 'custom', write: provider };
        if (!provider || typeof provider.write !== 'function') throw new TypeError('logging.addProvider: expected a function(entry) or { write(entry) }');
        this._providers.push(provider);
        return () => { this._providers = this._providers.filter(p => p !== provider); };
    }
    clearProviders() { this._providers = []; return this; }
    get providers() { return this._providers.map(p => p.name || 'custom'); }
    /** Add properties to every entry (e.g. service name, version). */
    enrich(fn) { this._enrichers.push(typeof fn === 'function' ? fn : () => fn); return this; }

    createLogger(category = 'app') {
        const key = String(category);
        if (!this._loggers.has(key)) this._loggers.set(key, new Logger(this, key));
        return this._loggers.get(key);
    }

    /** Current ambient scope (merged), e.g. { requestId, method, path, ...beginScope states } */
    static currentScope() {
        const stack = storage.getStore();
        if (!stack || !stack.length) return {};
        return Object.assign({}, ...stack);
    }
    /** Run fn inside a logging scope (all logs within — across awaits — carry the state). */
    static runInScope(state, fn) {
        const stack = storage.getStore() || [];
        return storage.run([...stack, state || {}], fn);
    }

    _redactValue(key, value) {
        if (this.redact.has(String(key).toLowerCase())) return '[REDACTED]';
        if (value && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value)) {
            const out = {};
            for (const [k, v] of Object.entries(value)) out[k] = this._redactValue(k, v);
            return out;
        }
        return value;
    }

    _emit(category, level, message, props, error) {
        if (!this._providers.length) return;
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            category,
            message: render(message, props),
            properties: props ? this._redactValue('', props) : undefined,
            error: serializeError(error),
            scope: LoggerFactory.currentScope(),
        };
        const scopeKeys = Object.keys(entry.scope);
        if (!scopeKeys.length) delete entry.scope;
        if (entry.properties === undefined) delete entry.properties;
        if (entry.error === undefined) delete entry.error;
        for (const fn of this._enrichers) { try { Object.assign(entry, fn(entry) || {}); } catch (_) { /* ignore */ } }
        for (const p of this._providers) {
            if (p.minimumLevel && LEVEL_RANK[level] < LEVEL_RANK[normalizeLevel(p.minimumLevel)]) continue;
            try { p.write(entry); } catch (_) { /* a broken sink must not break the app */ }
        }
    }
}

export class Logger {
    constructor(factory, category) { this._factory = factory; this.category = category; }
    isEnabled(level) { const l = normalizeLevel(level); return l !== 'none' && LEVEL_RANK[l] >= LEVEL_RANK[this._factory.levelFor(this.category)]; }
    /**
     * log(level, message, [propsOrError], [error])
     *   logger.info('user {id} logged in', { id })
     *   logger.error('import failed', err) / logger.error('import failed', { file }, err)
     */
    log(level, message, a, b) {
        const l = normalizeLevel(level);
        if (!this.isEnabled(l)) return;
        let props, error;
        if (a instanceof Error) { error = a; props = b && typeof b === 'object' ? b : undefined; }
        else { props = a && typeof a === 'object' ? a : undefined; error = b instanceof Error ? b : undefined; }
        this._factory._emit(this.category, l, message, props, error);
    }
    trace(m, a, b) { this.log('trace', m, a, b); }
    debug(m, a, b) { this.log('debug', m, a, b); }
    info(m, a, b) { this.log('info', m, a, b); }
    warn(m, a, b) { this.log('warn', m, a, b); }
    error(m, a, b) { this.log('error', m, a, b); }
    critical(m, a, b) { this.log('critical', m, a, b); }
    fatal(m, a, b) { this.log('critical', m, a, b); }
    /** ILogger.BeginScope: returns a disposer; state is attached to every log within the current async context. */
    beginScope(state) {
        const stack = storage.getStore();
        if (!stack) {
            // Not inside an async context we control: emulate by enterWith (affects the current continuation).
            storage.enterWith([state || {}]);
            return () => { storage.enterWith([]); };
        }
        stack.push(state || {});
        return () => { const i = stack.lastIndexOf(state); if (i >= 0) stack.splice(i, 1); };
    }
    /** Run fn inside a scope (preferred: async-safe). */
    scope(state, fn) { return LoggerFactory.runInScope(state, fn); }
    /** Child logger with a sub-category (ILogger<T> for a nested component). */
    child(suffix) { return this._factory.createLogger(`${this.category}.${suffix}`); }
}

/** Pipeline middleware: run each request in a logging scope with a correlation id (X-Request-Id honored / generated). */
export function requestLoggingScope(factory, { header = 'x-request-id', logRequests = true, category = 'Request' } = {}) {
    const logger = factory.createLogger(category);
    return async function requestScopeMiddleware(ctx, next) {
        const incoming = ctx.request && ctx.request.headers && ctx.request.headers[header];
        const requestId = (typeof incoming === 'string' && /^[\w.-]{1,128}$/.test(incoming)) ? incoming : crypto.randomUUID();
        ctx.requestId = requestId;
        try { if (ctx.response && !ctx.response.headersSent) ctx.response.setHeader('X-Request-Id', requestId); } catch (_) { /* ignore */ }
        const started = Date.now();
        await LoggerFactory.runInScope({ requestId, method: ctx.type, path: ctx.pathName ? '/' + ctx.pathName : (ctx.request && ctx.request.url) }, async () => {
            try {
                await next();
            } finally {
                if (logRequests && logger.isEnabled('info')) {
                    const res = ctx.response;
                    const finish = () => logger.info('{method} {path} -> {status} in {durationMs}ms', { method: (ctx.type || '').toUpperCase(), path: '/' + (ctx.pathName || ''), status: res ? res.statusCode : undefined, durationMs: Date.now() - started });
                    if (res && typeof res.once === 'function' && !res.writableEnded) res.once('finish', finish); else finish();
                }
            }
        });
    };
}

export default LoggerFactory;
