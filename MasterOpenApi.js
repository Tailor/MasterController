/**
 * MasterOpenApi — OpenAPI 3.1 document generation + optional UI, modeled on
 * ASP.NET Core's built-in OpenAPI (`AddOpenApi()/MapOpenApi()`) and Swagger UI:
 *
 *   master.useOpenApi({ path: '/openapi.json', ui: '/docs', title, version, description, servers, tags })
 *
 * The document is derived from what the app already declares — no duplicate
 * annotations needed:
 *   - routes (router.route / resources) -> paths + operations, typed constraints (:id(int)) -> path parameter schemas
 *   - controller `static schemas` (2.4.0)  -> requestBody / query / header parameters (JSON Schema), 400 ValidationProblemDetails
 *   - controller/route `authorize` (2.3.0) -> security requirements + 401/403; master.auth schemes -> securitySchemes
 *   - controller `static openapi = { action: { summary, description, tags, responses, deprecated, operationId } }` -> extra metadata
 *   - `static outputCache` -> x-output-cache extension
 */

const PROBLEM_SCHEMA = {
    type: 'object',
    properties: { type: { type: 'string' }, title: { type: 'string' }, status: { type: 'integer' }, detail: { type: 'string' }, instance: { type: 'string' } },
};
const VALIDATION_PROBLEM_SCHEMA = {
    allOf: [{ $ref: '#/components/schemas/ProblemDetails' }, { type: 'object', properties: { errors: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } } } }],
};

/** masterrecord/MasterController validation rule -> JSON Schema */
export function ruleToJsonSchema(rule) {
    if (typeof rule === 'string') rule = { type: rule.replace(/!$/, ''), required: rule.endsWith('!') };
    if (typeof rule === 'function') rule = { type: 'any' };
    const r = rule || {};
    const type = r.type || (r.enum ? 'any' : r.properties ? 'object' : r.items ? 'array' : 'string');
    let s;
    switch (type) {
        case 'string': s = { type: 'string' }; if (r.minLength !== undefined) s.minLength = r.minLength; if (r.maxLength !== undefined) s.maxLength = r.maxLength; if (r.pattern) s.pattern = r.pattern instanceof RegExp ? r.pattern.source : String(r.pattern); break;
        case 'email': s = { type: 'string', format: 'email' }; break;
        case 'url': s = { type: 'string', format: 'uri' }; break;
        case 'uuid': s = { type: 'string', format: 'uuid' }; break;
        case 'date': s = { type: 'string', format: 'date' }; break;
        case 'datetime': s = { type: 'string', format: 'date-time' }; break;
        case 'number': s = { type: 'number' }; if (r.min !== undefined) s.minimum = r.min; if (r.max !== undefined) s.maximum = r.max; break;
        case 'integer': s = { type: 'integer' }; if (r.min !== undefined) s.minimum = r.min; if (r.max !== undefined) s.maximum = r.max; break;
        case 'boolean': s = { type: 'boolean' }; break;
        case 'array': s = { type: 'array', items: r.items ? ruleToJsonSchema(r.items) : {} }; if (r.minLength !== undefined) s.minItems = r.minLength; if (r.maxLength !== undefined) s.maxItems = r.maxLength; break;
        case 'object': s = schemaToJsonSchema(r.properties || {}); break;
        default: s = {};
    }
    if (r.enum) s.enum = [].concat(r.enum);
    if (r.default !== undefined && typeof r.default !== 'function') s.default = r.default;
    if (r.nullable) s.nullable = true;
    if (r.description) s.description = r.description;
    return s;
}

/** { field: rule } (or JSON-Schema-like object form) -> JSON Schema object */
export function schemaToJsonSchema(schema) {
    if (!schema || typeof schema !== 'object') return { type: 'object' };
    let fields = schema, requiredList = [];
    if (schema.type === 'object' && schema.properties) { fields = schema.properties; requiredList = Array.isArray(schema.required) ? schema.required : []; }
    const out = { type: 'object', properties: {}, required: [] };
    for (const [name, rule] of Object.entries(fields)) {
        if (name === '__allowUnknown') continue;
        out.properties[name] = ruleToJsonSchema(rule);
        const req = (typeof rule === 'string' && rule.endsWith('!')) || (rule && typeof rule === 'object' && rule.required) || requiredList.includes(name);
        if (req) out.required.push(name);
    }
    if (!out.required.length) delete out.required;
    return out;
}

