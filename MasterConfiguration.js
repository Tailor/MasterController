/**
 * MasterConfiguration — layered configuration + Options pattern, modeled on
 * ASP.NET Core's IConfiguration / IOptions<T> / IHostEnvironment.
 *
 *   ASP.NET Core                                     MasterController
 *   appsettings.json + appsettings.{Env}.json        config/appsettings.json + config/appsettings.{env}.json
 *   (existing) env.{env}.json                        config/environments/env.{env}.json  (kept — contexts/connections)
 *   user-secrets (outside the repo)                  ~/.master/usersecrets/<id>/secrets.json  (master.userSecretsId / MASTER_USER_SECRETS_ID)
 *   environment variables  A__B -> A:B               same (`__` = ':'), optional prefix filter
 *   command line --A:B=value                         same
 *   IConfiguration["Section:Key"]                    master.configuration.get('Section:Key', default)
 *   GetSection / Bind                                master.configuration.getSection('Section') / bind('Section', defaults)
 *   GetConnectionString("Default")                   master.configuration.getConnectionString('Default')
 *   IOptions<T> + ValidateDataAnnotations + ValidateOnStart
 *                                                    master.options.configure('Smtp', { schema, defaults, validate }) -> validated at master.start()
 *   IOptionsMonitor<T>.OnChange                      master.options.onChange('Smtp', cb)  (file reloadOnChange)
 *   IHostEnvironment.IsDevelopment()                 master.environment.isDevelopment / isProduction / name
 *
 * Precedence (later wins): appsettings.json < appsettings.{env}.json < env.{env}.json
 *                          < user secrets < environment variables < command line < in-memory overrides.
 * Keys are case-insensitive, ':' separated (like ASP.NET).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep-merge b into a (objects merged, everything else replaced). */
function deepMerge(a, b) {
    const out = isPlainObject(a) ? { ...a } : {};
    for (const [k, v] of Object.entries(b || {})) {
        const existingKey = Object.keys(out).find(x => x.toLowerCase() === k.toLowerCase()) ?? k;
        out[existingKey] = (isPlainObject(v) && isPlainObject(out[existingKey])) ? deepMerge(out[existingKey], v) : v;
    }
    return out;
}

/** Set a ':'-separated key into a nested object (case-insensitive on existing levels). */
function setPath(obj, key, value) {
    const parts = String(key).split(':').filter(Boolean);
    let cur = obj;
    for (let i = 0; i < parts.length; i++) {
        const raw = parts[i];
        const existing = Object.keys(cur).find(x => x.toLowerCase() === raw.toLowerCase());
        const name = existing ?? raw;
        if (i === parts.length - 1) { cur[name] = value; return; }
        if (!isPlainObject(cur[name])) cur[name] = {};
        cur = cur[name];
    }
}

/** Read a ':'-separated key from a nested object (case-insensitive). */
function getPath(obj, key) {
    if (key === undefined || key === null || key === '') return obj;
    const parts = String(key).split(':').filter(Boolean);
    let cur = obj;
    for (const raw of parts) {
        if (!isPlainObject(cur)) return undefined;
        const existing = Object.keys(cur).find(x => x.toLowerCase() === raw.toLowerCase());
        if (existing === undefined) return undefined;
        cur = cur[existing];
    }
    return cur;
}

/** Coerce "true"/"false"/numbers from env vars / command line (strings stay strings otherwise). */
function coerceScalar(v) {
    if (typeof v !== 'string') return v;
    const t = v.trim();
    if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
    if (/^-?\d+(\.\d+)?$/.test(t) && t.length < 16) return Number(t);
    return v;
}

export class ConfigurationRoot {
    /**
     * @param {{root?:string, environment?:string, userSecretsId?:string, envPrefix?:string, argv?:string[], reloadOnChange?:boolean}} [opts]
     */
    constructor(opts = {}) {
        this._opts = { ...opts };
        this._sources = [];          // { name, kind, path?, load: () => object }
        this._data = {};
        this._listeners = new Set();
        this._watchers = [];
        this._built = false;
        this._overrides = {};
    }

