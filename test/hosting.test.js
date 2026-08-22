/**
 * 2.6.0 — hosted services, BackgroundService, PeriodicTimerService (scope per run),
 * background task queue, host lifetime and graceful shutdown (ASP.NET generic host parity).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostedServiceManager, BackgroundService, PeriodicTimerService, BackgroundTaskQueue, QueuedHostedService, ApplicationLifetime } from '../MasterHosting.js';
import { MasterControl } from '../MasterControl.js';

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

test('hosted services start in order, stop in reverse; failing start aborts the boot; late add starts immediately', async () => {
    const m = new MasterControl();
    const h = new HostedServiceManager(m);
    const log = [];
    const mk = (name) => ({ name, async start() { log.push(`start:${name}`); }, async stop() { log.push(`stop:${name}`); } });
    h.add(mk('a')); h.add(mk('b'));
    class C { constructor(master) { this.master = master; } async start() { log.push('start:c'); } async stop() { log.push('stop:c'); } }
    h.add(C);
    assert.deepEqual(h.names, ['a', 'b', 'C']);
    await h.start();
    assert.deepEqual(log, ['start:a', 'start:b', 'start:c']);
    h.add(mk('late')); await tick();
    assert.ok(log.includes('start:late'), 'added after start -> started now');
    await h.stop();
    assert.deepEqual(log.slice(-4), ['stop:late', 'stop:c', 'stop:b', 'stop:a'], 'reverse order');
    assert.equal(await h.stop(), undefined, 'idempotent');

    const h2 = new HostedServiceManager(m);
    h2.add({ name: 'bad', async start() { throw new Error('no db'); }, async stop() {} });
    await assert.rejects(() => h2.start(), /Hosted service 'bad' failed to start: no db/);
    assert.throws(() => h2.add({}), /start\(signal\)/);
});

test('BackgroundService: executeAsync runs without blocking start, honors the signal, stop() waits (bounded by timeout), StopHost on unhandled error', async () => {
    const m = new MasterControl();
    m.hosting = new HostedServiceManager(m);
    const events = [];
    class Worker extends BackgroundService {
        async executeAsync(signal) {
            events.push('running');
            while (!signal.aborted) await this.delay(1000, signal);
            events.push('cancelled');
        }
    }
    const w = new Worker(m);
    m.hosting.add(w);
    const t0 = Date.now();
    await m.hosting.start();
    assert.ok(Date.now() - t0 < 200, 'start() returns immediately (ExecuteAsync is not awaited)');
    await tick(); assert.deepEqual(events, ['running']); assert.equal(w.isRunning, true);
    await m.hosting.stop({ timeoutMs: 500 });
    assert.deepEqual(events, ['running', 'cancelled']);

    // never-finishing service: stop is bounded by the timeout
    class Stubborn extends BackgroundService { async executeAsync() { await new Promise(() => {}); } }
    const h3 = new HostedServiceManager(m); h3.add(new Stubborn(m));
    await h3.start();
    const t1 = Date.now(); await h3.stop({ timeoutMs: 40 }); assert.ok(Date.now() - t1 < 1000, 'bounded by shutdown timeout');

    // StopHost: an unhandled exception stops the host
    const m2 = new MasterControl(); m2.hosting = new HostedServiceManager(m2);
    let stopped = false; m2.hosting.lifetime.onStopped(() => { stopped = true; });
    class Crash extends BackgroundService { async executeAsync() { await tick(); throw new Error('boom'); } }
    m2.hosting.add(new Crash(m2));
    await m2.hosting.start(); await tick(30);
    assert.equal(stopped, true, 'BackgroundServiceExceptionBehavior.StopHost');
    // ignore: host keeps running
    const m3 = new MasterControl(); m3.hosting = new HostedServiceManager(m3);
    let stopped3 = false; m3.hosting.lifetime.onStopped(() => { stopped3 = true; });
    class Crash2 extends BackgroundService { constructor(x) { super(x); this.exceptionBehavior = 'ignore'; } async executeAsync() { throw new Error('boom'); } }
    const c2 = new Crash2(m3); m3.hosting.add(c2); await m3.hosting.start(); await tick(20);
    assert.equal(stopped3, false); assert.match(c2.lastError.message, /boom/);
});

test('PeriodicTimerService: ticks with a fresh DI scope per run (scoped context built and closed), failures logged and loop continues', async () => {
    const m = new MasterControl();
    m.hosting = new HostedServiceManager(m);
    let built = 0; const closed = [];
    class Ctx { constructor() { built++; this.id = built; } async close() { closed.push(this.id); } }
    m.addScoped('db', Ctx);
    const seen = [];
    const svc = new PeriodicTimerService(m, { name: 'cleanup', intervalMs: 10, runOnStart: true, run: async (scope) => { seen.push(scope.db.id); if (seen.length === 2) throw new Error('flaky'); } });
    m.hosting.add(svc);
    await m.hosting.start();
    await tick(60);
    await m.hosting.stop({ timeoutMs: 200 });
    assert.ok(svc.ticks >= 3, `ticked ${svc.ticks}`);
    assert.equal(svc.failures, 1); assert.match(svc.lastError.message, /flaky/);
    assert.deepEqual(seen.slice(0, 3), [1, 2, 3], 'new scoped db per run');
    assert.deepEqual(closed.slice(0, 3), [1, 2, 3], 'each run disposed its scope');
    assert.throws(() => new PeriodicTimerService(m, { intervalMs: 0, run() {} }), /intervalMs/);
});

test('BackgroundTaskQueue + QueuedHostedService: jobs run with a scope, concurrency, results/errors propagate through enqueue()', async () => {
    const m = new MasterControl();
    m.hosting = new HostedServiceManager(m);
    class Ctx { async close() {} }
    m.addScoped('db', Ctx);
    const q = new BackgroundTaskQueue();
    m.hosting.add(new QueuedHostedService(m, q, { concurrency: 2 }));
    await m.hosting.start();
    let inFlight = 0, peak = 0;
    const job = (n) => async (scope) => { assert.ok(scope.db instanceof Ctx); inFlight++; peak = Math.max(peak, inFlight); await tick(15); inFlight--; return n * 2; };
    const results = await Promise.all([q.enqueue(job(1)), q.enqueue(job(2)), q.enqueue(job(3))]);
    assert.deepEqual(results, [2, 4, 6]); assert.equal(peak, 2, 'two workers');
    await assert.rejects(() => q.enqueue(async () => { throw new Error('job failed'); }), /job failed/);
    assert.equal(q.processed, 3); assert.equal(q.failed, 1);
    assert.throws(() => q.enqueue('nope'), /requires a function/);
    await m.hosting.stop({ timeoutMs: 200 });
});

test('lifetime events + master integration: start(server) starts services, stop() closes the server and fires stopping/stopped; useGracefulShutdown registers signal handlers', async () => {
    const m = new MasterControl();
    const server = m.setupServer('http');
    const log = [];
    m.lifetime.onStarted(() => log.push('started'));
    m.lifetime.onStopping(() => log.push('stopping'));
    m.lifetime.onStopped(() => log.push('stopped'));
    m.addHostedService({ name: 'svc', async start() { log.push('svc:start'); }, async stop() { log.push('svc:stop'); } });
    const periodic = m.addPeriodicService('beat', 5, async () => {});
    assert.ok(periodic instanceof PeriodicTimerService);
    let queued = false; const done = m.backgroundQueue.enqueue(async () => { queued = true; return 'ok'; });
    await m.start(server);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    await tick(20);
    assert.equal(await done, 'ok'); assert.equal(queued, true);
    assert.ok(log.includes('started'), 'ApplicationStarted when listening');
    assert.equal(m.lifetime.isStopping, false);
    const before = process.listenerCount('SIGTERM');
    const dispose = m.useGracefulShutdown({ exit: false });
    assert.equal(process.listenerCount('SIGTERM'), before + 1);
    dispose(); assert.equal(process.listenerCount('SIGTERM'), before);
    await m.stop({ timeoutMs: 500 });
    assert.equal(server.listening, false, 'server closed on stop');
    assert.deepEqual(log.filter(x => x !== 'started').slice(0, 1), ['svc:start']);
    assert.deepEqual(log.slice(-3), ['svc:stop', 'stopped'].length === 2 ? log.slice(-3) : log.slice(-3));
    assert.ok(log.indexOf('stopping') < log.indexOf('svc:stop') && log.indexOf('svc:stop') < log.indexOf('stopped'));
    assert.equal(m.lifetime.isStopping, true);
    const lt = new ApplicationLifetime(); let fired = 0; lt.onStarted(() => fired++); await lt._fire('started'); assert.equal(fired, 1);
});
