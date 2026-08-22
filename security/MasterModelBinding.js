/**
 * MasterModelBinding — model binding, validation, ProblemDetails and typed
 * action results, modeled on ASP.NET Core:
 *
 *   ASP.NET Core                                   MasterController
 *   [FromBody]/[FromQuery]/[FromRoute]/[FromForm]  static schemas = { create: { body: {...}, query: {...}, route: {...} } }
 *   DataAnnotations ([Required], [Range], ...)     rule: { type, required, min, max, minLength, maxLength, pattern, enum, items, properties, custom }
 *   ModelState.IsValid / [ApiController] auto-400  this.modelState.isValid; invalid -> 400 ValidationProblemDetails (static autoValidate = false to opt out)
 *   bound parameter                                this.model (route + query + body merged, coerced, unknown fields stripped)
 *   ProblemDetails / ValidationProblemDetails      this.problem({...}) / this.validationProblem(errors)  (application/problem+json, RFC 7807)
 *   Ok/Created/NoContent/NotFound/File/...         this.ok() / created() / accepted() / noContent() / notFound() / conflict() / file() ...
 *   route constraints {id:int}                     '/users/:id(int)'  (int, number, bool, uuid, alpha, alphanum, slug, length(n), min(n), max(n), regex(...))
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import toolClass from '../MasterTools.js';

const tools = new toolClass();

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KNOWN_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'email', 'url', 'uuid', 'date', 'datetime', 'array', 'object', 'any']);

/** Normalize a schema into { fields: { name: rule }, allowUnknown } — accepts { field: rule } or { type:'object', properties, required:[] }. */
function normalizeSchema(schema) {
    if (!schema || typeof schema !== 'object') throw new TypeError('validation schema must be an object');
    let fields = schema;
    let requiredList = [];
    let allowUnknown = false;
    if (schema.type === 'object' && schema.properties && typeof schema.properties === 'object') {
        fields = schema.properties;
        requiredList = Array.isArray(schema.required) ? schema.required : [];
        allowUnknown = schema.additionalProperties === true;
    }
    const out = {};
    for (const [name, raw] of Object.entries(fields)) {
        if (name === '__allowUnknown') { allowUnknown = !!raw; continue; }
        let rule = raw;
        if (typeof raw === 'string') {                      // shorthand: 'string' | 'integer!' (required)
            rule = { type: raw.replace(/!$/, ''), required: raw.endsWith('!') };
        } else if (typeof raw === 'function') {             // shorthand: custom validator
            rule = { type: 'any', custom: raw };
        } else if (!raw || typeof raw !== 'object') {
            throw new TypeError(`validation rule for '${name}' must be an object, a type string or a function`);
        }
        rule = { ...rule };
        if (!rule.type) rule.type = rule.enum ? 'any' : (rule.properties ? 'object' : (rule.items ? 'array' : 'string'));
        if (!KNOWN_TYPES.has(rule.type)) throw new TypeError(`validation rule for '${name}': unknown type '${rule.type}'`);
        if (requiredList.includes(name)) rule.required = true;
        out[name] = rule;
    }
    return { fields: out, allowUnknown };
}

function isMissing(v) { return v === undefined || v === null || (typeof v === 'string' && v.trim() === ''); }