    // ---- source builders (AddJsonFile / AddEnvironmentVariables / ...) ----

    addJsonFile(file, { optional = true, reloadOnChange = false } = {}) {
        const abs = path.isAbsolute(file) ? file : path.join(this._opts.root || process.cwd(), file);
        this._sources.push({ name: path.basename(abs), kind: 'json', path: abs, optional, reloadOnChange, load: () => this._readJson(abs, optional) });
        return this;
    }
    addUserSecrets(id) {
        const secretsId = id || this._opts.userSecretsId || process.env.MASTER_USER_SECRETS_ID;
        if (!secretsId) return this;
        const file = ConfigurationRoot.userSecretsPath(secretsId);
        this._sources.push({ name: `usersecrets:${secretsId}`, kind: 'secrets', path: file, optional: true, load: () => this._readJson(file, true) });
        return this;
    }
    /** Env vars: `A__B=1` -> A:B; with a prefix only `PREFIX_A__B` are read (prefix stripped). */
    addEnvironmentVariables(prefix) {
        this._sources.push({ name: prefix ? `env:${prefix}` : 'env', kind: 'env', load: () => ConfigurationRoot.fromEnvironment(process.env, prefix) });
        return this;
    }
    /** Command line: --A:B=value, --A:B value, --a-b=value (dashes -> ':' only when '--' form contains ':') */
    addCommandLine(argv) {
        this._sources.push({ name: 'argv', kind: 'argv', load: () => ConfigurationRoot.fromArgv(argv || this._opts.argv || process.argv.slice(2)) });
        return this;
    }
    addInMemory(obj, name = 'memory') {
        const data = obj && typeof obj === 'object' ? obj : {};
        this._sources.push({ name, kind: 'memory', load: () => data });
        return this;
    }

    /** The default ASP.NET-like layering for an app root + environment. */
    addDefaults() {
        const env = this._opts.environment || process.env.NODE_ENV || 'development';
        this.addJsonFile(path.join('config', 'appsettings.json'), { optional: true, reloadOnChange: !!this._opts.reloadOnChange });
        this.addJsonFile(path.join('config', `appsettings.${env}.json`), { optional: true, reloadOnChange: !!this._opts.reloadOnChange });
        this.addJsonFile(path.join('config', 'environments', `env.${env}.json`), { optional: true, reloadOnChange: !!this._opts.reloadOnChange });
        this.addUserSecrets();
        this.addEnvironmentVariables(this._opts.envPrefix);
        this.addCommandLine();
        return this;
    }

    /** (Re)load every source in order. Safe to call again (e.g. after root/environment change). */
    build() {
        let data = {};
        for (const src of this._sources) {
            let part;
            try { part = src.load() || {}; }
            catch (err) {
                if (src.optional === false) throw err;
                part = {};
            }
            data = deepMerge(data, part);
        }
        data = deepMerge(data, this._overrides);
        this._data = data;
        this._built = true;
        this._installWatchers();
        return this;
    }

    // ---- reading ----

    get(key, defaultValue) {
        if (!this._built) this.build();
        const v = getPath(this._data, key);
        return v === undefined ? defaultValue : v;
    }
    has(key) { return this.get(key) !== undefined; }
    getSection(key) { const v = this.get(key); return isPlainObject(v) ? v : (v === undefined ? {} : v); }
    /** ASP.NET GetConnectionString: ConnectionStrings:<name> */
    getConnectionString(name) { return this.get(`ConnectionStrings:${name}`); }
    /** Bind a section over defaults (ASP.NET Bind/Get<T>): returns a merged plain object. */
    bind(key, defaults = {}) { return deepMerge(defaults, this.getSection(key)); }
    /** Runtime override (highest precedence). Triggers change notifications. */
    set(key, value) { setPath(this._overrides, key, value); this.build(); this._notify(key); return this; }
    toJSON() { if (!this._built) this.build(); return this._data; }
    get sources() { return this._sources.map(s => ({ name: s.name, kind: s.kind, path: s.path })); }

