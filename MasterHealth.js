/**
 * MasterHealth — readiness / liveness endpoints modeled on ASP.NET Core health
 * checks (AddHealthChecks().AddCheck(name, tags) + MapHealthChecks with predicates):
 *
 *   master.useHealthChecks({
 *     path: '/health',                    // full report (all checks)
 *     livePath: '/health/live',           // liveness: the process is up (no checks) — 200, or 503 while stopping
 *     readyPath: '/health/ready',         // readiness: checks tagged 'ready' — 200 / 503
 *     checks: { db: async () => ({ healthy: true }), redis: { check: fn, tags: ['ready'], timeoutMs: 2000, critical: false } },
 *     authorize: (ctx) => boolean,        // optional gate (e.g. internal network only)
 *   });
 *   master.healthChecks.add('queue', fn, { tags: ['ready'] });
 *
 * Response (ASP.NET shape): { status: 'Healthy' | 'Degraded' | 'Unhealthy', totalDurationMs, uptimeSec,
 *   checks: { name: { status, durationMs, description?, data?, error? } } }  — HTTP 200 for Healthy/Degraded, 503 for Unhealthy.
 * Readiness turns Unhealthy automatically once master.stop() begins (lifetime.isStopping), so load balancers drain.
 */

const STATUS_CODE = { Healthy: 200, Degraded: 200, Unhealthy: 503 };

export class HealthCheckService {
    constructor(master, options = {}) {
        this.master = master;
        this.path = options.path === false ? null : (options.path || '/health');
        this.livePath = options.livePath === false ? null : (options.livePath || '/health/live');
        this.readyPath = options.readyPath === false ? null : (options.readyPath || '/health/ready');
        this.authorize = typeof options.authorize === 'function' ? options.authorize : null;
        this.defaultTimeoutMs = options.timeoutMs || 5000;
        this.includeDetails = options.includeDetails !== false;
        this._checks = new Map();
        this.startedAt = Date.now();
        for (const [name, def] of Object.entries(options.checks || {})) this.add(name, typeof def === 'function' ? def : def.check, typeof def === 'function' ? {} : def);
    }
    /** @param {(ctx?)=>boolean|{healthy?:boolean,status?:string,description?:string,data?:Object}|Promise} check */
    add(name, check, { tags = [], timeoutMs, critical = true, description } = {}) {
        if (typeof check !== 'function') throw new TypeError(`healthChecks.add('${name}'): check must be a function`);
        this._checks.set(name, { name, check, tags: [].concat(tags), timeoutMs: timeoutMs || this.defaultTimeoutMs, critical, description });
        return this;
    }
    remove(name) { this._checks.delete(name); return this; }
    get names() { return [...this._checks.keys()]; }

    async _run(def, ctx) {
        const started = Date.now();
        let timer;
        try {
            const result = await Promise.race([
                Promise.resolve(def.check(ctx)),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${def.timeoutMs}ms`)), def.timeoutMs); }),
            ]);
            clearTimeout(timer);
            let status = 'Healthy', description = def.description, data;
            if (result === false) status = def.critical ? 'Unhealthy' : 'Degraded';
            else if (result && typeof result === 'object') {
                if (result.status) status = ['Healthy', 'Degraded', 'Unhealthy'].includes(result.status) ? result.status : (result.status ? 'Healthy' : 'Unhealthy');
                else if (result.healthy === false) status = def.critical ? 'Unhealthy' : 'Degraded';
                if (result.description) description = result.description;
                if (result.data) data = result.data;
            }
            return { status, durationMs: Date.now() - started, ...(description ? { description } : {}), ...(data ? { data } : {}) };
        } catch (err) {
            clearTimeout(timer);
            return { status: def.critical ? 'Unhealthy' : 'Degraded', durationMs: Date.now() - started, error: err && err.message };
        }
    }

    /** Run checks (optionally filtered by tag) -> report. */
    async report(ctx, { tag } = {}) {
        const started = Date.now();
        const defs = [...this._checks.values()].filter(d => !tag || d.tags.includes(tag));   // readiness = explicitly 'ready'-tagged checks (ASP.NET predicate)
        const results = await Promise.all(defs.map(d => this._run(d, ctx)));
        const checks = {};
        let status = 'Healthy';
        defs.forEach((d, i) => { checks[d.name] = results[i]; if (results[i].status === 'Unhealthy') status = 'Unhealthy'; else if (results[i].status === 'Degraded' && status === 'Healthy') status = 'Degraded'; });
        const stopping = this.master && this.master.hosting && this.master.hosting.lifetime && this.master.hosting.lifetime.isStopping;
        if (stopping) { status = 'Unhealthy'; checks.host = { status: 'Unhealthy', durationMs: 0, description: 'shutting down' }; }
        return { status, totalDurationMs: Date.now() - started, uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000), ...(this.includeDetails ? { checks } : {}) };
    }

    middleware() {
        const self = this;
        const send = (res, status, body) => { const json = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(json) }); res.end(json); };
        return async function healthChecks(ctx, next) {
            const p = '/' + String(ctx.pathName || '').replace(/^\/|\/$/g, '');
            const isLive = self.livePath && p === self.livePath, isReady = self.readyPath && p === self.readyPath, isFull = self.path && p === self.path;
            if (!isLive && !isReady && !isFull) { await next(); return; }
            if (self.authorize && !(await self.authorize(ctx))) { send(ctx.response, 403, { type: 'about:blank', title: 'Forbidden', status: 403 }); return; }
            if (isLive) {
                const stopping = self.master && self.master.hosting && self.master.hosting.lifetime && self.master.hosting.lifetime.isStopping;
                send(ctx.response, stopping ? 503 : 200, { status: stopping ? 'Unhealthy' : 'Healthy', uptimeSec: Math.floor((Date.now() - self.startedAt) / 1000) });
                return;
            }
            const report = await self.report(ctx, isReady ? { tag: 'ready' } : {});
            send(ctx.response, STATUS_CODE[report.status] || 503, report);
        };
    }
}

export default HealthCheckService;