/** Coerce + check one value against a rule. Returns { value, errors: [] }. */
async function checkValue(value, rule, fieldPath, model) {
    const errors = [];
    const msg = (text) => errors.push(rule.message || text);
    const coerce = rule.coerce !== false;
    let v = value;
    switch (rule.type) {
        case 'string':
            if (typeof v !== 'string') { if (coerce && (typeof v === 'number' || typeof v === 'boolean')) v = String(v); else { msg(`${fieldPath} must be a string`); break; } }
            if (rule.trim !== false) v = v.trim();
            if (rule.minLength !== undefined && v.length < rule.minLength) msg(`${fieldPath} must be at least ${rule.minLength} characters`);
            if (rule.maxLength !== undefined && v.length > rule.maxLength) msg(`${fieldPath} must be at most ${rule.maxLength} characters`);
            if (rule.pattern) { const re = rule.pattern instanceof RegExp ? rule.pattern : new RegExp(rule.pattern); if (!re.test(v)) msg(`${fieldPath} has an invalid format`); }
            break;
        case 'email':
            if (typeof v !== 'string' || !EMAIL_RE.test(v.trim())) { msg(`${fieldPath} must be a valid email address`); break; }
            v = v.trim().toLowerCase();
            break;
        case 'url':
            try { const u = new URL(String(v)); if (!/^https?:$/.test(u.protocol) && !(rule.protocols || []).includes(u.protocol.replace(':', ''))) throw new Error(); v = String(v).trim(); }
            catch (_) { msg(`${fieldPath} must be a valid URL`); }
            break;
        case 'uuid':
            if (typeof v !== 'string' || !UUID_RE.test(v)) msg(`${fieldPath} must be a valid UUID`); else v = v.toLowerCase();
            break;
        case 'number':
        case 'integer': {
            if (typeof v === 'string' && coerce && v.trim() !== '') v = Number(v);
            if (typeof v !== 'number' || Number.isNaN(v) || !Number.isFinite(v)) { msg(`${fieldPath} must be a number`); break; }
            if (rule.type === 'integer' && !Number.isInteger(v)) { msg(`${fieldPath} must be an integer`); break; }
            if (rule.min !== undefined && v < rule.min) msg(`${fieldPath} must be at least ${rule.min}`);
            if (rule.max !== undefined && v > rule.max) msg(`${fieldPath} must be at most ${rule.max}`);
            break;
        }
        case 'boolean':
            if (typeof v !== 'boolean') {
                if (coerce && (typeof v === 'string' || typeof v === 'number')) {
                    const s = String(v).toLowerCase();
                    if (['true', '1', 'yes', 'on'].includes(s)) v = true; else if (['false', '0', 'no', 'off'].includes(s)) v = false; else msg(`${fieldPath} must be a boolean`);
                } else msg(`${fieldPath} must be a boolean`);
            }
            break;
        case 'date':
        case 'datetime': {
            const d = v instanceof Date ? v : new Date(v);
            if (Number.isNaN(d.getTime())) { msg(`${fieldPath} must be a valid date`); break; }
            v = d;
            if (rule.min !== undefined && d < new Date(rule.min)) msg(`${fieldPath} must not be before ${new Date(rule.min).toISOString()}`);
            if (rule.max !== undefined && d > new Date(rule.max)) msg(`${fieldPath} must not be after ${new Date(rule.max).toISOString()}`);
            break;
        }
        case 'array': {
            if (typeof v === 'string' && coerce) v = v.split(',').map(s => s.trim()).filter(s => s !== '');
            if (!Array.isArray(v)) { msg(`${fieldPath} must be an array`); break; }
            if (rule.minLength !== undefined && v.length < rule.minLength) msg(`${fieldPath} must have at least ${rule.minLength} items`);
            if (rule.maxLength !== undefined && v.length > rule.maxLength) msg(`${fieldPath} must have at most ${rule.maxLength} items`);
            if (rule.items) {
                const itemRule = typeof rule.items === 'string' ? { type: rule.items } : rule.items;
                const out = [];
                for (let i = 0; i < v.length; i++) {
                    const r = await checkValue(v[i], { type: 'string', ...itemRule }, `${fieldPath}[${i}]`, model);
                    errors.push(...r.errors); out.push(r.value);
                }
                v = out;
            }
            break;
        }
        case 'object': {
            if (!v || typeof v !== 'object' || Array.isArray(v)) { msg(`${fieldPath} must be an object`); break; }
            if (rule.properties) {
                const nested = await validate(v, { ...rule.properties, __allowUnknown: !!rule.allowUnknown }, { pathPrefix: `${fieldPath}.` });
                for (const [k, msgs] of Object.entries(nested.errors)) errors.push(...msgs.map(m => ({ field: k, message: m })));
                v = nested.value;
            }
            break;
        }
        case 'any':
        default:
            break;
    }
    if (rule.enum && !errors.length) {
        const allowed = [].concat(rule.enum);
        if (!allowed.some(a => a === v || (typeof a === 'number' && Number(v) === a))) msg(`${fieldPath} must be one of: ${allowed.join(', ')}`);
    }
    if (typeof rule.custom === 'function' && !errors.length) {
        const r = await rule.custom(v, model, fieldPath);
        if (r === false) msg(`${fieldPath} is invalid`);
        else if (typeof r === 'string' && r) errors.push(r);
        else if (r && typeof r === 'object' && r.message) errors.push(r.message);
    }
    return { value: v, errors };
}

