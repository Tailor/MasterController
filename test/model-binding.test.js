/**
 * 2.4.0 — model binding, validation, ProblemDetails, typed results, typed route
 * constraints (ASP.NET Core [ApiController] / DataAnnotations / ControllerBase parity).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validate, bindRequest, ModelState, writeProblem, wantsJson, resolveControllerSchemas } from '../security/MasterModelBinding.js';
import masterSingleton from '../MasterControl.js';

test('validate(): types, coercion, required/default, nested objects, arrays, enum, custom (async), unknown fields stripped', async () => {
    const schema = {
        title: { type: 'string', required: true, minLength: 2, maxLength: 10 },
        price: { type: 'number', min: 0 },
        qty: 'integer!',
        active: { type: 'boolean', default: true },
        email: { type: 'email' },
        when: { type: 'date' },
        tags: { type: 'array', items: 'string', maxLength: 3 },
        status: { enum: ['draft', 'live'] },
        address: { type: 'object', properties: { city: { type: 'string', required: true }, zip: { type: 'string', pattern: /^\d{5}$/ } } },
        sku: { type: 'string', custom: async (v) => (v.startsWith('X') ? null : 'sku must start with X') },
    };
    const good = await validate({ title: ' Hello ', price: '9.5', qty: '3', email: 'A@B.CO', when: '2026-01-02', tags: 'a,b', status: 'live', address: { city: 'Oslo', zip: '12345', extra: 1 }, sku: 'X1', junk: 1 }, schema);
    assert.equal(good.valid, true, JSON.stringify(good.errors));
    assert.deepEqual(good.value, { title: 'Hello', price: 9.5, qty: 3, active: true, email: 'a@b.co', when: new Date('2026-01-02'), tags: ['a', 'b'], status: 'live', address: { city: 'Oslo', zip: '12345' }, sku: 'X1' });
    assert.ok(!('junk' in good.value), 'unknown fields stripped (strong-params semantics)');

    const bad = await validate({ title: 'H', price: -1, qty: '2.5', email: 'nope', when: 'not a date', tags: ['a', 'b', 'c', 'd'], status: 'gone', address: { zip: 'abc' }, sku: 'Y' }, schema);
    assert.equal(bad.valid, false);
    assert.deepEqual(Object.keys(bad.errors).sort(), ['address.city', 'address.zip', 'email', 'price', 'qty', 'sku', 'status', 'tags', 'title', 'when']);
    assert.match(bad.errors.title[0], /at least 2/); assert.match(bad.errors.qty[0], /integer/); assert.match(bad.errors['address.city'][0], /required/);
    assert.equal(bad.errors.sku[0], 'sku must start with X');

    // JSON-schema-ish form + required list; allowUnknown keeps extras
    const js = await validate({ a: 1, b: 'x' }, { type: 'object', properties: { a: { type: 'integer' }, c: { type: 'string' } }, required: ['c'], additionalProperties: true });
    assert.equal(js.valid, false); assert.match(js.errors.c[0], /required/); assert.equal(js.value.b, 'x');
    await assert.rejects(() => validate({}, { x: { type: 'nope' } }), /unknown type/);
});

test('bindRequest(): per-source binding (route/query/body), shorthand by method, ModelState', async () => {
    const ro = (type, params, headers = {}) => ({ type, params, request: { headers, method: type.toUpperCase(), url: '/x' } });
    const spec = { route: { id: 'integer!' }, query: { page: { type: 'integer', default: 1 }, q: 'string' }, body: { name: 'string!', age: { type: 'integer', min: 0 } } };
    const r = await bindRequest(ro('post', { id: '7', query: { page: '3' }, formData: { name: 'ann', age: '40', hack: 'x' } }), spec);
    assert.equal(r.valid, true);
    assert.deepEqual(r.value, { id: 7, page: 3, name: 'ann', age: 40 });
    assert.deepEqual(r.sources.body, { name: 'ann', age: 40 });
    assert.ok(r.modelState instanceof ModelState && r.modelState.isValid);

    const bad = await bindRequest(ro('post', { id: 'x', query: {}, formData: { age: -1 } }), spec);
    assert.equal(bad.valid, false);
    assert.deepEqual(Object.keys(bad.errors).sort(), ['age', 'id', 'name']);
    bad.modelState.addError('name', 'taken'); assert.deepEqual(bad.modelState.getErrors('name').slice(-1), ['taken']);

    // shorthand: bare schema = body for POST, query for GET; multipart fields
    const s1 = await bindRequest(ro('get', { query: { page: '2' } }), { page: 'integer' });
    assert.deepEqual(s1.value, { page: 2 });
    const s2 = await bindRequest(ro('post', { formData: { fields: { name: 'up' }, files: {} } }), { name: 'string!' });
    assert.deepEqual(s2.value, { name: 'up' });
    assert.equal(resolveControllerSchemas({ schemas: { create: { a: 1 }, '*': { b: 1 } } }, 'create').a, 1);
    assert.equal(resolveControllerSchemas({ schemas: { '*': { b: 1 } } }, 'other').b, 1);
    assert.equal(resolveControllerSchemas({}, 'x'), undefined);
});

test('writeProblem / wantsJson', () => {
    const res = { headersSent: false, writeHead(c, h) { this.c = c; this.h = h; }, end(b) { this.b = b; } };
    writeProblem(res, { status: 409, detail: 'dup', traceId: 't1' }, { request: { url: '/things/1?x=1' } });
    assert.equal(res.c, 409); assert.equal(res.h['Content-Type'], 'application/problem+json');
    assert.deepEqual(JSON.parse(res.b), { type: 'https://tools.ietf.org/html/rfc9110#section-15.5.10', title: 'Conflict', status: 409, detail: 'dup', instance: '/things/1', traceId: 't1' });
    assert.equal(wantsJson({ headers: { accept: 'application/json' } }), true);
    assert.equal(wantsJson({ headers: { accept: 'text/html,application/json' } }), false);
    assert.equal(wantsJson({ headers: { accept: '*/*', authorization: 'Bearer x' } }), true);
    assert.equal(wantsJson({ headers: {} }), false);
});