const CONSTRAINT_SCHEMAS = {
    int: { type: 'integer' }, number: { type: 'number' }, double: { type: 'number' }, float: { type: 'number' },
    bool: { type: 'boolean' }, uuid: { type: 'string', format: 'uuid' }, guid: { type: 'string', format: 'uuid' },
    alpha: { type: 'string', pattern: '^[A-Za-z]+$' }, alphanum: { type: 'string', pattern: '^[A-Za-z0-9]+$' }, slug: { type: 'string', pattern: '^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$' },
};
function paramSchema(constraint) {
    if (!constraint) return { type: 'string' };
    const lower = constraint.toLowerCase();
    if (CONSTRAINT_SCHEMAS[lower]) return { ...CONSTRAINT_SCHEMAS[lower] };
    let m;
    if ((m = lower.match(/^length\((\d+)\)$/))) return { type: 'string', minLength: +m[1], maxLength: +m[1] };
    if ((m = lower.match(/^minlength\((\d+)\)$/))) return { type: 'string', minLength: +m[1] };
    if ((m = lower.match(/^maxlength\((\d+)\)$/))) return { type: 'string', maxLength: +m[1] };
    if ((m = lower.match(/^min\((-?\d+)\)$/))) return { type: 'integer', minimum: +m[1] };
    if ((m = lower.match(/^max\((-?\d+)\)$/))) return { type: 'integer', maximum: +m[1] };
    if ((m = constraint.match(/^regex:(.+)$/s))) return { type: 'string', pattern: m[1] };
    return { type: 'string' };
}

/** 'items/:id(int)/edit' -> { path: '/items/{id}/edit', params: [{ name, schema }] } */
export function routePathToOpenApi(routePath) {
    const params = [];
    const segs = String(routePath).replace(/^\/|\/$/g, '').split('/').map((seg) => {
        const m = seg.match(/^:([A-Za-z_$][\w$]*)(?:\((.+)\))?$/);
        if (!m) return seg;
        params.push({ name: m[1], schema: paramSchema(m[2]) });
        return `{${m[1]}}`;
    });
    return { path: '/' + segs.join('/'), params };
}

export class OpenApiGenerator {
    constructor(master, options = {}) {
        this.master = master;
        this.options = {
            title: options.title || 'MasterController API',
            version: options.version || '1.0.0',
            description: options.description,
            servers: options.servers,
            tags: options.tags,
            includeProblemDetails: options.includeProblemDetails !== false,
            filter: typeof options.filter === 'function' ? options.filter : null,   // (routeInfo) => boolean
            transform: typeof options.transform === 'function' ? options.transform : null, // (document) => document
            contact: options.contact, license: options.license, externalDocs: options.externalDocs,
        };
    }

    _controllerFor(root, name) {
        try { return this.master.router && typeof this.master.router._resolveController === 'function' ? this.master.router._resolveController(root, name) : null; } catch (_) { return null; }
    }

    _securityFor(spec, Control, action, schemesOut) {
        if (!this.master.auth) return null;
        // route-level wins; else controller static authorize; allowAnonymous -> none
        let authorize = spec && spec.authorize;
        if ((authorize === undefined || authorize === null) && !(spec && spec.allowAnonymous) && Control) {
            const anon = Control.allowAnonymous;
            if (!(anon === true || (Array.isArray(anon) && anon.includes(action)))) {
                const s = Control.authorize;
                const REQ = ['policy', 'roles', 'claims', 'schemes', 'requireAuthenticated', 'handler', 'allowAnonymous'];
                if (s && typeof s === 'object' && !Array.isArray(s) && !REQ.some(k => k in s)) authorize = (action in s) ? s[action] : s['*'];
                else authorize = s;
            }
        }
        if (!authorize || authorize === 'anonymous') return null;
        const schemes = (typeof authorize === 'object' && authorize.schemes) ? [].concat(authorize.schemes) : (this.master.auth.defaultScheme ? [this.master.auth.defaultScheme] : []);
        for (const s of schemes) schemesOut.add(s);
        const scopes = [];
        if (typeof authorize === 'object' && authorize.roles) scopes.push(...[].concat(authorize.roles).map(r => `role:${r}`));
        if (typeof authorize === 'string') scopes.push(`policy:${authorize}`);
        if (typeof authorize === 'object' && authorize.policy) scopes.push(...[].concat(authorize.policy).map(p => `policy:${p}`));
        return schemes.length ? schemes.map(s => ({ [s]: scopes })) : [{}];
    }

