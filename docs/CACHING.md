# Caching & compression (v2.8.0)

| ASP.NET Core | MasterController |
|---|---|
| `UseResponseCompression()` (gzip / brotli) | `master.useResponseCompression({ threshold: 1024, level: 6, brotli: true, brotliQuality: 4, mimeTypes })` |
| `[OutputCache(Duration = 60, VaryByQueryKeys = …, Tags = …)]` | route `{ outputCache: { duration, varyByQuery: '*' \| ['page'], varyByHeader: ['accept-language'], varyByUser, tags, cacheAuthenticated } }`, controller `static outputCache = { index: {…}, '*': 'Policy' }`, `router.resources('posts', { outputCache })` (index/show) |
| `AddOutputCache(o => o.AddPolicy("Short", …))` | `master.outputCache.addPolicy('Short', { duration: 10 })` → `{ outputCache: 'Short' }` |
| `IOutputCacheStore.EvictByTagAsync` | `await master.outputCache.evictByTag('posts')` |
| `IDistributedCache` / `IMemoryCache` | `master.cache.get / set(key, value, { ttlMs, slidingMs, tags }) / remove / getOrCreate(key, factory, opts) / evictByTag / clear` |
| Redis distributed cache | `master.cache.use(new RedisCacheStore(ioredisClient, { prefix }))` — the output cache uses the same store |

```js
const server = master.setupServer('http');
master.useResponseCompression();                                   // before start(); clients with Accept-Encoding get gzip/br
master.outputCache.addPolicy('Short', { duration: 10, tags: ['catalog'] });

// routes
router.route('/products', 'products#index', 'get', { outputCache: { duration: 60, varyByQuery: ['page', 'sort'], tags: ['products'] } });
router.route('/products/:id(int)', 'products#show', 'get', { outputCache: 'Short' });

// controller-level
export default class ReportsController { static outputCache = { index: { duration: 300 } }; }

// invalidate after writes
await master.outputCache.evictByTag('products');

// app cache
const cats = await master.cache.getOrCreate('categories', () => db.Category.toList(), { ttlMs: 60_000, tags: ['catalog'] });
```

Output-cache semantics (like ASP.NET's defaults): only `GET`/`HEAD`, only `200` responses, not when the request is authenticated (`Authorization` header / `this.user`) unless `cacheAuthenticated: true` or `varyByUser`, not when the response sets cookies or `Cache-Control: no-store|private`, bodies up to `maxBodyBytes` (1 MB). Responses carry `X-Output-Cache: HIT|MISS` and `Age`. Caching runs after authorization and model binding, so a protected route never leaks through the cache. Compression wraps output caching, so hits are compressed per client.

Compression skips: no acceptable encoding, already `Content-Encoding`, `204/304/HEAD`, `Cache-Control: no-transform`, non-compressible content types (text/*, JSON, JS, XML, SVG by default), and bodies below `threshold` when `Content-Length` is known. It sets `Content-Encoding` and `Vary: Accept-Encoding` and streams (no buffering).
