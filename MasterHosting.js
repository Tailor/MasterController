/**
 * MasterHosting — hosted services, background work and host lifetime, modeled
 * on ASP.NET Core's generic host:
 *
 *   ASP.NET Core                                   MasterController
 *   services.AddHostedService<T>()                 master.addHostedService(Class | instance, { name })
 *   IHostedService.StartAsync / StopAsync          start(signal) / stop()  — started in order at master.start(), stopped in REVERSE
 *   BackgroundService.ExecuteAsync(token)          class extends BackgroundService { async executeAsync(signal) {…} }
 *   BackgroundServiceExceptionBehavior.StopHost    default: an unhandled exception in executeAsync stops the host ('ignore' to opt out)
 *   PeriodicTimer loop with a DI scope per run     master.addPeriodicService(name, intervalMs, async (scope, signal) => …)
 *   IBackgroundTaskQueue + QueuedHostedService     master.backgroundQueue.enqueue(async (scope, signal) => …)  (concurrency configurable)
 *   IHostApplicationLifetime (Started/Stopping/Stopped)   master.lifetime.onStarted / onStopping / onStopped, lifetime.stoppingSignal
 *   HostOptions.ShutdownTimeout (30 s)             master.shutdownTimeoutMs
 *   SIGTERM/SIGINT graceful shutdown               master.useGracefulShutdown()  ->  stop accepting, stop services, exit
 */
import { logger } from './error/MasterErrorLogger.js';

const sleep = (ms, signal) => new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { if (signal) signal.removeEventListener('abort', done); clearTimeout(t); resolve(); }
    if (signal) signal.addEventListener('abort', done, { once: true });
});

/** Race a promise against a timeout; resolves { timedOut } instead of throwing. */
async function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms); });
    try {
        const r = await Promise.race([Promise.resolve(promise).then((v) => ({ timedOut: false, value: v })), timeout]);
        return r;
    } finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------------------

export class ApplicationLifetime {
    constructor() {
        this._handlers = { started: [], stopping: [], stopped: [] };
        this._stoppingController = new AbortController();
        this.startedAt = null;
        this.stoppedAt = null;
    }
    /** AbortSignal that fires when the host begins shutting down (IHostApplicationLifetime.ApplicationStopping). */
    get stoppingSignal() { return this._stoppingController.signal; }
    get isStopping() { return this._stoppingController.signal.aborted; }
    onStarted(cb) { this._handlers.started.push(cb); return () => this._off('started', cb); }
    onStopping(cb) { this._handlers.stopping.push(cb); return () => this._off('stopping', cb); }
    onStopped(cb) { this._handlers.stopped.push(cb); return () => this._off('stopped', cb); }
    _off(name, cb) { this._handlers[name] = this._handlers[name].filter(h => h !== cb); }
    async _fire(name, payload) {
        if (name === 'stopping') this._stoppingController.abort();
        if (name === 'started') this.startedAt = Date.now();
        if (name === 'stopped') this.stoppedAt = Date.now();
        for (const cb of [...this._handlers[name]]) {
            try { await cb(payload); } catch (err) { logger.error({ code: 'MC_LIFETIME_HANDLER_ERROR', event: name, error: err && err.message }); }
        }
    }
}

// ---------------------------------------------------------------------------

/**
 * Base class for long-running work (ASP.NET BackgroundService). Override
 * executeAsync(signal); honor the signal to stop promptly. `this.master` gives
 * access to DI scopes: `await this.useScope(async (scope) => scope.db…)`.
 */
export class BackgroundService {
    constructor(master) {
        this.master = master || null;
        this.name = this.constructor.name;
        /** 'stopHost' (ASP.NET default since .NET 6) | 'ignore' */
        this.exceptionBehavior = 'stopHost';
        this._abort = null;
        this._task = null;
        this.lastError = null;
        this.runs = 0;
    }
    get signal() { return this._abort ? this._abort.signal : null; }
    get isRunning() { return !!(this._abort && !this._abort.signal.aborted && this._task); }

    /** StartAsync: kick off executeAsync WITHOUT awaiting it (ASP.NET semantics). */
    async start() {
        if (this._task) return;
        this._abort = new AbortController();
        const signal = this._abort.signal;
        this._task = Promise.resolve()
            .then(() => this.executeAsync(signal))
            .catch((err) => this._onExecuteError(err))
            .finally(() => { this._finished = true; });
    }
    /** StopAsync: signal cancellation and wait (bounded by the host's shutdown timeout). */
    async stop({ timeoutMs } = {}) {
        if (this._abort && !this._abort.signal.aborted) this._abort.abort();
        if (!this._task) return;
        const r = await withTimeout(this._task, timeoutMs || 30000);
        if (r.timedOut) logger.warn({ code: 'MC_HOSTED_STOP_TIMEOUT', service: this.name, timeoutMs: timeoutMs || 30000 });
    }
    /** Override me. */
    async executeAsync(_signal) { throw new Error(`${this.name}: implement executeAsync(signal)`); }

