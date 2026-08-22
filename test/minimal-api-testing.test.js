/**
 * 2.10.0 — minimal APIs (MapGet/MapPost), route groups (MapGroup), named routes +
 * urlFor (LinkGenerator), and the WebApplicationFactory-style test client.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import masterSingleton from '../MasterControl.js';
import { TestClient } from '../MasterTesting.js';

let client;
after(() => client && client.close());

test('minimal APIs + groups + named routes + test client (cookie jar, bearer, json)', async () => {
    const master = masterSingleton;
    process.env.MC_DISABLE_DEFAULT_LOG_PROVIDER = '1';
    master.environmentType = 'development';
    client = await master.createTestClient({
        app: false,
        configure: (m) => {
            m.auth.addJwtBearer('bearer', { secret: 'a-very-long-test-secret-at-least-32-chars!!' });
            m.auth.addCookie('cookie', { secret: 'another-very-long-secret-at-least-32-chars!!', mode: 'api' });
            m.auth.setDefaultScheme('cookie');
            // minimal APIs — handlers run as controller actions (this.ok/authorize/signIn/user/model/logger…)
            m.map.get('/ping', function () { this.ok({ pong: true, rid: !!this.requestObject.requestId }); }, { allowAnonymous: true });
            m.map.get('/echo/:id(int)', function (obj) { return { id: obj.params.id, type: typeof obj.params.id }; }, { name: 'echo', allowAnonymous: true });
            m.map.post('/login', async function () { await this.signIn({ sub: 'u1', name: 'ann', roles: ['admin'] }, { scheme: 'cookie' }); this.ok({ ok: true }); }, { allowAnonymous: true });
            m.map.get('/me', function () { this.ok({ name: this.user.name, roles: this.user.roles, via: this.user.authenticationType }); }, { authorize: true });
            m.map.post('/items', function () { this.created(this.urlFor('echo', { id: 9 }), { model: this.model }); }, { authorize: { roles: ['admin'] }, schemas: { body: { name: 'string!', qty: { type: 'integer', min: 1 } } }, name: 'createItem' });
            m.map.get('/cached', (() => { let n = 0; return function () { n++; this.ok({ n }); }; })(), { allowAnonymous: true, outputCache: { duration: 30 } });
            m.map.get('/token', function () { this.ok({ token: this.issueToken({ sub: 'u2', name: 'bob', roles: ['user'] }, { scheme: 'bearer' }) }); }, { allowAnonymous: true });
            m.map.get('/bearer-only', function () { this.ok({ name: this.user.name }); }, { authorize: { schemes: ['bearer'] } });
            // route group with defaults; nested group
            const r = m.router.start();
            r.group('/api/v1', { authorize: true }, (g) => {
                g.route('/whoami', 'minimal#m4', 'get');                        // inherits authorize
                g.route('/open', 'minimal#m1', 'get', { allowAnonymous: true });  // override
                g.group('/admin', { authorize: { roles: ['admin'] } }, (gg) => { gg.route('/stats', 'minimal#m4', 'get', { name: 'adminStats' }); });
            });
        },
    });
    assert.ok(client instanceof TestClient);

    // anonymous
    let r = await client.get('/ping'); assert.equal(r.status, 200); assert.deepEqual(r.json(), { pong: true, rid: true });
    r = await client.get('/echo/42'); assert.deepEqual(r.json(), { id: 42, type: 'number' }, 'typed constraint + returned value auto-JSON');
    r = await client.get('/me'); assert.equal(r.status, 401); assert.equal(r.header('content-type'), 'application/problem+json');
    r = await client.get('/api/v1/whoami'); assert.equal(r.status, 401, 'group default authorize');
    r = await client.get('/api/v1/open'); assert.equal(r.status, 200, 'group override allowAnonymous');
    r = await client.get('/cached'); r = await client.get('/cached'); assert.equal(r.header('x-output-cache'), 'HIT', 'minimal API outputCache option'); assert.equal(r.json().n, 1);

    // cookie sign-in through the jar
    r = await client.post('/login'); assert.equal(r.status, 200); assert.ok(client.cookies.mc_auth, 'cookie captured into the jar');
    r = await client.get('/me'); assert.equal(r.status, 200); assert.deepEqual(r.json(), { name: 'ann', roles: ['admin'], via: 'cookie' });
    r = await client.get('/api/v1/whoami'); assert.equal(r.status, 200);
    r = await client.get('/api/v1/admin/stats'); assert.equal(r.status, 200, 'nested group role requirement satisfied');
    r = await client.post('/items', { body: { name: 'w', qty: 0 } }); assert.equal(r.status, 400, 'minimal API schemas -> validation problem');
    assert.deepEqual(Object.keys(r.json().errors), ['qty']);
    r = await client.post('/items', { body: { name: 'w', qty: 2, extra: 1 } }); assert.equal(r.status, 201);
    assert.equal(r.header('location'), '/echo/9', 'this.urlFor inside a minimal handler'); assert.deepEqual(r.json(), { model: { name: 'w', qty: 2 } });
    r = await client.get('/cached'); assert.equal(r.header('x-output-cache'), null, 'authenticated (cookie) requests bypass the output cache');

    // bearer via withBearer (separate scheme), cookie jar shared
    const { token } = (await client.get('/token')).json();
    const asBob = client.withBearer(token);
    r = await asBob.get('/bearer-only'); assert.equal(r.status, 200); assert.deepEqual(r.json(), { name: 'bob' });
    r = await client.get('/bearer-only'); assert.equal(r.status, 401, 'cookie user does not satisfy schemes: [bearer]');

    // named routes / urlFor
    assert.equal(master.urlFor('echo', { id: 7 }, { query: { tab: 'x y' } }), '/echo/7?tab=x%20y');
    assert.equal(master.urlFor('adminStats'), '/api/v1/admin/stats');
    assert.equal(master.urlFor('createItem', {}, { absolute: 'https://api.example.com/' }), 'https://api.example.com/items');
    assert.throws(() => master.urlFor('nope'), /no route named 'nope'/);
    assert.throws(() => master.urlFor('echo'), /missing route parameter 'id'/);
    assert.throws(() => master.map.get('/x', 'not a fn'), /handler must be a function/);

    // logout -> jar drops the cookie
    master.map.post('/logout', async function () { await this.signOut({ scheme: 'cookie' }); this.ok({}); }, { allowAnonymous: true });
    r = await client.post('/logout'); assert.equal(r.status, 200); assert.equal(client.cookies.mc_auth, undefined, 'expired cookie removed from the jar');
    r = await client.get('/me'); assert.equal(r.status, 401);
});
