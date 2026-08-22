/**
 * MasterCaching — response compression, output caching and a distributed cache
 * abstraction, modeled on ASP.NET Core:
 *
 *   ASP.NET Core                                  MasterController
 *   UseResponseCompression (gzip/br)              master.useResponseCompression({ threshold, level, brotli, mimeTypes })
 *   [OutputCache(Duration, VaryByQueryKeys, Tags)] route { outputCache: { duration, varyByQuery, varyByHeader, tags } } / static outputCache = { index: {...} }
 *   OutputCachePolicy (named)                     master.outputCache.addPolicy('Short', { duration: 10 })  ->  { outputCache: 'Short' }
 *   IOutputCacheStore.EvictByTagAsync             master.outputCache.evictByTag('posts')
 *   IDistributedCache / IMemoryCache              master.cache.get/set/remove/getOrCreate/evictByTag  (memory by default; RedisCacheStore for Redis)
 */
import zlib from 'node:zlib';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

export class MemoryCacheStore {
    constructor({ maxEntries = 5000 } = {}) {
        this.maxEntries = maxEntries;
        this._map = new Map();          // key -> { value, expiresAt, slidingMs, tags }
        this._tags = new Map();         // tag -> Set(keys)
        this.hits = 0; this.misses = 0;
    }
    async get(key) {
        const e = this._map.get(key);
        if (!e) { this.misses++; return undefined; }
        if (e.expiresAt && Date.now() > e.expiresAt) { this._drop(key); this.misses++; return undefined; }
        if (e.slidingMs) e.expiresAt = Date.now() + e.slidingMs;
        this._map.delete(key); this._map.set(key, e);   // LRU touch
        this.hits++;
        return e.value;
    }
    async set(key, value, { ttlMs, slidingMs, tags } = {}) {
        if (this._map.has(key)) this._drop(key);
        const ttl = slidingMs || ttlMs;
        const e = { value, expiresAt: ttl ? Date.now() + ttl : 0, slidingMs: slidingMs || 0, tags: [].concat(tags || []) };
        this._map.set(key, e);
        for (const t of e.tags) { if (!this._tags.has(t)) this._tags.set(t, new Set()); this._tags.get(t).add(key); }
        while (this._map.size > this.maxEntries) this._drop(this._map.keys().next().value);
    }
    async remove(key) { this._drop(key); }
    async evictByTag(tag) { const keys = this._tags.get(tag); if (!keys) return 0; const n = keys.size; for (const k of [...keys]) this._drop(k); return n; }
    async clear() { this._map.clear(); this._tags.clear(); }
    get size() { return this._map.size; }
    _drop(key) {
        const e = this._map.get(key);
        if (!e) return;
        this._map.delete(key);
        for (const t of e.tags) { const s = this._tags.get(t); if (s) { s.delete(key); if (!s.size) this._tags.delete(t); } }
    }
}

/** Redis-backed store for an ioredis/node-redis-like client (get/set/del/sadd/smembers/expire). */
export class RedisCacheStore {
    constructor(client, { prefix = 'mc:cache:' } = {}) {
        if (!client || typeof client.get !== 'function' || typeof client.set !== 'function') throw new TypeError('RedisCacheStore: a Redis client with get/set/del is required');
        this.client = client; this.prefix = prefix;
    }
    _k(key) { return this.prefix + key; }
    async get(key) { const raw = await this.client.get(this._k(key)); if (raw === null || raw === undefined) return undefined; try { return JSON.parse(raw); } catch (_) { return undefined; } }
    async set(key, value, { ttlMs, slidingMs, tags } = {}) {
        const ttl = slidingMs || ttlMs;
        const payload = JSON.stringify(value);
        if (ttl) await this.client.set(this._k(key), payload, 'PX', Math.max(1, Math.floor(ttl))); else await this.client.set(this._k(key), payload);
        for (const t of [].concat(tags || [])) { await this.client.sadd(this._k('tag:' + t), key); if (ttl && typeof this.client.expire === 'function') await this.client.expire(this._k('tag:' + t), Math.ceil(ttl / 1000) + 60); }
    }
    async remove(key) { await this.client.del(this._k(key)); }
    async evictByTag(tag) {
        const keys = await this.client.smembers(this._k('tag:' + tag));
        for (const k of keys || []) await this.client.del(this._k(k));
        await this.client.del(this._k('tag:' + tag));
        return (keys || []).length;
    }
    async clear() { /* intentionally no FLUSHDB */ }
}