/**
 * Validate + coerce `data` against `schema`.
 * @returns {Promise<{valid:boolean, value:Object, errors:Object<string,string[]>}>}
 *          errors are keyed by field path ("address.city") like ASP.NET ModelState.
 */
export async function validate(data, schema, opts = {}) {
    const { fields, allowUnknown } = normalizeSchema(schema);
    const src = (data && typeof data === 'object') ? data : {};
    const value = {};
    const errors = {};
    const prefix = opts.pathPrefix || '';
    const add = (field, messages) => { if (!messages.length) return; (errors[field] = errors[field] || []).push(...messages); };
    for (const [name, rule] of Object.entries(fields)) {
        const fieldPath = prefix + name;
        let raw = src[name];
        if (isMissing(raw) && rule.default !== undefined) raw = typeof rule.default === 'function' ? rule.default() : rule.default;
        if (isMissing(raw)) {
            if (rule.required) add(fieldPath, [rule.message || `${fieldPath} is required`]);
            else if (raw === null && rule.nullable !== false) value[name] = null;
            continue;
        }
        const r = await checkValue(raw, rule, fieldPath, src);
        const plain = [], nested = [];
        for (const e of r.errors) (typeof e === 'string' ? plain : nested).push(e);
        add(fieldPath, plain);
        for (const n of nested) add(n.field, [n.message]);
        if (!r.errors.length) value[name] = r.value;
    }
    if (allowUnknown || opts.allowUnknown) for (const k of Object.keys(src)) if (!(k in fields)) value[k] = src[k];
    return { valid: Object.keys(errors).length === 0, value, errors };
}

// ---------------------------------------------------------------------------
// Request binding (ASP.NET model binding sources) + ModelState
// ---------------------------------------------------------------------------

const SOURCE_KEYS = ['body', 'form', 'query', 'route', 'files', 'headers'];
const WRITE_METHODS = new Set(['post', 'put', 'patch']);

export function requestSources(requestObject) {
    const params = requestObject.params || {};
    const formData = params.formData || {};
    const body = (formData && typeof formData === 'object' && formData.fields && typeof formData.fields === 'object') ? formData.fields : formData;
    const route = {};
    for (const [k, v] of Object.entries(params)) if (k !== 'query' && k !== 'formData') route[k] = v;
    const query = params.query || (requestObject.requrl && requestObject.requrl.query) || {};
    const headers = (requestObject.request && requestObject.request.headers) || {};
    return { body: body || {}, form: body || {}, query, route, files: (formData && formData.files) || {}, headers };
}

export class ModelState {
    constructor(errors = {}) { this.errors = {}; for (const [k, v] of Object.entries(errors)) this.errors[k] = [...v]; }
    get isValid() { return Object.keys(this.errors).length === 0; }
    addError(field, message) { (this.errors[field] = this.errors[field] || []).push(message); return this; }
    getErrors(field) { return this.errors[field] || []; }
    toJSON() { return { isValid: this.isValid, errors: this.errors }; }
}

/**
 * Bind and validate a request against a spec:
 *   { body?: schema, query?: schema, route?: schema, form?: schema, files?: schema, headers?: schema }
 *   or a bare schema (= body for POST/PUT/PATCH, query otherwise).
 * @returns {Promise<{valid, value, errors, modelState, sources:{body,query,route,...}}>}
 */