let server;
after(() => new Promise((r) => (server ? server.close(() => r()) : r())));

test('e2e: typed route constraints, static schemas -> this.model / 400 ValidationProblemDetails, typed results, file(), problem+json for thrown errors', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bind-app-'));
    const app = path.join(root, 'app');
    fs.mkdirSync(path.join(app, 'controllers'), { recursive: true });
    fs.writeFileSync(path.join(root, 'report.txt'), 'quarterly numbers');
    const masterUrl = pathToFileURL(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'MasterControl.js')).href;
    fs.writeFileSync(path.join(app, 'routes.js'), `
import master from ${JSON.stringify(masterUrl)};
const router = master.router.start();
router.route('/items/:id(int)', 'items#show', 'get');
router.route('/items/:slug(slug)', 'items#bySlug', 'get');
router.route('/codes/:code(regex:^[A-Z]{3}$)', 'items#code', 'get');
router.route('/items', 'items#create', 'post');
router.route('/items/:id(int)', 'items#destroy', 'delete');
router.route('/items', 'items#index', 'get');
router.route('/manual', 'items#manual', 'post');
router.route('/report', 'items#report', 'get');
router.route('/boom', 'items#boom', 'get');
router.route('/inline', 'items#inline', 'post');
`);
    fs.writeFileSync(path.join(app, 'controllers', 'itemsController.js'), `
export default class ItemsController {
  static schemas = {
    create: { body: { name: { type: 'string', required: true, minLength: 2 }, price: { type: 'number', min: 0 }, tags: { type: 'array', items: 'string' } } },
    index: { query: { page: { type: 'integer', default: 1, min: 1 }, tags: { type: 'array' } } },
    manual: { body: { name: 'string!' } },
  };
  constructor(requestObject) { this.requestObject = requestObject; }
  show(obj) { this.ok({ id: obj.params.id, type: typeof obj.params.id }); }
  bySlug(obj) { this.ok({ slug: obj.params.slug }); }
  code(obj) { this.ok({ code: obj.params.code }); }
  create() { this.created('/items/1', { model: this.model, valid: this.modelState.isValid }); }
  index() { this.ok(this.model); }
  destroy() { this.noContent(); }
  report() { this.file(${JSON.stringify(path.join(root, 'report.txt'))}, { fileName: 'report.txt', contentType: 'text/plain' }); }
  boom() { throw new Error('kaboom'); }
  async inline() { const m = await this.bind({ body: { n: 'integer!' } }); if (!m) return; this.ok({ n: m.n }); }
}
`);
    fs.writeFileSync(path.join(app, 'controllers', 'manualController.js'), 'export default class M {}');
    // autoValidate=false controller handles modelState itself
    fs.writeFileSync(path.join(app, 'controllers', 'itemsController.js'), fs.readFileSync(path.join(app, 'controllers', 'itemsController.js'), 'utf8').replace('  static schemas = {', '  static autoValidate = true;\n  static schemas = {'));
    fs.writeFileSync(path.join(app, 'controllers', 'manualController.js'), `
export default class ManualController {
  static autoValidate = false;
  static schemas = { create: { body: { name: 'string!' } } };
  constructor(r) { this.r = r; }
  create() { if (!this.modelState.isValid) return this.unprocessable(this.modelState.errors); this.ok(this.model); }
}
`);
    fs.writeFileSync(path.join(app, 'routes.js'), fs.readFileSync(path.join(app, 'routes.js'), 'utf8').replace("router.route('/manual', 'items#manual', 'post');", "router.route('/manual', 'manual#create', 'post');"));

    const master = masterSingleton;
    master.root = root;
    master.environmentType = 'development';
    server = master.setupServer('http');
    await master.startMVC('app');
    await master.start(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const j = (p, init = {}) => fetch(base + p, { ...init, headers: { 'content-type': 'application/json', accept: 'application/json', ...(init.headers || {}) } });

    // typed constraints
    let r = await j('/items/42'); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { id: 42, type: 'number' });
    r = await j('/items/my-thing'); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { slug: 'my-thing' });
    r = await j('/codes/ABC'); assert.deepEqual(await r.json(), { code: 'ABC' });
    r = await j('/codes/abcd'); assert.equal(r.status, 404, 'regex constraint miss -> not found (problem+json for API clients)');
    assert.equal(r.headers.get('content-type'), 'application/problem+json');
    assert.equal((await r.json()).status, 404);

    // schemas: invalid -> 400 ValidationProblemDetails
    r = await j('/items', { method: 'POST', body: JSON.stringify({ name: 'x', price: -2 }) });
    assert.equal(r.status, 400);
    const vp = await r.json();
    assert.equal(vp.title, 'One or more validation errors occurred.');
    assert.deepEqual(Object.keys(vp.errors).sort(), ['name', 'price']);
    // valid -> bound + coerced model, 201 + Location
    r = await j('/items', { method: 'POST', body: JSON.stringify({ name: 'widget', price: '9.99', tags: 'a,b', evil: 'x' }) });
    assert.equal(r.status, 201); assert.equal(r.headers.get('location'), '/items/1');
    assert.deepEqual(await r.json(), { model: { name: 'widget', price: 9.99, tags: ['a', 'b'] }, valid: true });
    // query binding with defaults
    r = await j('/items?tags=x,y'); assert.deepEqual(await r.json(), { page: 1, tags: ['x', 'y'] });
    r = await j('/items?page=0'); assert.equal(r.status, 400);
    // manual modelState handling -> 422
    r = await j('/manual', { method: 'POST', body: JSON.stringify({}) }); assert.equal(r.status, 422);
    assert.match((await r.json()).errors.name[0], /required/);
    // explicit this.bind()
    r = await j('/inline', { method: 'POST', body: JSON.stringify({ n: '5' }) }); assert.deepEqual(await r.json(), { n: 5 });
    r = await j('/inline', { method: 'POST', body: JSON.stringify({ n: 'no' }) }); assert.equal(r.status, 400);
    // typed results
    r = await j('/items/9', { method: 'DELETE' }); assert.equal(r.status, 204);
    r = await fetch(base + '/report'); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'text/plain'); assert.match(r.headers.get('content-disposition'), /attachment; filename="report.txt"/); assert.equal(await r.text(), 'quarterly numbers');
    // thrown error -> problem+json for API clients, HTML for browsers
    r = await j('/boom'); assert.equal(r.status, 500); assert.equal(r.headers.get('content-type'), 'application/problem+json');
    const prob = await r.json(); assert.equal(prob.title, 'Internal Server Error'); assert.equal(prob.instance, '/boom');
    r = await fetch(base + '/boom', { headers: { accept: 'text/html' } }); assert.equal(r.status, 500); assert.match(r.headers.get('content-type'), /text\/html/);
});