/** IDistributedCache-like facade (master.cache). */
export class DistributedCache {
    constructor(store) { this.store = store || new MemoryCacheStore(); this._inflight = new Map(); }
    use(store) { this.store = store; return this; }
    get(key) { return this.store.get(key); }
    set(key, value, opts) { return this.store.set(key, value, opts); }
    remove(key) { return this.store.remove(key); }
    evictByTag(tag) { return this.store.evictByTag(tag); }
    clear() { return this.store.clear(); }
    /** GetOrCreate with single-flight: concurrent misses share one factory call. */
    async getOrCreate(key, factory, opts = {}) {
        const hit = await this.store.get(key);
        if (hit !== undefined) return hit;
        if (this._inflight.has(key)) return this._inflight.get(key);
        const p = (async () => { try { const v = await factory(); if (v !== undefined) await this.store.set(key, v, opts); return v; } finally { this._inflight.delete(key); } })();
        this._inflight.set(key, p);
        return p;
    }
}

// ---------------------------------------------------------------------------
// Response compression
// ---------------------------------------------------------------------------

const DEFAULT_COMPRESSIBLE = /^(text\/|application\/(json|problem\+json|javascript|xml|x-javascript|ld\+json|manifest\+json|wasm|graphql)|image\/svg\+xml|font\/(ttf|otf)|application\/vnd\.api\+json)/i;

function appendVary(res, value) {
    const cur = res.getHeader('Vary');
    if (!cur) { res.setHeader('Vary', value); return; }
    const list = String(cur).split(',').map(s => s.trim().toLowerCase());
    if (!list.includes(value.toLowerCase())) res.setHeader('Vary', `${cur}, ${value}`);
}

/**
 * Pipeline middleware: transparently gzip/brotli-compress compressible responses
 * when the client accepts it. Skips: no Accept-Encoding match, already encoded,
 * 204/304/HEAD, Cache-Control: no-transform, non-compressible content types,
 * and bodies smaller than `threshold` when Content-Length is known.
 */
export function compressionMiddleware({ threshold = 1024, level = 6, brotli = true, brotliQuality = 4, mimeTypes = DEFAULT_COMPRESSIBLE } = {}) {
    const compressible = (ct) => (mimeTypes instanceof RegExp ? mimeTypes.test(ct) : [].concat(mimeTypes).some(m => String(ct).toLowerCase().startsWith(String(m).toLowerCase())));
    return async function responseCompression(ctx, next) {
        const req = ctx.request, res = ctx.response;
        const accept = String((req && req.headers && req.headers['accept-encoding']) || '');
        const enc = (brotli && /\bbr\b/.test(accept)) ? 'br' : (/\bgzip\b/.test(accept) ? 'gzip' : null);
        if (!enc || !res || res.__mcCompression) { await next(); return; }
        res.__mcCompression = true;
        const origWriteHead = res.writeHead.bind(res), origWrite = res.write.bind(res), origEnd = res.end.bind(res);
        let decided = false, skip = false, stream = null, ended = false;
        const decide = () => {
            if (decided) return; decided = true;
            const ct = String(res.getHeader('content-type') || '');
            const len = res.getHeader('content-length');
            if (res.getHeader('content-encoding') || res.statusCode === 204 || res.statusCode === 304 || (req.method || '').toUpperCase() === 'HEAD'
                || /no-transform/i.test(String(res.getHeader('cache-control') || '')) || !compressible(ct)
                || (len !== undefined && Number(len) < threshold)) { skip = true; return; }
            res.removeHeader('content-length');
            res.setHeader('Content-Encoding', enc);
            appendVary(res, 'Accept-Encoding');
            stream = enc === 'br'
                ? zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality } })
                : zlib.createGzip({ level });
            stream.on('data', (chunk) => { origWrite(chunk); });
            stream.on('end', () => { if (!ended) { ended = true; origEnd(); } });
            stream.on('error', () => { if (!ended) { ended = true; try { origEnd(); } catch (_) { /* ignore */ } } });
        };
        res.writeHead = function (status, reasonOrHeaders, maybeHeaders) {
            const headers = (reasonOrHeaders && typeof reasonOrHeaders === 'object') ? reasonOrHeaders : maybeHeaders;
            res.statusCode = status;
            if (headers) { if (Array.isArray(headers)) { for (let i = 0; i + 1 < headers.length; i += 2) res.setHeader(headers[i], headers[i + 1]); } else { for (const [k, v] of Object.entries(headers)) if (v !== undefined) res.setHeader(k, v); } }
            decide();
            return typeof reasonOrHeaders === 'string' ? origWriteHead(status, reasonOrHeaders) : origWriteHead(status);
        };
        res.write = function (chunk, encoding, cb) {
            if (!decided) decide();
            if (skip || !stream) return origWrite(chunk, encoding, cb);
            if (chunk !== undefined && chunk !== null) stream.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8'));
            if (typeof encoding === 'function') encoding(); else if (typeof cb === 'function') cb();
            return true;
        };
        res.end = function (chunk, encoding, cb) {
            if (!decided) decide();
            if (skip || !stream) return origEnd(chunk, encoding, cb);
            if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') stream.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8'));
            stream.end();
            return res;
        };
        await next();
    };
}

