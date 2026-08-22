# Minimal APIs, route groups, named routes & the test client (v2.10.0)

| ASP.NET Core | MasterController |
|---|---|
| `app.MapGet("/ping", () => …)` / `MapPost` | `master.map.get('/ping', function () { this.ok({ pong: true }); })`, `master.map.post(path, handler, options)` (+ `put/patch/delete/any`) |
| endpoint metadata (`RequireAuthorization`, `AllowAnonymous`, `CacheOutput`, `WithName`) | options `{ authorize, allowAnonymous, outputCache, schemas, openapi, name, constraint }` |
| `app.MapGroup("/api/v1").RequireAuthorization()` | `router.group('/api/v1', { authorize: true }, (g) => { g.route(…); g.resources('posts'); g.group('/admin', {…}, …) })` |
| `WithName` + `LinkGenerator.GetPathByName` / `Url.Action` | `{ name: 'item' }` → `master.urlFor('item', { id: 5 }, { query, absolute })`, `this.urlFor(...)` in controllers/handlers |
| `WebApplicationFactory<T>` / `TestServer` + `HttpClient` | `const client = await master.createTestClient({ root, app: 'app' })` → `client.get/post/put/patch/delete(path, { body, query, headers })` → `{ status, ok, headers, text, json() }`; cookie jar, `withBearer(token)`, `withHeaders()`, `close()` |

## Minimal APIs

Handlers run exactly like controller actions — `this` carries `ok/created/noContent/problem/validationProblem/file`, `authorize/signIn/signOut/issueToken`, `user`, `model/modelState` (when `schemas` is set), `logger`, `options/configuration`, `urlFor`; the request object is the first argument; a returned value is sent as JSON.

```js
const server = master.setupServer('http');
master.map.get('/health', () => ({ ok: true }), { allowAnonymous: true, name: 'health' });
master.map.post('/items', async function (obj) {
  const item = await this.db.Item.add(this.model);          // this.model validated from `schemas`
  await this.db.saveChanges();
  this.created(this.urlFor('item', { id: item.id }), item);
}, { authorize: { roles: ['admin'] }, schemas: { body: { name: 'string!', qty: { type: 'integer', min: 1 } } }, openapi: { summary: 'Create item' } });
master.map.get('/items/:id(int)', function (obj) { return this.db.Item.find(obj.params.id); }, { name: 'item', outputCache: { duration: 30 } });
await master.start(server);
```

Minimal routes appear in `/openapi.json` like controller routes (`minimal` tag). They can be registered before or after `startMVC()`.

## Route groups

```js
const router = master.router.start();
router.group('/api/v1', { authorize: true, outputCache: { duration: 10 } }, (g) => {
  g.route('/me', 'account#me', 'get');                               // inherits authorize + outputCache
  g.route('/status', 'status#index', 'get', { allowAnonymous: true }); // override per route
  g.resources('posts', { except: ['destroy'] });                      // /api/v1/posts…
  g.group('/admin', { authorize: { roles: ['admin'] } }, (gg) => gg.route('/stats', 'admin#stats', 'get', { name: 'adminStats' }));
});
master.urlFor('adminStats');   // '/api/v1/admin/stats'
```

## Test client

```js
import { test, after } from 'node:test';
import master from 'mastercontroller';

let client;
after(() => client.close());
test('login then read profile', async () => {
  client = await master.createTestClient({ root: new URL('..', import.meta.url).pathname, app: 'app', environment: 'test',
    configure: (m) => { m.auth.addCookie('cookie', { secret: process.env.TEST_COOKIE_SECRET }); } });
  const login = await client.post('/login', { body: { email: 'a@b.co', password: 'pw' } });   // Set-Cookie captured
  assert.equal(login.status, 200);
  const me = await client.get('/me');                                                        // Cookie sent automatically
  assert.equal(me.json().email, 'a@b.co');
  const admin = client.withBearer(token);                                                    // separate identity, same jar
});
```

`createTestClient` boots `setupServer → startMVC(app) → start → listen(127.0.0.1:0)` once (idempotent on a started app) and returns the client; `app: false` skips controller discovery (pure minimal-API hosts). Responses are read fully; `json()` parses lazily; redirects are not followed (`redirect: 'manual'`) so you can assert `Location`.
