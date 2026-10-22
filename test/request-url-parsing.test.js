/**
 * 2.12.0 — request URLs are parsed without `url.parse()`.
 *
 * Node 24+ emits DEP0169 for `url.parse()`. `parseRequestUrl` replaces it and must
 * give the router and `ctx.requrl` exactly what `url.parse(req.url, true)` did.
 * The expected values below were captured from `url.parse` on Node 24.22.1.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequestUrl } from '../MasterRequest.js';
import masterSingleton from '../MasterControl.js';

const plain = (o) => JSON.parse(JSON.stringify(o));

test('parseRequestUrl matches url.parse(req.url, true) for request targets', () => {
    const cases = [
        ['/', '/', '', {}],
        ['/users/', '/users/', '', {}],
        ['/Users/42?x=1&x=2&y=', '/Users/42', '?x=1&x=2&y=', { x: ['1', '2'], y: '' }],
        ["/users/o'brien?q=a+b%20c", "/users/o'brien", '?q=a+b%20c', { q: 'a b c' }],
        // no dot-segment resolution: the router sees what was sent
        ['/a/../b', '/a/../b', '', {}],
        ['/%2e%2e/x', '/%2e%2e/x', '', {}],
        // a protocol-relative target stays a path (WHATWG URL would make evil.com the host)
        ['//evil.com/x?y=1', '//evil.com/x', '?y=1', { y: '1' }],
        // backslashes before the query become slashes, as url.parse did
        ['/a\\b?c\\d', '/a/b', '?c\\d', { 'c\\d': '' }],
        ['/a?b?c', '/a', '?b?c', { 'b?c': '' }],
        ['/a?x=1#frag', '/a', '?x=1', { x: '1' }],
        ['/a?arr[]=1&arr[]=2', '/a', '?arr[]=1&arr[]=2', { 'arr[]': ['1', '2'] }],
        ['/api/customer.list', '/api/customer.list', '', {}],
        ['/a?', '/a', '?', {}],
        ['*', '*', '', {}],
        // absolute-form target (proxy request)
        ['http://example.com/p/q?z=9', '/p/q', '?z=9', { z: '9' }],
    ];
    for (const [input, pathname, search, query] of cases) {
        const u = parseRequestUrl(input);
        assert.equal(u.pathname, pathname, `pathname of ${input}`);
        assert.equal(u.search, search, `search of ${input}`);
        assert.deepEqual(plain(u.query), query, `query of ${input}`);
        assert.equal(u.path, pathname + search, `path of ${input}`);
    }
});

test('parsed query is a null-prototype object (no __proto__ pollution)', () => {
    const u = parseRequestUrl('/a?__proto__=1&constructor=2');
    assert.equal(Object.getPrototypeOf(u.query), null);
    assert.equal(u.query.__proto__, '1');
    assert.equal(u.query.constructor, '2');
    assert.equal({}.constructor, Object, 'Object.prototype untouched');
});

let client;
after(() => client && client.close());

test('e2e: routing and query binding work, and no DEP0169 warning is emitted', async () => {
    const warnings = [];
    const onWarning = (w) => warnings.push(w);
    process.on('warning', onWarning);

    process.env.MC_DISABLE_DEFAULT_LOG_PROVIDER = '1';
    masterSingleton.environmentType = 'development';
    client = await masterSingleton.createTestClient({
        app: false,
        configure: (m) => {
            m.map.get('/items/:id(int)', function (obj) {
                return { id: obj.params.id, query: plain(obj.params.query || this.requestObject.requrl.query) };
            }, { allowAnonymous: true });
        },
    });

    const r = await client.get('/items/7?tag=a&tag=b&q=x+y');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), { id: 7, query: { tag: ['a', 'b'], q: 'x y' } });

    await new Promise((resolve) => setImmediate(resolve));
    process.off('warning', onWarning);
    assert.deepEqual(warnings.filter((w) => w.code === 'DEP0169').map((w) => w.message), []);
});