    createScope() { return this.master && typeof this.master.createScope === 'function' ? this.master.createScope() : {}; }
    useScope(fn) { return this.master && typeof this.master.useScope === 'function' ? this.master.useScope(fn) : Promise.resolve(fn({})); }
    delay(ms, signal = this.signal) { return sleep(ms, signal); }

    _onExecuteError(err) {
        this.lastError = err;
        if (this._abort && this._abort.signal.aborted && err && err.name === 'AbortError') return;   // cancelled on purpose
        logger.error({ code: 'MC_BACKGROUND_SERVICE_ERROR', service: this.name, error: err && err.message, stack: err && err.stack });
        if (this.exceptionBehavior === 'stopHost' && this.master && this.master.hosting && typeof this.master.hosting.stop === 'function') {
            // ASP.NET BackgroundServiceExceptionBehavior.StopHost: an unhandled
            // exception in a background service stops the host (never silently).
            this.master.hosting.stop({ reason: `background service '${this.name}' failed: ${err && err.message}`, error: err }).catch(() => { /* logged by stop */ });
        }
    }
}

/** Periodic job: `run(scope, signal)` every intervalMs with a fresh DI scope per run. */
export class PeriodicTimerService extends BackgroundService {
    constructor(master, { name, intervalMs, run, runOnStart = false, exceptionBehavior = 'ignore', jitterMs = 0 } = {}) {
        super(master);
        if (!(intervalMs > 0)) throw new TypeError('PeriodicTimerService: intervalMs must be > 0');
        if (typeof run !== 'function') throw new TypeError('PeriodicTimerService: run(scope, signal) is required');
        this.name = name || 'periodic';
        this.intervalMs = intervalMs;
        this.run = run;
        this.runOnStart = runOnStart;
        this.jitterMs = jitterMs;
        this.exceptionBehavior = exceptionBehavior;   // a failing tick is logged and the loop continues
        this.ticks = 0;
        this.failures = 0;
    }
    async executeAsync(signal) {
        if (this.runOnStart) await this._tick(signal);
        while (!signal.aborted) {
            await this.delay(this.intervalMs + (this.jitterMs ? Math.floor(Math.random() * this.jitterMs) : 0), signal);
            if (signal.aborted) break;
            await this._tick(signal);
        }
    }
    async _tick(signal) {
        this.ticks++;
        try {
            await this.useScope((scope) => this.run(scope, signal));
        } catch (err) {
            this.failures++;
            this.lastError = err;
            logger.error({ code: 'MC_PERIODIC_SERVICE_ERROR', service: this.name, error: err && err.message, stack: err && err.stack });
            if (this.exceptionBehavior === 'stopHost') throw err;
        }
    }
}

/** In-memory background task queue (IBackgroundTaskQueue). enqueue() resolves when the job finished. */
export class BackgroundTaskQueue {
    constructor({ maxSize = 10000 } = {}) {
        this._items = [];
        this._waiters = [];
        this.maxSize = maxSize;
        this.processed = 0;
        this.failed = 0;
    }
    get size() { return this._items.length; }
    /** @param {(scope:Object, signal:AbortSignal)=>any} job */
    enqueue(job) {
        if (typeof job !== 'function') throw new TypeError('backgroundQueue.enqueue(job) requires a function(scope, signal)');
        if (this._items.length >= this.maxSize) throw new Error(`backgroundQueue is full (${this.maxSize})`);
        return new Promise((resolve, reject) => {
            const item = { job, resolve, reject };
            const waiter = this._waiters.shift();
            if (waiter) waiter(item); else this._items.push(item);
        });
    }
    /** Resolves with the next item, or null when the signal aborts. */
    dequeue(signal) {
        if (this._items.length) return Promise.resolve(this._items.shift());
        if (signal && signal.aborted) return Promise.resolve(null);
        return new Promise((resolve) => {
            const waiter = (item) => { if (signal) signal.removeEventListener('abort', onAbort); resolve(item); };
            const onAbort = () => { this._waiters = this._waiters.filter(w => w !== waiter); resolve(null); };
            this._waiters.push(waiter);
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
        });
    }
}

/** Drains a BackgroundTaskQueue with N workers; each job gets its own DI scope. */
export class QueuedHostedService extends BackgroundService {
    constructor(master, queue, { concurrency = 1, name = 'backgroundQueue' } = {}) {
        super(master);
        this.queue = queue;
        this.concurrency = Math.max(1, concurrency | 0);
        this.name = name;
        this.exceptionBehavior = 'ignore';   // a failing job is reported through its promise, never stops the host
    }
    async executeAsync(signal) {
        const worker = async () => {
            while (!signal.aborted) {
                const item = await this.queue.dequeue(signal);
                if (!item) break;
                try {
                    const value = await this.useScope((scope) => item.job(scope, signal));
                    this.queue.processed++;
                    item.resolve(value);
                } catch (err) {
                    this.queue.failed++;
                    logger.error({ code: 'MC_BACKGROUND_JOB_ERROR', service: this.name, error: err && err.message });
                    item.reject(err);
                }
            }
        };
        await Promise.all(Array.from({ length: this.concurrency }, () => worker()));
    }
}