    /** Re-read files/env and notify listeners (IOptionsMonitor-style). */
    reload() { this.build(); this._notify(null); return this; }
    onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
    _notify(key) { for (const fn of [...this._listeners]) { try { fn(this, key); } catch (_) { /* listener error */ } } }

    _installWatchers() {
        for (const w of this._watchers) { try { w.close(); } catch (_) { /* ignore */ } }
        this._watchers = [];
        for (const src of this._sources) {
            if (src.kind !== 'json' || !src.reloadOnChange || !fs.existsSync(src.path)) continue;
            try {
                const w = fs.watch(src.path, { persistent: false }, () => { try { this.reload(); } catch (_) { /* keep last good config */ } });
                this._watchers.push(w);
            } catch (_) { /* platform without fs.watch */ }
        }
    }
    close() { for (const w of this._watchers) { try { w.close(); } catch (_) { /* ignore */ } } this._watchers = []; }

    _readJson(file, optional) {
        if (!fs.existsSync(file)) { if (optional) return {}; throw new Error(`Configuration file not found: ${file}`); }
        const text = fs.readFileSync(file, 'utf8');
        if (!text.trim()) return {};
        try { return JSON.parse(text); } catch (err) { throw new Error(`Configuration file ${file} is not valid JSON: ${err.message}`); }
    }

    static fromEnvironment(env, prefix) {
        const out = {};
        for (const [rawKey, value] of Object.entries(env || {})) {
            let key = rawKey;
            if (prefix) { if (!key.startsWith(prefix)) continue; key = key.slice(prefix.length); }
            if (!key.includes('__')) continue;             // only hierarchical keys (A__B) are configuration
            setPath(out, key.split('__').filter(Boolean).join(':'), coerceScalar(value));
        }
        return out;
    }
    static fromArgv(argv) {
        const out = {};
        const args = Array.isArray(argv) ? argv : [];
        for (let i = 0; i < args.length; i++) {
            const a = args[i];
            if (typeof a !== 'string' || !a.startsWith('--')) continue;
            let body = a.slice(2), value;
            const eq = body.indexOf('=');
            if (eq >= 0) { value = body.slice(eq + 1); body = body.slice(0, eq); }
            else if (i + 1 < args.length && !String(args[i + 1]).startsWith('--')) { value = args[++i]; }
            else value = 'true';
            if (!body) continue;
            setPath(out, body.replace(/__/g, ':'), coerceScalar(value));
        }
        return out;
    }
    static userSecretsPath(id) {
        const base = process.env.MASTER_USER_SECRETS_PATH || path.join(os.homedir(), '.master', 'usersecrets');
        return path.join(base, String(id).replace(/[^A-Za-z0-9._-]/g, '_'), 'secrets.json');
    }
}

// ---------------------------------------------------------------------------
// Options pattern (IOptions<T> / IOptionsMonitor<T> / ValidateOnStart)
// ---------------------------------------------------------------------------

export class OptionsManager {
    /**
     * @param {ConfigurationRoot} configuration
     * @param {(data:Object, schema:Object)=>Promise<{valid:boolean,value:Object,errors:Object}>} [validateFn] the 2.4.0 validation engine
     */
    constructor(configuration, validateFn) {
        this._configuration = configuration;
        this._validate = validateFn || null;
        this._defs = new Map();       // name -> { section, schema, defaults, validate, postConfigure }
        this._values = new Map();
        this._listeners = new Map();  // name -> Set(cb)
        if (configuration && typeof configuration.onChange === 'function') {
            configuration.onChange(() => { this._invalidateAll(); });
        }
    }

    /**
     * Register an options type (ASP.NET services.Configure<T>(config.GetSection(...)) + Validate...).
     * @param {string} name       options name, also the default configuration section
     * @param {{section?:string, schema?:Object, defaults?:Object, validate?:(value)=>string|string[]|boolean|Promise, postConfigure?:(value)=>Object}} [def]
     */
    configure(name, def = {}) {
        if (!name || typeof name !== 'string') throw new TypeError('options.configure(name, definition) requires a name');
        this._defs.set(name, { section: def.section || name, schema: def.schema || null, defaults: def.defaults || {}, validate: def.validate || null, postConfigure: def.postConfigure || null });
        this._values.delete(name);
        return this;
    }

