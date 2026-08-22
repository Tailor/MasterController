/**
 * 2.9.0 — OpenAPI document generated from routes / typed constraints / static schemas /
 * authorize / auth schemes; served at /openapi.json (+ optional UI).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ruleToJsonSchema, schemaToJsonSchema, routePathToOpenApi, swaggerUiHtml } from '../MasterOpenApi.js';
import masterSingleton from '../MasterControl.js';

test('rule -> JSON Schema, schema -> object schema, route path -> OpenAPI path + params', () => {
    assert.deepEqual(ruleToJsonSchema({ type: 'string', minLength: 2, maxLength: 5, pattern: /^a/ }), { type: 'string', minLength: 2, maxLength: 5, pattern: '^a' });
    assert.deepEqual(ruleToJsonSchema('integer!'), { type: 'integer' });
    assert.deepEqual(ruleToJsonSchema({ type: 'email' }), { type: 'string', format: 'email' });
    assert.deepEqual(ruleToJsonSchema({ type: 'array', items: 'uuid', maxLength: 3 }), { type: 'array', items: { type: 'string', format: 'uuid' }, maxItems: 3 });
    assert.deepEqual(ruleToJsonSchema({ enum: ['a', 'b'], default: 'a' }), { enum: ['a', 'b'], default: 'a' });
    const js = schemaToJsonSchema({ name: 'string!', age: { type: 'integer', min: 0 }, addr: { type: 'object', properties: { city: 'string!' } } });
    assert.deepEqual(js, { type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer', minimum: 0 }, addr: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }, required: ['name'] });
    assert.deepEqual(routePathToOpenApi('items/:id(int)/tags/:tag(slug)'), { path: '/items/{id}/tags/{tag}', params: [{ name: 'id', schema: { type: 'integer' } }, { name: 'tag', schema: { type: 'string', pattern: '^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$' } }] });
    assert.deepEqual(routePathToOpenApi('codes/:code(regex:^[A-Z]{3}$)').params[0].schema, { type: 'string', pattern: '^[A-Z]{3}$' });
    assert.match(swaggerUiHtml('/openapi.json', { title: '<x>' }), /&lt;x&gt;/);
});

let server;
after(() => new Promise((r) => (server ? server.close(() => r()) : r())));

test('e2e: /openapi.json reflects routes, params, request bodies, query params, security, problem responses; UI served', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-openapi-app-'));
    const app = path.join(root, 'app'); fs.mkdirSync(path.join(app, 'controllers'), { recursive: true });
    const masterUrl = pathToFileURL(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'MasterControl.js')).href;
    fs.writeFileSync(path.join(app, 'routes.js'), `
import master from ${JSON.stringify(masterUrl)};
const r = master.router.start();
r.route('/items', 'items#index', 'get', { allowAnonymous: true });
r.route('/items/:id(int)', 'items#show', 'get');
r.route('/items', 'items#create', 'post', { authorize: { roles: ['admin'] }, outputCache: { duration: 5 } });
r.route('/secret', 'items#secret', 'get', { authorize: 'Senior' });
r.resources('tags', { only: ['index', 'show'] });
`);
    fs.writeFileSync(path.join(app, 'controllers', 'itemsController.js'), `
export default class ItemsController {
  static authorize = { '*': true, show: false };
  static schemas = {
    create: { body: { name: 'string!', price: { type: 'number', min: 0 }, tags: { type: 'array', items: 'string' } }, query: { dryRun: { type: 'boolean', default: false } } },
    index: { query: { page: { type: 'integer', default: 1, min: 1 }, q: 'string' } },
  };
  static openapi = { index: { summary: 'List items', tags: ['Items'], responses: { 200: 'A page of items' } }, create: { deprecated: true } };
  constructor(r) { this.r = r; }
  index() { this.ok([]); } show() { this.ok({}); } create() { this.created('/items/1', {}); } secret() { this.ok({}); }
}`);
    fs.writeFileSync(path.join(app, 'controllers', 'tagsController.js'), `export default class TagsController { constructor(r) { this.r = r; } index() { this.ok([]); } show() { this.ok({}); } }`);

    const master = masterSingleton;
    master.root = root; master.environmentType = 'development';
    process.env.MC_DISABLE_DEFAULT_LOG_PROVIDER = '1';
    server = master.setupServer('http');
    master.auth.addJwtBearer('bearer', { secret: 'a-very-long-test-secret-at-least-32-chars!!' });
    master.auth.addPolicy('Senior', () => true);
    master.useOpenApi({ title: 'Items API', version: '2.0.0', ui: '/docs', servers: [{ url: 'http://localhost:3001' }] });
    await master.startMVC('app'); await master.start(server);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const res = await fetch(base + '/openapi.json'); assert.equal(res.status, 200);
    const doc = await res.json();
    assert.equal(doc.openapi, '3.1.0'); assert.equal(doc.info.title, 'Items API'); assert.equal(doc.info.version, '2.0.0'); assert.deepEqual(doc.servers, [{ url: 'http://localhost:3001' }]);
    assert.deepEqual(Object.keys(doc.paths).sort(), ['/items', '/items/{id}', '/secret', '/tags', '/tags/{id}']);

    const list = doc.paths['/items'].get;
    assert.equal(list.operationId, 'items_index'); assert.equal(list.summary, 'List items'); assert.deepEqual(list.tags, ['Items']);
    assert.deepEqual(list.parameters, [{ name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 } }, { name: 'q', in: 'query', required: false, schema: { type: 'string' } }]);
    assert.equal(list.responses['200'].description, 'A page of items'); assert.ok(list.responses['400'], 'validation problem declared when schemas exist');
    assert.deepEqual(list.security, [], 'allowAnonymous route -> explicit empty security');

    const show = doc.paths['/items/{id}'].get;
    assert.deepEqual(show.parameters, [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]);
    assert.equal(show.security, undefined, 'controller authorize show:false -> anonymous');

    const create = doc.paths['/items'].post;
    assert.equal(create.deprecated, true);
    assert.deepEqual(create.requestBody.content['application/json'].schema, { type: 'object', properties: { name: { type: 'string' }, price: { type: 'number', minimum: 0 }, tags: { type: 'array', items: { type: 'string' } } }, required: ['name'] });
    assert.ok(create.parameters.some(p => p.name === 'dryRun' && p.in === 'query' && p.schema.type === 'boolean'));
    assert.deepEqual(create.security, [{ bearer: ['role:admin'] }]); assert.ok(create.responses['401'] && create.responses['403'] && create.responses['201']);
    assert.deepEqual(create['x-output-cache'], { duration: 5 });
    assert.deepEqual(doc.paths['/secret'].get.security, [{ bearer: ['policy:Senior'] }]);
    assert.deepEqual(doc.components.securitySchemes, { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } });
    assert.ok(doc.components.schemas.ProblemDetails && doc.components.schemas.ValidationProblemDetails);
    assert.equal(doc.paths['/tags/{id}'].get.operationId, 'tags_show');

    const ui = await fetch(base + '/docs'); assert.equal(ui.status, 200); assert.match(ui.headers.get('content-type'), /text\/html/); assert.match(await ui.text(), /swagger-ui/);
    assert.equal(master.openApi.document().info.title, 'Items API');
});