// ---------------------------------------------------------------------------

export class HostedServiceManager {
    constructor(master) {
        this.master = master;
        this._entries = [];             // { name, service }
        this.lifetime = new ApplicationLifetime();
        this.shutdownTimeoutMs = 30000;  // HostOptions.ShutdownTimeout
        this.started = false;
        this._stopping = null;
        this._signalHandlers = [];
    }

    /** Register a hosted service (class constructed with `master`, or an instance with start()/stop()). */
    add(serviceOrClass, { name } = {}) {
        let service = serviceOrClass;
        if (typeof serviceOrClass === 'function') {
            service = new serviceOrClass(this.master);
        }
        if (!service || typeof service.start !== 'function') {
            throw new TypeError('addHostedService: expected a class / instance with start(signal) and stop() (or a BackgroundService)');
        }
        if (service instanceof BackgroundService && !service.master) service.master = this.master;
        const entry = { name: name || service.name || service.constructor.name || `hosted${this._entries.length + 1}`, service };
        this._entries.push(entry);
        if (this.started) {                    // added after start(): start it now (like a late AddHostedService + StartAsync)
            Promise.resolve(service.start(this.lifetime.stoppingSignal)).catch((err) => logger.error({ code: 'MC_HOSTED_START_ERROR', service: entry.name, error: err && err.message }));
        }
        return service;
    }
    get services() { return this._entries.map(e => ({ name: e.name, service: e.service })); }
    get names() { return this._entries.map(e => e.name); }

    /** Start every hosted service in registration order (a failing start aborts the boot — ASP.NET behavior). */
    async start() {
        if (this.started) return;
        for (const { name, service } of this._entries) {
            try {
                await service.start(this.lifetime.stoppingSignal);
                logger.info({ code: 'MC_HOSTED_STARTED', service: name });
            } catch (err) {
                logger.error({ code: 'MC_HOSTED_START_FAILED', service: name, error: err && err.message, stack: err && err.stack });
                const e = new Error(`Hosted service '${name}' failed to start: ${err && err.message}`);
                e.cause = err; e.code = 'MC_HOSTED_START_FAILED';
                throw e;
            }
        }
        this.started = true;
    }

    /** Fire ApplicationStarted (called when the server is listening, or right after start() when there is no server). */
    async notifyStarted() { await this.lifetime._fire('started', { master: this.master }); }

    /**
     * Graceful shutdown (idempotent): stopping event -> stop accepting connections
     * -> stop hosted services in REVERSE order (each bounded by shutdownTimeoutMs)
     * -> stopped event. Returns the same promise for concurrent callers.
     */
    stop({ timeoutMs, reason } = {}) {
        if (this._stopping) return this._stopping;
        const budget = timeoutMs || this.shutdownTimeoutMs;
        this._stopping = (async () => {
            logger.info({ code: 'MC_HOST_STOPPING', reason: reason || 'requested' });
            await this.lifetime._fire('stopping', { reason });
            const server = this.master && this.master.server;
            if (server && typeof server.close === 'function' && server.listening) {
                await new Promise((resolve) => { try { server.close(() => resolve()); if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections(); } catch (_) { resolve(); } });
            }
            const deadline = Date.now() + budget;
            for (const { name, service } of [...this._entries].reverse()) {
                const remaining = Math.max(1, deadline - Date.now());
                try {
                    const r = await withTimeout(Promise.resolve(typeof service.stop === 'function' ? service.stop({ timeoutMs: remaining }) : undefined), remaining);
                    if (r.timedOut) logger.warn({ code: 'MC_HOSTED_STOP_TIMEOUT', service: name, timeoutMs: remaining });
                    else logger.info({ code: 'MC_HOSTED_STOPPED', service: name });
                } catch (err) {
                    logger.error({ code: 'MC_HOSTED_STOP_ERROR', service: name, error: err && err.message });
                }
            }
            this.started = false;
            await this.lifetime._fire('stopped', { reason });
            logger.info({ code: 'MC_HOST_STOPPED' });
        })();
        return this._stopping;
    }

    /** Install SIGTERM/SIGINT handlers that run stop() then exit (unless exit: false). */
    useSignals({ signals = ['SIGTERM', 'SIGINT'], exit = true, exitCode = 0 } = {}) {
        this.removeSignals();
        for (const sig of signals) {
            const handler = () => {
                this.stop({ reason: sig }).finally(() => { if (exit) process.exit(exitCode); });
            };
            process.on(sig, handler);
            this._signalHandlers.push({ sig, handler });
        }
        return () => this.removeSignals();
    }
    removeSignals() {
        for (const { sig, handler } of this._signalHandlers) process.removeListener(sig, handler);
        this._signalHandlers = [];
    }
}

export default HostedServiceManager;