    _securitySchemes(used) {
        const out = {};
        if (!this.master.auth) return out;
        for (const name of this.master.auth.schemes) {
            if (used.size && !used.has(name)) continue;
            const s = this.master.auth._schemes.get(name);
            if (!s) continue;
            if (s.type === 'bearer') out[name] = { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' };
            else if (s.type === 'cookie') out[name] = { type: 'apiKey', in: 'cookie', name: s.cookieName };
            else out[name] = { type: 'apiKey', in: 'header', name: s.headerName || 'X-API-Key', description: 'custom scheme' };
        }
        return out;
    }

    build() {
        const master = this.master;
        const doc = {
            openapi: '3.1.0',
            info: { title: this.options.title, version: this.options.version, ...(this.options.description ? { description: this.options.description } : {}), ...(this.options.contact ? { contact: this.options.contact } : {}), ...(this.options.license ? { license: this.options.license } : {}) },
            ...(this.options.servers ? { servers: this.options.servers } : {}),
            paths: {},
            components: { schemas: {}, securitySchemes: {} },
            ...(this.options.tags ? { tags: this.options.tags } : {}),
            ...(this.options.externalDocs ? { externalDocs: this.options.externalDocs } : {}),
        };
        if (this.options.includeProblemDetails) { doc.components.schemas.ProblemDetails = PROBLEM_SCHEMA; doc.components.schemas.ValidationProblemDetails = VALIDATION_PROBLEM_SCHEMA; }
        const usedSchemes = new Set();
        const groups = (master.router && master.router._routes) || {};
        for (const g of Object.values(groups)) {
            for (const route of (g.routes || [])) {
                const Control = this._controllerFor(g.root, route.toController);
                const info = { route, controller: route.toController, action: route.toAction, Control };
                if (this.options.filter && !this.options.filter(info)) continue;
                const { path, params } = routePathToOpenApi(route.path);
                const method = String(route.type).toLowerCase();
                if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) continue;
                const meta = (Control && Control.openapi && (Control.openapi[route.toAction] || Control.openapi['*'])) || {};
                const op = {
                    operationId: meta.operationId || `${route.toController}_${route.toAction}`,
                    tags: meta.tags || [route.toController],
                    ...(meta.summary ? { summary: meta.summary } : {}),
                    ...(meta.description ? { description: meta.description } : {}),
                    ...(meta.deprecated ? { deprecated: true } : {}),
                    parameters: params.map(p => ({ name: p.name, in: 'path', required: true, schema: p.schema })),
                    responses: {},
                };
                // model binding schemas -> parameters / requestBody
                const schemas = Control && Control.schemas && (Control.schemas[route.toAction] || Control.schemas['*']);
                if (schemas && typeof schemas === 'object') {
                    const SOURCE_KEYS = ['body', 'form', 'query', 'route', 'files', 'headers'];
                    const perSource = Object.keys(schemas).some(k => SOURCE_KEYS.includes(k)) ? schemas : (['post', 'put', 'patch'].includes(method) ? { body: schemas } : { query: schemas });
                    const addParams = (src, where) => {
                        const js = schemaToJsonSchema(src);
                        for (const [name, sch] of Object.entries(js.properties || {})) {
                            if (where === 'path' && op.parameters.some(p => p.name === name)) { const p = op.parameters.find(x => x.name === name); p.schema = sch; continue; }
                            op.parameters.push({ name, in: where, required: (js.required || []).includes(name), schema: sch });
                        }
                    };
                    if (perSource.query) addParams(perSource.query, 'query');
                    if (perSource.headers) addParams(perSource.headers, 'header');
                    if (perSource.route) addParams(perSource.route, 'path');
                    if (perSource.body || perSource.form) {
                        const js = schemaToJsonSchema(perSource.body || perSource.form);
                        const ct = perSource.form ? 'application/x-www-form-urlencoded' : 'application/json';
                        op.requestBody = { required: true, content: { [ct]: { schema: js } } };
                    }
                    if (this.options.includeProblemDetails) op.responses['400'] = { description: 'Validation failed', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/ValidationProblemDetails' } } } };
                }
                // responses
                const declared = meta.responses || {};
                for (const [code, r] of Object.entries(declared)) op.responses[String(code)] = typeof r === 'string' ? { description: r } : r;
                if (!op.responses['200'] && !op.responses['201'] && !op.responses['204']) op.responses[method === 'post' ? '201' : (method === 'delete' ? '204' : '200')] = { description: method === 'post' ? 'Created' : (method === 'delete' ? 'No Content' : 'OK') };
                // security
                const security = this._securityFor(route, Control, route.toAction, usedSchemes);
                if (security) {
                    op.security = security;
                    if (this.options.includeProblemDetails) {
                        op.responses['401'] = op.responses['401'] || { description: 'Unauthorized', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } } } };
                        op.responses['403'] = op.responses['403'] || { description: 'Forbidden', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } } } };
                    }
                } else if (route.allowAnonymous) op.security = [];
                const oc = route.outputCache !== undefined ? route.outputCache : (Control && Control.outputCache && (Control.outputCache[route.toAction] || Control.outputCache['*']));
                if (oc) op['x-output-cache'] = oc;
                if (!op.parameters.length) delete op.parameters;
                doc.paths[path] = doc.paths[path] || {};
                doc.paths[path][method] = op;
            }
        }
        doc.components.securitySchemes = this._securitySchemes(usedSchemes);
        if (!Object.keys(doc.components.securitySchemes).length) delete doc.components.securitySchemes;
        return this.options.transform ? (this.options.transform(doc) || doc) : doc;
    }
}