    /** Current validated value (throws if invalid — like IOptions<T>.Value with ValidateOnStart). */
    async getAsync(name) {
        if (this._values.has(name)) return this._values.get(name);
        const def = this._defs.get(name);
        if (!def) throw new Error(`options: '${name}' is not configured (call master.options.configure('${name}', {...}))`);
        let value = this._configuration ? this._configuration.bind(def.section, def.defaults) : { ...def.defaults };
        const errors = [];
        if (def.schema && this._validate) {
            const r = await this._validate(value, def.schema, { allowUnknown: true });
            if (!r.valid) for (const [f, msgs] of Object.entries(r.errors)) errors.push(...msgs.map(m => `${f}: ${m}`));
            else value = { ...value, ...r.value };
        }
        if (typeof def.validate === 'function') {
            const r = await def.validate(value);
            if (r === false) errors.push(`${name} options are invalid`);
            else if (typeof r === 'string' && r) errors.push(r);
            else if (Array.isArray(r)) errors.push(...r.filter(Boolean));
        }
        if (errors.length) {
            const err = new Error(`Options validation failed for '${name}':\n  - ${errors.join('\n  - ')}`);
            err.code = 'MC_OPTIONS_INVALID'; err.options = name; err.errors = errors;
            throw err;
        }
        if (typeof def.postConfigure === 'function') value = (await def.postConfigure(value)) || value;
        Object.freeze(value);
        this._values.set(name, value);
        return value;
    }
    /** Synchronous read of an already-validated value (after start()); throws if not yet validated. */
    get(name) {
        if (!this._values.has(name)) {
            if (!this._defs.has(name)) throw new Error(`options: '${name}' is not configured`);
            throw new Error(`options '${name}' have not been validated yet — await master.options.getAsync('${name}') or call master.start() first`);
        }
        return this._values.get(name);
    }
    has(name) { return this._defs.has(name); }
    get names() { return [...this._defs.keys()]; }
    /** All validated values as { name: value } — injected on controllers as this.options. */
    all() { const o = {}; for (const [k, v] of this._values) o[k] = v; return o; }
    /** ValidateOnStart: validate every registered options type; throws an aggregate error. */
    async validateAll() {
        const failures = [];
        for (const name of this._defs.keys()) {
            try { await this.getAsync(name); } catch (err) { failures.push(err.message); }
        }
        if (failures.length) {
            const err = new Error(`Options validation failed at startup:\n${failures.join('\n')}`);
            err.code = 'MC_OPTIONS_INVALID'; err.failures = failures;
            throw err;
        }
        return this.all();
    }
    /** IOptionsMonitor.OnChange: called with the new value after a configuration reload. */
    onChange(name, cb) { if (!this._listeners.has(name)) this._listeners.set(name, new Set()); this._listeners.get(name).add(cb); return () => this._listeners.get(name).delete(cb); }
    _invalidateAll() {
        const names = [...this._values.keys()];
        this._values.clear();
        for (const name of names) {
            const cbs = this._listeners.get(name);
            if (!cbs || !cbs.size) { this.getAsync(name).catch(() => { /* surfaces on next get */ }); continue; }
            this.getAsync(name).then((v) => { for (const cb of cbs) { try { cb(v, name); } catch (_) { /* ignore */ } } }).catch(() => { /* keep previous */ });
        }
    }
}

/** IHostEnvironment */
export function hostEnvironment(name) {
    const env = String(name || process.env.NODE_ENV || 'development');
    return Object.freeze({
        name: env,
        isDevelopment: env === 'development',
        isStaging: env === 'staging',
        isProduction: env === 'production',
        isTest: env === 'test',
        is(n) { return env === n; },
    });
}

export default ConfigurationRoot;
