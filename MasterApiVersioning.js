/**
 * MasterApiVersioning — API versioning modeled on ASP.NET Core's Asp.Versioning:
 *
 *   services.AddApiVersioning(o => { o.DefaultApiVersion = 1.0; o.AssumeDefaultVersionWhenUnspecified = true;
 *       o.ApiVersionReader = ApiVersionReader.Combine(new QueryStringApiVersionReader(), new HeaderApiVersionReader("x-api-version")); o.ReportApiVersions = true; })
 *   [ApiVersion("2.0")] / [MapToApiVersion] / [Obsolete]
 *
 *   master.useApiVersioning({ defaultVersion: '1.0', assumeDefaultWhenUnspecified: true,
 *       readers: ['query:api-version', 'header:x-api-version', 'media-type:v', 'url-segment'], reportApiVersions: true })
 *   router.route('/items', 'itemsV1#index', 'get', { apiVersion: '1.0' });
 *   router.route('/items', 'itemsV2#index', 'get', { apiVersion: ['2.0', '3.0'], deprecated: ['2.0'] });
 *   router.route('/v:version/items', 'items#index', 'get')   // url-segment reader fills ctx.apiVersion from :version
 *
 * The requested version is resolved once per request into ctx.apiVersion (+ ctx.apiVersionSource).
 * A versioned route matches only when its version list contains the requested version; when a
 * path matches but no route serves the version, the router answers 400 "Unsupported API version"
 * (ProblemDetails) with `api-supported-versions`. With reportApiVersions every response of a
 * versioned route carries `api-supported-versions` / `api-deprecated-versions`.
 */

export function parseVersion(v) {
    if (v === undefined || v === null) return null;
    const s = String(v).trim().replace(/^v/i, '');
    if (!/^\d+(\.\d+)?(-[A-Za-z0-9.]+)?$/.test(s)) return null;
    const [main, status] = s.split('-');
    const [major, minor = '0'] = main.split('.');
    return { major: Number(major), minor: Number(minor), status: status || null, text: `${Number(major)}.${Number(minor)}${status ? '-' + status : ''}` };
}
export function normalizeVersion(v) { const p = parseVersion(v); return p ? p.text : null; }
export function compareVersions(a, b) {
    const pa = parseVersion(a), pb = parseVersion(b);
    if (!pa || !pb) return 0;
    return pa.major - pb.major || pa.minor - pb.minor || (pa.status === pb.status ? 0 : (pa.status ? -1 : 1));
}

export class ApiVersioning {
    constructor(options = {}) {
        this.defaultVersion = normalizeVersion(options.defaultVersion || '1.0') || '1.0';
        this.assumeDefaultWhenUnspecified = options.assumeDefaultWhenUnspecified !== false;
        this.reportApiVersions = options.reportApiVersions !== false;
        this.readers = (options.readers && options.readers.length) ? options.readers : ['query:api-version', 'header:x-api-version', 'url-segment'];
        this.urlSegmentParam = options.urlSegmentParam || 'version';
        this.enabled = true;
    }

    /** Resolve the requested version from the configured readers. -> { version, source } */
    read(ctx) {
        const req = ctx.request || {};
        const headers = req.headers || {};
        const query = (ctx.requrl && ctx.requrl.query) || {};
        for (const reader of this.readers) {
            const [kind, arg] = String(reader).split(':');
            if (kind === 'query') {
                const name = arg || 'api-version';
                const v = query[name] !== undefined ? normalizeVersion(query[name]) : null;
                if (v) return { version: v, source: `query:${name}` };
                if (query[name] !== undefined) return { version: null, invalid: String(query[name]), source: `query:${name}` };
            } else if (kind === 'header') {
                const name = (arg || 'x-api-version').toLowerCase();
                if (headers[name] !== undefined) { const v = normalizeVersion(headers[name]); return v ? { version: v, source: `header:${name}` } : { version: null, invalid: String(headers[name]), source: `header:${name}` }; }
            } else if (kind === 'media-type') {
                const param = arg || 'v';
                const accept = String(headers.accept || headers['content-type'] || '');
                const m = accept.match(new RegExp(`[;,\\s]${param}=([^;,\\s]+)`));
                if (m) { const v = normalizeVersion(m[1]); return v ? { version: v, source: `media-type:${param}` } : { version: null, invalid: m[1], source: `media-type:${param}` }; }
            } else if (kind === 'url-segment') {
                // /v2/items or /v2.0/items -> first segment vN[.N]
                const seg = String(ctx.pathName || '').split('/')[0];
                const m = seg && seg.match(/^v(\d+(?:\.\d+)?)$/i);
                if (m) return { version: normalizeVersion(m[1]), source: 'url-segment' };
            }
        }
        return { version: null, source: null };
    }