/** Minimal interactive UI (Swagger UI loaded from a CDN in the browser — no server dependency). */
export function swaggerUiHtml(specUrl, { title = 'API docs', cdn = 'https://unpkg.com/swagger-ui-dist@5' } = {}) {
    const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><link rel="stylesheet" href="${esc(cdn)}/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="${esc(cdn)}/swagger-ui-bundle.js" crossorigin></script><script>window.ui = SwaggerUIBundle({ url: ${JSON.stringify(specUrl)}, dom_id: '#swagger-ui', deepLinking: true });</script></body></html>`;
}

/** Pipeline middleware serving the document (and optionally the UI). */
export function openApiMiddleware(master, options = {}) {
    const jsonPath = (options.path || '/openapi.json').replace(/\/+$/, '') || '/openapi.json';
    const uiPath = options.ui === true ? '/docs' : (typeof options.ui === 'string' ? options.ui.replace(/\/+$/, '') : null);
    const generator = new OpenApiGenerator(master, options);
    let cached = null;
    const cacheMs = options.cacheMs === undefined ? (master.environmentType === 'production' ? 60_000 : 0) : options.cacheMs;
    master.openApi = { generator, invalidate: () => { cached = null; }, document: () => generator.build() };
    return async function openApi(ctx, next) {
        const p = '/' + String(ctx.pathName || '').replace(/^\/|\/$/g, '');
        if (ctx.type === 'get' && p === jsonPath) {
            if (!cached || (cacheMs && Date.now() - cached.at > cacheMs) || !cacheMs) cached = { at: Date.now(), body: JSON.stringify(generator.build(), null, 2) };
            ctx.response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
            ctx.response.end(cached.body);
            return;
        }
        if (uiPath && ctx.type === 'get' && p === uiPath) {
            ctx.response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
            ctx.response.end(swaggerUiHtml(jsonPath, { title: options.title || 'API docs', cdn: options.cdn }));
            return;
        }
        await next();
    };
}

export default OpenApiGenerator;
