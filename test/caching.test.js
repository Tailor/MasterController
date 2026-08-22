/**
 * 2.8.0 — distributed cache (memory / Redis-shaped store), response compression
 * (gzip/brotli), output caching (policies, vary-by, tags, auth bypass) — ASP.NET parity.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MemoryCacheStore, RedisCacheStore, DistributedCache, OutputCache } from '../MasterCaching.js';
import masterSingleton from '../MasterControl.js';

const tick = (ms) => new Promise(r => setTimeout(r, ms));

test('MemoryCacheStore: ttl, sliding, tags, LRU; DistributedCache.getOrCreate single-flight; RedisCacheStore contract', async () => {
    const s = new MemoryCacheStore({ maxEntries: 3 });
    await s.set('a', 1, { ttlMs: 20, tags: ['t1'] }); await s.set('b', 2, { tags: ['t1', 't2'] }); await s.set('c', 3);
    assert.equal(await s.get('a'), 1);
    assert.equal(await s.evictByTag('t2'), 1, 'tag eviction count'); assert.equal(await s.get('b'), undefined);
    await tick(30); assert.equal(await s.get('a'), undefined, 'expired');
    await s.set('d', 4); await s.set('e', 5); await s.set('f', 6);   // LRU eviction beyond 3
    assert.equal(s.size, 3); assert.equal(await s.get('c'), undefined, 'oldest evicted');
    await s.set('sl', 'x', { slidingMs: 300 }); await tick(180); await s.get('sl'); await tick(180); assert.equal(await s.get('sl'), 'x', 'sliding expiration refreshed on read (360ms elapsed, window 300ms)');

    const cache = new DistributedCache();
    let calls = 0;
    const factory = async () => { calls++; await tick(10); return { n: calls }; };
    const [r1, r2] = await Promise.all([cache.getOrCreate('k', factory, { ttlMs: 1000 }), cache.getOrCreate('k', factory)]);
    assert.deepEqual(r1, { n: 1 }); assert.deepEqual(r2, { n: 1 }); assert.equal(calls, 1, 'single-flight');
    assert.deepEqual(await cache.get('k'), { n: 1 });
    await cache.remove('k'); assert.equal(await cache.get('k'), undefined);

    // Redis-shaped client
    const kv = new Map(), sets = new Map();
    const client = {
        async get(k) { return kv.has(k) ? kv.get(k) : null; },
        async set(k, v, px, ttl) { kv.set(k, v); if (px === 'PX') setTimeout(() => kv.delete(k), ttl).unref(); return 'OK'; },
        async del(k) { kv.delete(k); sets.delete(k); return 1; },
        async sadd(k, m) { if (!sets.has(k)) sets.set(k, new Set()); sets.get(k).add(m); },
        async smembers(k) { return [...(sets.get(k) || [])]; },
        async expire() {},
    };
    const rs = new RedisCacheStore(client, { prefix: 'p:' });
    await rs.set('x', { a: 1 }, { ttlMs: 5000, tags: ['g'] });
    assert.deepEqual(await rs.get('x'), { a: 1 }); assert.ok(kv.has('p:x'));
    assert.equal(await rs.evictByTag('g'), 1); assert.equal(await rs.get('x'), undefined);
    assert.throws(() => new RedisCacheStore({}), /Redis client/);
});

test('OutputCache policy resolution and keys', () => {
    const oc = new OutputCache(null, { store: new MemoryCacheStore() });
    oc.addPolicy('Short', { duration: 5, tags: ['s'] });
    assert.equal(oc.resolvePolicy(undefined, class {}, 'index'), null);
    assert.equal(oc.resolvePolicy(true, class {}, 'x').duration, 60);
    assert.equal(oc.resolvePolicy('Short').tags[0], 's');
    class C { static outputCache = { index: { duration: 9 }, '*': 'Short' }; }
    assert.equal(oc.resolvePolicy(undefined, C, 'index').duration, 9);
    assert.equal(oc.resolvePolicy(undefined, C, 'show').duration, 5);
    class D { static outputCache = { duration: 3 }; }
    assert.equal(oc.resolvePolicy(undefined, D, 'anything').duration, 3);
    const ro = (q, headers = {}) => ({ type: 'get', pathName: 'items', requrl: { query: q }, request: { headers } });
    const p = oc.resolvePolicy(true);
    assert.equal(oc.key(ro({ a: 1, b: 2 }), p), oc.key(ro({ b: 2, a: 1 }), p), 'query order does not matter');
    assert.notEqual(oc.key(ro({ a: 1 }), p), oc.key(ro({ a: 2 }), p));
    const pv = { ...p, varyByQuery: ['page'] };
    assert.equal(oc.key(ro({ page: 1, x: 1 }), pv), oc.key(ro({ page: 1, x: 2 }), pv), 'only listed query keys vary');
    assert.equal(oc.eligible(ro({}, { authorization: 'Bearer t' }), p), false, 'authenticated requests bypass by default');
    assert.equal(oc.eligible({ ...ro({}), type: 'post' }, p), false);
});

let server;
after(() => new Promise((r) => (server ? server.close(() => r()) : r())));

test('e2e: response compression (gzip/br, Vary, skips small/non-compressible/no-transform) and output cache (HIT/MISS, vary, tags eviction, auth bypass, POST not cached)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cache-app-'));
    const app = path.join(root, 'app'); fs.mkdirSync(path.join(app, 'controllers'), { recursive: true });
    const masterUrl = pathToFileURL(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'MasterControl.js')).href;
    fs.writeFileSync(path.join(app, 'routes.js'), `
import master from ${JSON.stringify(masterUrl)};
const r = master.router.start();
r.route('/big', 'data#big', 'get');
r.route('/small', 'data#small', 'get');
r.route('/png', 'data#png', 'get');
r.route('/notransform', 'data#notransform', 'get');
r.route('/cached', 'data#cached', 'get', { outputCache: { duration: 30, varyByQuery: ['q'], tags: ['items'] } });
r.route('/cached', 'data#cachedPost', 'post', { outputCache: { duration: 30 } });
r.route('/ctrl', 'cached#index', 'get');
r.route('/named', 'data#named', 'get', { outputCache: 'Short' });
r.resources('items', { outputCache: { duration: 30, tags: ['items'] }, only: ['index'] });
`);
    fs.writeFileSync(path.join(app, 'controllers', 'dataController.js'), `
let hits = 0;
export default class DataController {
  constructor(r) { this.r = r; }
  big() { this.ok({ data: 'x'.repeat(5000) }); }
  small() { this.ok({ a: 1 }); }
  png() { const res = this.r.response; res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': 5000 }); res.end(Buffer.alloc(5000)); }
  notransform() { const res = this.r.response; res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-transform' }); res.end(JSON.stringify({ d: 'y'.repeat(5000) })); }
  cached() { hits++; this.ok({ hits, q: this.r.params.query && this.r.params.query.q }); }
  cachedPost() { hits++; this.ok({ hits }); }
  named() { hits++; this.ok({ hits }); }
}`);
    fs.writeFileSync(path.join(app, 'controllers', 'cachedController.js'), `
let n = 0;
export default class CachedController { static outputCache = { index: { duration: 30 } }; constructor(r) { this.r = r; } index() { n++; this.ok({ n }); } }`);
    fs.writeFileSync(path.join(app, 'controllers', 'itemsController.js'), `
let n = 0;
export default class ItemsController { constructor(r) { this.r = r; } index() { n++; this.ok({ n }); } }`);

    const master = masterSingleton;
    master.root = root; master.environmentType = 'development';
    process.env.MC_DISABLE_DEFAULT_LOG_PROVIDER = '1';
    server = master.setupServer('http');
    master.useResponseCompression({ threshold: 1024 });
    master.outputCache.addPolicy('Short', { duration: 30 });
    await master.startMVC('app'); await master.start(server);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const port = server.address().port;
    const raw = (p, headers = {}, method = 'GET') => fetch(base + p, { method, headers });
    // fetch transparently decompresses — use node:http for the raw bytes
    const rawHttp = (p, headers = {}) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); }).on('error', reject);
    });

    // compression: gzip / br / skips
    let r = await rawHttp('/big', { 'accept-encoding': 'gzip' });
    assert.equal(r.headers['content-encoding'], 'gzip'); assert.match(r.headers.vary || '', /Accept-Encoding/i);
    assert.ok(r.body.length < 5000, `actually compressed (${r.body.length} bytes)`); assert.equal(JSON.parse(zlib.gunzipSync(r.body).toString()).data.length, 5000);
    r = await rawHttp('/big', { 'accept-encoding': 'br' }); assert.equal(r.headers['content-encoding'], 'br');
    assert.equal(JSON.parse(zlib.brotliDecompressSync(r.body).toString()).data.length, 5000);
    r = await rawHttp('/big', { 'accept-encoding': 'identity' }); assert.equal(r.headers['content-encoding'], undefined);
    r = await rawHttp('/small', { 'accept-encoding': 'gzip' }); assert.equal(r.headers['content-encoding'], undefined, 'below threshold (Content-Length known)');
    r = await rawHttp('/png', { 'accept-encoding': 'gzip' }); assert.equal(r.headers['content-encoding'], undefined, 'non-compressible type');
    r = await rawHttp('/notransform', { 'accept-encoding': 'gzip' }); assert.equal(r.headers['content-encoding'], undefined, 'Cache-Control: no-transform');

    // output cache: MISS then HIT, vary by q, POST not cached, tags eviction, auth bypass
    const j = async (p, h = {}, method) => { const res = await raw(p, { 'accept-encoding': 'identity', ...h }, method); return { status: res.status, oc: res.headers.get('x-output-cache'), body: await res.json() }; };
    let a = await j('/cached?q=1'); assert.equal(a.oc, 'MISS'); assert.equal(a.body.hits, 1);
    a = await j('/cached?q=1'); assert.equal(a.oc, 'HIT'); assert.equal(a.body.hits, 1, 'served from cache');
    a = await j('/cached?q=2'); assert.equal(a.oc, 'MISS'); assert.equal(a.body.hits, 2, 'varies by q');
    a = await j('/cached?q=1&other=9'); assert.equal(a.oc, 'HIT', 'unlisted query key does not vary');
    a = await j('/cached', {}, 'POST'); assert.equal(a.oc, null); assert.equal(a.body.hits, 3, 'POST never cached');
    a = await j('/cached?q=1', { authorization: 'Bearer x' }); assert.equal(a.oc, null); assert.equal(a.body.hits, 4, 'authenticated bypasses the cache');
    a = await j('/named'); a = await j('/named'); assert.equal(a.oc, 'HIT', 'named policy');
    a = await j('/ctrl'); a = await j('/ctrl'); assert.equal(a.oc, 'HIT'); assert.equal(a.body.n, 1, 'controller static outputCache');
    a = await j('/items'); a = await j('/items'); assert.equal(a.oc, 'HIT', 'resources({ outputCache })');
    assert.ok(await master.outputCache.evictByTag('items') >= 1);
    a = await j('/cached?q=1'); assert.equal(a.oc, 'MISS', 'evicted by tag'); assert.equal(a.body.hits, 6, 'action ran again (named() shares the counter: 5th hit)');
    a = await j('/items'); assert.equal(a.oc, 'MISS');
    // cached response still compresses for gzip clients
    r = await rawHttp('/cached?q=1', { 'accept-encoding': 'gzip' }); assert.equal(r.headers['content-encoding'], undefined, 'tiny JSON stays below the threshold');
    r = await rawHttp('/big', { 'accept-encoding': 'gzip' }); assert.equal(r.headers['content-encoding'], 'gzip');
});