export async function bindRequest(requestObject, spec, opts = {}) {
    if (!spec || typeof spec !== 'object') throw new TypeError('bindRequest: spec must be an object');
    const perSource = Object.keys(spec).some(k => SOURCE_KEYS.includes(k)) ? spec : null;
    const method = String(requestObject.type || (requestObject.request && requestObject.request.method) || 'get').toLowerCase();
    const normalized = perSource || (WRITE_METHODS.has(method) ? { body: spec } : { query: spec });
    const sources = requestSources(requestObject);
    const value = {}, errors = {}, bound = {};
    for (const key of ['route', 'query', 'headers', 'form', 'body', 'files']) {
        if (!normalized[key]) continue;
        const r = await validate(sources[key], normalized[key], { allowUnknown: opts.allowUnknown });
        bound[key] = r.value;
        Object.assign(value, r.value);
        for (const [f, msgs] of Object.entries(r.errors)) (errors[f] = errors[f] || []).push(...msgs);
    }
    const modelState = new ModelState(errors);
    return { valid: modelState.isValid, value, errors, modelState, sources: bound };
}

/** static schemas = { create: {...}, update: {...}, '*': {...} } on a controller -> spec for action or undefined. */
export function resolveControllerSchemas(Control, action) {
    const s = Control && Control.schemas;
    if (!s || typeof s !== 'object') return undefined;
    if (action in s) return s[action] || undefined;
    if ('*' in s) return s['*'] || undefined;
    return undefined;
}

// ---------------------------------------------------------------------------
// ProblemDetails (RFC 7807 / RFC 9457)
// ---------------------------------------------------------------------------

export const PROBLEM_BASE = 'https://tools.ietf.org/html/rfc9110#section-15.';
export function problemTypeFor(status) {
    const s = Number(status);
    if (s >= 500) return `${PROBLEM_BASE}6.${s - 499}`;
    if (s >= 400) return `${PROBLEM_BASE}5.${s - 399}`;
    return 'about:blank';
}
export function wantsJson(request) {
    if (!request || !request.headers) return false;
    const h = request.headers;
    if (h['x-requested-with'] === 'XMLHttpRequest') return true;
    const ct = String(h['content-type'] || '');
    const accept = String(h.accept || '');
    if (/application\/(json|problem\+json)/i.test(accept) && !/text\/html/i.test(accept)) return true;
    if (!accept || accept === '*/*') return /application\/json/i.test(ct) || !!h.authorization;
    return false;
}

/** Write an RFC 7807 response. `problem`: { status, title, detail, type, instance, ...extensions } */
export function writeProblem(response, problem = {}, { headers = {}, request } = {}) {
    if (!response || response.headersSent || response._headerSent) return false;
    const status = Number(problem.status) || 500;
    const body = {
        type: problem.type || problemTypeFor(status),
        title: problem.title || http.STATUS_CODES[status] || 'Error',
        status,
        ...(problem.detail !== undefined ? { detail: problem.detail } : {}),
        ...(problem.instance !== undefined ? { instance: problem.instance } : (request && request.url ? { instance: String(request.url).split('?')[0] } : {})),
    };
    for (const [k, v] of Object.entries(problem)) if (!['type', 'title', 'status', 'detail', 'instance'].includes(k) && v !== undefined) body[k] = v;
    const json = JSON.stringify(body);
    response.writeHead(status, { 'Content-Type': 'application/problem+json', 'Content-Length': Buffer.byteLength(json), 'Cache-Control': 'no-store', ...headers });
    response.end(json);
    return true;
}
/** 400 ValidationProblemDetails: { title: 'One or more validation errors occurred.', status: 400, errors: { field: [msgs] } } */
export function writeValidationProblem(response, errors, { request, title, detail, status = 400 } = {}) {
    return writeProblem(response, { status, title: title || 'One or more validation errors occurred.', detail, errors }, { request });
}

// ---------------------------------------------------------------------------
// Controller mixin: typed results (ControllerBase) + bind/validate
// ---------------------------------------------------------------------------