// ---------------------------------------------------------------------------
// Output cache
// ---------------------------------------------------------------------------

export class OutputCache {
    constructor(master, { store } = {}) {
        this.master = master;
        this.store = store || null;                 // falls back to master.cache.store at use time
        this._policies = new Map();
        this.defaultPolicy = { duration: 60, varyByQuery: '*', varyByHeader: [], varyByUser: false, tags: [], cacheAuthenticated: false, methods: ['get', 'head'], maxBodyBytes: 1024 * 1024 };
        this.headerName = 'X-Output-Cache';
        this.enabled = true;
    }
    _store() { return this.store || (this.master && this.master.cache && this.master.cache.store) || (this.store = new MemoryCacheStore()); }
    addPolicy(name, spec) { this._policies.set(name, { ...this.defaultPolicy, ...spec, name }); return this; }
    policy(name) { const p = this._policies.get(name); if (!p) throw new Error(`outputCache: no policy named '${name}'`); return p; }
    /** Route option / controller static -> concrete policy or null. */
    resolvePolicy(routeSpec, Control, action) {
        let spec = routeSpec;
        if (spec === undefined || spec === null) {
            const s = Control && Control.outputCache;
            if (s && typeof s === 'object' && !('duration' in s) && !('varyByQuery' in s) && !('tags' in s)) spec = (action in s) ? s[action] : s['*'];
            else spec = s;
        }
        if (!spec || !this.enabled) return null;
        if (spec === true) return { ...this.defaultPolicy };
        if (typeof spec === 'string') return this.policy(spec);
        if (typeof spec === 'object') return { ...this.defaultPolicy, ...spec };
        return null;
    }
    eligible(requestObject, policy) {
        const method = String(requestObject.type || '').toLowerCase();
        if (!policy.methods.includes(method)) return false;
        const h = (requestObject.request && requestObject.request.headers) || {};
        const authenticated = !!h.authorization || (requestObject.user && requestObject.user.isAuthenticated);
        if (authenticated && !policy.cacheAuthenticated && !policy.varyByUser) return false;
        if (/no-store/i.test(String(h['cache-control'] || ''))) return false;
        return true;
    }
    key(requestObject, policy) {
        const h = (requestObject.request && requestObject.request.headers) || {};
        const query = (requestObject.requrl && requestObject.requrl.query) || {};
        let qpart = '';
        if (policy.varyByQuery === '*') qpart = Object.keys(query).sort().map(k => `${k}=${JSON.stringify(query[k])}`).join('&');
        else if (Array.isArray(policy.varyByQuery)) qpart = policy.varyByQuery.map(k => `${k}=${JSON.stringify(query[k])}`).join('&');
        const hpart = (policy.varyByHeader || []).map(n => `${n}=${h[String(n).toLowerCase()] || ''}`).join('|');
        const upart = policy.varyByUser && requestObject.user ? `u=${requestObject.user.id || ''}` : '';
        const raw = `${String(requestObject.type).toLowerCase()} /${requestObject.pathName || ''}?${qpart}#${hpart}#${upart}`;
        return 'oc:' + crypto.createHash('sha1').update(raw).digest('hex');
    }
    /** Serve a cached response if present. -> true when served. */
    async tryServe(requestObject, policy) {
        if (!this.eligible(requestObject, policy)) return false;
        const hit = await this._store().get(this.key(requestObject, policy));
        if (!hit) return false;
        const res = requestObject.response;
        if (!res || res.headersSent || res._headerSent) return false;
        const age = Math.max(0, Math.floor((Date.now() - (hit.storedAt || Date.now())) / 1000));
        const body = Buffer.from(hit.body, 'base64');
        res.writeHead(hit.status, { ...hit.headers, 'Content-Length': body.length, [this.headerName]: 'HIT', Age: String(age) });
        res.end(String(requestObject.type).toLowerCase() === 'head' ? undefined : body);
        return true;
    }
    /** Intercept the response and store it when it completes as a cacheable 200. */
    capture(requestObject, policy) {
        if (!this.eligible(requestObject, policy)) return;
        const res = requestObject.response;
        if (!res || res.__mcOutputCapture) return;
        res.__mcOutputCapture = true;
        const chunks = []; let size = 0; let tooBig = false;
        const origWriteHead = res.writeHead.bind(res), origWrite = res.write.bind(res), origEnd = res.end.bind(res);
        const key = this.key(requestObject, policy);
        const store = this._store();
        const headerName = this.headerName;
        const record = (chunk, encoding) => {
            if (chunk === undefined || chunk === null || typeof chunk === 'function' || tooBig) return;
            const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
            size += b.length; if (size > policy.maxBodyBytes) { tooBig = true; chunks.length = 0; return; }
            chunks.push(b);
        };
        res.writeHead = function (status, reasonOrHeaders, maybeHeaders) {
            const headers = (reasonOrHeaders && typeof reasonOrHeaders === 'object') ? reasonOrHeaders : maybeHeaders;
            res.statusCode = status;
            if (headers) { if (Array.isArray(headers)) { for (let i = 0; i + 1 < headers.length; i += 2) res.setHeader(headers[i], headers[i + 1]); } else { for (const [k, v] of Object.entries(headers)) if (v !== undefined) res.setHeader(k, v); } }
            if (!res.getHeader(headerName)) res.setHeader(headerName, 'MISS');
            return typeof reasonOrHeaders === 'string' ? origWriteHead(status, reasonOrHeaders) : origWriteHead(status);
        };
        res.write = function (chunk, encoding, cb) { record(chunk, encoding); return origWrite(chunk, encoding, cb); };
        res.end = function (chunk, encoding, cb) {
            record(chunk, encoding);
            const r = origEnd(chunk, encoding, cb);
            try {
                const status = res.statusCode;
                const headers = {};
                for (const [k, v] of Object.entries(res.getHeaders())) { const lk = k.toLowerCase(); if (lk === 'set-cookie' || lk === headerName.toLowerCase() || lk === 'age' || lk === 'date' || lk === 'content-length' || lk === 'content-encoding' || lk === 'transfer-encoding' || lk === 'connection' || lk === 'keep-alive' || lk === 'vary') continue; headers[k] = v; }
                const noStore = /no-store|private/i.test(String(res.getHeader('cache-control') || ''));
                if (status === 200 && !res.getHeader('set-cookie') && !noStore && !tooBig) {
                    const body = Buffer.concat(chunks).toString('base64');
                    store.set(key, { status, headers, body, storedAt: Date.now() }, { ttlMs: (policy.duration || 60) * 1000, tags: policy.tags }).catch(() => { /* cache store failure must not affect the response */ });
                }
            } catch (_) { /* ignore */ }
            return r;
        };
    }
    evictByTag(tag) { return this._store().evictByTag(tag); }
    evict(requestObject, policy) { return this._store().remove(this.key(requestObject, policy || this.defaultPolicy)); }
    clear() { return this._store().clear(); }
}

export default { MemoryCacheStore, RedisCacheStore, DistributedCache, compressionMiddleware, OutputCache };