    /** Pipeline middleware: sets ctx.apiVersion / ctx.apiVersionSource; 400 on a malformed version. */
    middleware() {
        const self = this;
        return async function apiVersioning(ctx, next) {
            const r = self.read(ctx);
            if (r.invalid !== undefined) {
                const body = JSON.stringify({ type: 'https://tools.ietf.org/html/rfc9110#section-15.5.1', title: 'Invalid API version', status: 400, detail: `The API version '${r.invalid}' is not valid (use major[.minor]).`, instance: ctx.request && ctx.request.url ? ctx.request.url.split('?')[0] : undefined });
                ctx.response.writeHead(400, { 'Content-Type': 'application/problem+json', 'Content-Length': Buffer.byteLength(body) });
                ctx.response.end(body);
                return;
            }
            ctx.apiVersion = r.version || (self.assumeDefaultWhenUnspecified ? self.defaultVersion : null);
            ctx.apiVersionSource = r.version ? r.source : (self.assumeDefaultWhenUnspecified ? 'default' : null);
            ctx.apiVersionRequested = !!r.version;
            await next();
        };
    }

    /** Route helper: does this route serve the requested version? (routes without apiVersion match everything) */
    routeMatches(route, ctx) {
        if (!route || route.apiVersion === undefined || route.apiVersion === null) return true;
        const versions = [].concat(route.apiVersion).map(normalizeVersion).filter(Boolean);
        if (!versions.length) return true;
        if (!ctx.apiVersion) return false;   // versioned route, but no version requested and no default assumed
        return versions.includes(ctx.apiVersion);
    }
    /** Headers to report on a versioned route's response (ReportApiVersions). */
    reportHeaders(supported, deprecated) {
        const h = {};
        if (!this.reportApiVersions) return h;
        const sup = [...new Set([].concat(supported || []).map(normalizeVersion).filter(Boolean))].sort(compareVersions);
        const dep = [...new Set([].concat(deprecated || []).map(normalizeVersion).filter(Boolean))].sort(compareVersions);
        if (sup.length) h['api-supported-versions'] = sup.join(', ');
        if (dep.length) h['api-deprecated-versions'] = dep.join(', ');
        return h;
    }
    /** 400 for "path exists, version not served" (ASP.NET: 400 UnsupportedApiVersion). */
    writeUnsupported(ctx, supported) {
        const res = ctx.response;
        if (!res || res.headersSent) return;
        const sup = [...new Set([].concat(supported || []).map(normalizeVersion).filter(Boolean))].sort(compareVersions);
        const body = JSON.stringify({ type: 'https://tools.ietf.org/html/rfc9110#section-15.5.1', title: 'Unsupported API version', status: 400, detail: `The HTTP resource that matches the request URL does not support the API version '${ctx.apiVersion || '(none)'}'.`, instance: ctx.request && ctx.request.url ? ctx.request.url.split('?')[0] : undefined, supportedVersions: sup });
        res.writeHead(400, { 'Content-Type': 'application/problem+json', 'Content-Length': Buffer.byteLength(body), ...(sup.length ? { 'api-supported-versions': sup.join(', ') } : {}) });
        res.end(body);
    }
}

export default ApiVersioning;