export class MasterResults {
    static bindMaster(master) { MasterResults.__master = master; }
    _res() { return this.__response || (this.__requestObject && this.__requestObject.response); }
    _req() { return this.__request || (this.__requestObject && this.__requestObject.request); }
    _sendJson(status, data, headers = {}) {
        const res = this._res();
        if (!res || res.headersSent || res._headerSent) return;
        if (data === undefined || data === null) { res.writeHead(status, headers); res.end(); return; }
        const json = JSON.stringify(data);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json), ...headers });
        res.end(json);
    }
    /** 200 */ ok(data) { this._sendJson(200, data === undefined ? {} : data); }
    /** 201 + Location */ created(location, data) { this._sendJson(201, data === undefined ? null : data, location ? { Location: String(location) } : {}); }
    /** 202 */ accepted(data) { this._sendJson(202, data === undefined ? null : data); }
    /** 204 */ noContent() { const res = this._res(); if (res && !res.headersSent && !res._headerSent) { res.writeHead(204); res.end(); } }
    /** Any status with optional JSON body. */ statusCode(code, body) { this._sendJson(code, body === undefined ? null : body); }
    /** RFC 7807 */ problem(problem = {}) { return writeProblem(this._res(), problem, { request: this._req() }); }
    validationProblem(errors, opts = {}) { return writeValidationProblem(this._res(), errors instanceof ModelState ? errors.errors : errors, { request: this._req(), ...opts }); }
    badRequest(detail, extra) { return this.problem({ status: 400, detail: typeof detail === 'string' ? detail : undefined, ...(typeof detail === 'object' ? detail : {}), ...(extra || {}) }); }
    unauthorized(detail) { return this.problem({ status: 401, detail }); }
    forbidden(detail) { return this.problem({ status: 403, detail }); }
    notFound(detail) { return this.problem({ status: 404, detail }); }
    conflict(detail) { return this.problem({ status: 409, detail }); }
    unprocessable(errorsOrDetail) { return typeof errorsOrDetail === 'object' ? this.validationProblem(errorsOrDetail, { status: 422 }) : this.problem({ status: 422, detail: errorsOrDetail }); }
    /**
     * File result (ASP.NET File()): a Buffer/string body or a path to stream.
     * @param {Buffer|string} source Buffer/string content, or an absolute file path when opts.path is true or the string exists on disk
     * @param {{contentType?:string, fileName?:string, inline?:boolean, path?:boolean}} [opts]
     */
    file(source, opts = {}) {
        const res = this._res();
        if (!res || res.headersSent || res._headerSent) return;
        const disposition = (name) => `${opts.inline ? 'inline' : 'attachment'}; filename="${String(name).replace(/["\r\n]/g, '')}"`;
        const isPath = typeof source === 'string' && (opts.path === true || (path.isAbsolute(source) && fs.existsSync(source)));
        if (isPath) {
            let stat;
            try { stat = fs.statSync(source); } catch (_) { return this.notFound('File not found'); }
            if (!stat.isFile()) return this.notFound('File not found');
            const type = opts.contentType || tools._getMimeTypeFromPath(source) || 'application/octet-stream';
            const headers = { 'Content-Type': type, 'Content-Length': stat.size };
            if (opts.fileName || !opts.inline) headers['Content-Disposition'] = disposition(opts.fileName || path.basename(source));
            res.writeHead(200, headers);
            const stream = fs.createReadStream(source);
            stream.on('error', () => { try { res.destroy(); } catch (_) { /* ignore */ } });
            stream.pipe(res);
            return;
        }
        const buf = Buffer.isBuffer(source) ? source : Buffer.from(String(source));
        const headers = { 'Content-Type': opts.contentType || 'application/octet-stream', 'Content-Length': buf.length };
        if (opts.fileName) headers['Content-Disposition'] = disposition(opts.fileName);
        res.writeHead(200, headers);
        res.end(buf);
    }
    /**
     * Explicit binding inside an action: `const model = await this.bind({ body: {...} })`.
     * Sets this.model / this.modelState; on validation failure writes 400 and
     * returns null (pass { autoValidate: false } to handle this.modelState yourself).
     */
    async bind(spec, opts = {}) {
        const result = await bindRequest(this.__requestObject, spec, opts);
        this.model = result.value;
        this.modelState = result.modelState;
        if (!result.valid && opts.autoValidate !== false) { this.validationProblem(result.errors); return null; }
        return result.value;
    }
    /** Validate an arbitrary object: -> { valid, value, errors } (no response written). */
    validateModel(data, schema, opts) { return validate(data, schema, opts); }
}

export default { validate, bindRequest, requestSources, ModelState, resolveControllerSchemas, writeProblem, writeValidationProblem, wantsJson, problemTypeFor, MasterResults };
