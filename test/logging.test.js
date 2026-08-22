/**
 * 2.7.0 — Logging (ILogger parity): categories + per-category levels from
 * configuration, message templates, redaction, scopes across awaits, providers,
 * request correlation (X-Request-Id) and this.logger in controllers (e2e).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LoggerFactory, memoryProvider, consoleProvider, normalizeLevel } from '../MasterLogging.js';
import { ConfigurationRoot } from '../MasterConfiguration.js';
import masterSingleton, { MasterControl } from '../MasterControl.js';

test('levels, categories (longest prefix wins), templates, props/error, redaction, providers, enrichers', async () => {
    const cfg = new ConfigurationRoot().addInMemory({ Logging: { LogLevel: { Default: 'warn', 'Orders': 'debug', 'Orders.Payments': 'error' } } }).build();
    const f = new LoggerFactory({ configuration: cfg });
    const mem = memoryProvider(); f.addProvider(mem);
    assert.equal(f.levelFor('Anything'), 'warn'); assert.equal(f.levelFor('Orders.Service'), 'debug'); assert.equal(f.levelFor('Orders.Payments.Stripe'), 'error');
    const any = f.createLogger('Anything'); any.info('hidden'); any.warn('shown {n}', { n: 1 });
    const orders = f.createLogger('Orders.Service'); orders.debug('dbg'); orders.trace('too low');
    const pay = f.createLogger('Orders.Payments.Stripe'); pay.warn('hidden'); pay.error('charge failed', new Error('declined'), { password: 'x', card: { token: 't', last4: '4242' } });
    assert.deepEqual(mem.entries.map(e => `${e.category}:${e.level}:${e.message}`), ['Anything:warn:shown 1', 'Orders.Service:debug:dbg', 'Orders.Payments.Stripe:error:charge failed']);
    const e = mem.entries[2];
    assert.equal(e.error.message, 'declined'); assert.ok(e.error.stack);
    assert.deepEqual(e.properties, { password: '[REDACTED]', card: { token: '[REDACTED]', last4: '4242' } }, 'sensitive keys redacted, nested too');
    assert.equal(any.isEnabled('debug'), false); assert.equal(orders.isEnabled('debug'), true);
    assert.equal(normalizeLevel('Information'), 'info'); assert.equal(normalizeLevel('Warning'), 'warn'); assert.equal(normalizeLevel('Critical'), 'critical'); assert.equal(normalizeLevel('bogus'), 'info');

    // configuration change re-applies levels; enrichers; provider minimumLevel; child loggers
    cfg.set('Logging:LogLevel:Default', 'trace');
    const lines = []; const remove = f.addProvider({ name: 'x', minimumLevel: 'error', write: (en) => lines.push(en.level) });
    f.enrich({ service: 'api' });
    f.createLogger('Anything').trace('now visible'); f.createLogger('Anything').error('boom');
    assert.deepEqual(lines, ['error'], 'provider minimumLevel filter');
    assert.equal(mem.entries.at(-1).service, 'api', 'enricher');
    remove(); f.createLogger('Anything').error('again'); assert.deepEqual(lines, ['error']);
    assert.equal(orders.child('Retry').category, 'Orders.Service.Retry');
    assert.throws(() => f.addProvider({}), /write\(entry\)/);
    // a throwing provider never breaks the app
    f.addProvider(() => { throw new Error('sink down'); }); f.createLogger('Anything').info('still fine');
    assert.equal(mem.entries.at(-1).message, 'still fine');
});

test('scopes flow through async code (BeginScope / runInScope) and nest', async () => {
    const f = new LoggerFactory({ minimumLevel: 'trace' }); const mem = memoryProvider(); f.addProvider(mem);
    const log = f.createLogger('Jobs');
    await log.scope({ jobId: 'j1' }, async () => {
        log.info('start');
        await new Promise(r => setTimeout(r, 2));
        await log.scope({ step: 2 }, async () => { await Promise.resolve(); log.info('inner'); });
        log.info('end');
    });
    log.info('outside');
    assert.deepEqual(mem.entries.map(e => e.scope), [{ jobId: 'j1' }, { jobId: 'j1', step: 2 }, { jobId: 'j1' }, undefined]);
    // beginScope/dispose inside a scope context
    await LoggerFactory.runInScope({ a: 1 }, async () => {
        const dispose = log.beginScope({ b: 2 }); log.info('in'); dispose(); log.info('after');
    });
    assert.deepEqual(mem.entries.slice(-2).map(e => e.scope), [{ a: 1, b: 2 }, { a: 1 }]);
});

test('console provider renders text (dev) and JSON (prod)', () => {
    const out = []; const fake = { write: (s) => out.push(s), isTTY: false };
    const f = new LoggerFactory({ minimumLevel: 'trace' });
    f.addProvider(consoleProvider({ json: false, stream: fake, errStream: fake }));
    f.createLogger('Cat').info('hello {who}', { who: 'world' });
    assert.match(out[0], /INFO\s+Cat: hello world \{"who":"world"\}/);
    const f2 = new LoggerFactory({ minimumLevel: 'trace' }); f2.addProvider(consoleProvider({ json: true, stream: fake, errStream: fake }));
    f2.createLogger('Cat').error('bad', new Error('x'));
    const parsed = JSON.parse(out[1]); assert.equal(parsed.level, 'error'); assert.equal(parsed.error.message, 'x');
});

let server;
after(() => new Promise((r) => (server ? server.close(() => r()) : r())));

test('e2e: this.logger in controllers carries the request scope; X-Request-Id honored/generated; access log line; master.createLogger', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-log-app-'));
    const app = path.join(root, 'app'); fs.mkdirSync(path.join(app, 'controllers'), { recursive: true });
    const masterUrl = pathToFileURL(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'MasterControl.js')).href;
    fs.writeFileSync(path.join(app, 'routes.js'), `import master from ${JSON.stringify(masterUrl)}; const r = master.router.start(); r.route('/ping', 'ping#index', 'get');`);
    fs.writeFileSync(path.join(app, 'controllers', 'pingController.js'), `
export default class PingController {
  constructor(r) { this.r = r; }
  async index() { this.logger.info('pinged {n}', { n: 7 }); await new Promise(res => setTimeout(res, 2)); this.logger.warn('after await'); this.ok({ id: this.requestObject ? undefined : null, rid: this.r.requestId }); }
}`);
    const master = masterSingleton;
    master.root = root; master.environmentType = 'development';
    process.env.MC_DISABLE_DEFAULT_LOG_PROVIDER = '1';
    server = master.setupServer('http');
    const mem = MasterControl.memoryLogProvider(); master.logging.addProvider(mem);
    master.logging.setMinimumLevel('trace');
    await master.startMVC('app'); await master.start(server);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    let r = await fetch(base + '/ping', { headers: { 'x-request-id': 'req-abc-123' } });
    assert.equal(r.status, 200); assert.equal(r.headers.get('x-request-id'), 'req-abc-123'); assert.equal((await r.json()).rid, 'req-abc-123');
    const mine = mem.entries.filter(e => e.category === 'PingController');
    assert.equal(mine.length, 2);
    assert.deepEqual(mine.map(e => e.message), ['pinged 7', 'after await']);
    assert.ok(mine.every(e => e.scope && e.scope.requestId === 'req-abc-123' && e.scope.method === 'get'), 'scope survives awaits inside the action');
    const access = mem.entries.find(e => e.category === 'Request' && /GET \/ping -> 200/.test(e.message));
    assert.ok(access, 'access log line'); assert.equal(access.scope.requestId, 'req-abc-123');
    r = await fetch(base + '/ping'); assert.match(r.headers.get('x-request-id'), /^[0-9a-f-]{36}$/, 'generated uuid');
    const svcLog = master.createLogger('Billing'); svcLog.info('outside request'); assert.equal(mem.entries.at(-1).scope, undefined);
});
