/**
 * MasterTesting — an integration-test client modeled on ASP.NET Core's
 * WebApplicationFactory / TestServer: boot the app once, send requests through
 * the real pipeline, keep cookies between calls, attach bearer tokens, read JSON.
 *
 *   const client = await master.createTestClient({ root: __dirname, app: 'app' });
 *   const res = await client.post('/login', { body: { user: 'ann', pw: 'x' } });   // JSON body, cookies remembered
 *   const me = await client.get('/me');  me.status; await me.json();
 *   await client.close();
 *
 * The server listens on 127.0.0.1 with an ephemeral port (no fixed ports, no
 * network exposure); `client.baseUrl` is available for raw fetches.
 */
import http from 'node:http';

class TestResponse {
    constructor(res, text) { this.status = res.status; this.ok = res.ok; this.headers = res.headers; this.text = text; this._json = undefined; }
    json() { if (this._json === undefined) { try { this._json = JSON.parse(this.text); } catch (_) { this._json = null; } } return this._json; }
    header(name) { return this.headers.get(name); }
}

export class TestClient {
    constructor(baseUrl, { defaults = {}, jar = new Map(), closer = null } = {}) {
        this.baseUrl = baseUrl;
        this._defaults = defaults;     // default headers
        this._jar = jar;               // cookie name -> value (shared across with* clients)
        this._closer = closer;
    }
    /** New client sharing the cookie jar with extra default headers. */
    withHeaders(headers) { return new TestClient(this.baseUrl, { defaults: { ...this._defaults, ...headers }, jar: this._jar, closer: this._closer }); }
    withBearer(token) { return this.withHeaders({ authorization: `Bearer ${token}` }); }
    withCookie(name, value) { this._jar.set(name, value); return this; }
    get cookies() { return Object.fromEntries(this._jar); }
    clearCookies() { this._jar.clear(); return this; }

    async request(method, path, { headers = {}, body, query, json = true, redirect = 'manual' } = {}) {
        let url = this.baseUrl + (path.startsWith('/') ? path : '/' + path);
        if (query && typeof query === 'object') {
            const qs = Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
            if (qs) url += (url.includes('?') ? '&' : '?') + qs;
        }
        const h = { ...this._defaults, ...headers };
        if (this._jar.size && !h.cookie) h.cookie = [...this._jar].map(([k, v]) => `${k}=${v}`).join('; ');
        let payload = body;
        if (body !== undefined && body !== null && typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof URLSearchParams)) {
            payload = JSON.stringify(body);
            if (!h['content-type']) h['content-type'] = 'application/json';
        }
        if (json && !h.accept) h.accept = 'application/json';
        const res = await fetch(url, { method: method.toUpperCase(), headers: h, body: payload, redirect });
        const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
        for (const sc of setCookies) {
            const [pair, ...attrs] = sc.split(';');
            const i = pair.indexOf('=');
            if (i <= 0) continue;
            const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim();
            const expired = attrs.some(a => /^\s*max-age=0\s*$/i.test(a)) || attrs.some(a => /^\s*expires=/i.test(a) && new Date(a.split('=')[1]) < new Date());
            if (expired || value === '') this._jar.delete(name); else this._jar.set(name, value);
        }
        const text = await res.text();
        return new TestResponse(res, text);
    }
    get(path, opts) { return this.request('GET', path, opts); }
    post(path, opts) { return this.request('POST', path, opts); }
    put(path, opts) { return this.request('PUT', path, opts); }
    patch(path, opts) { return this.request('PATCH', path, opts); }
    delete(path, opts) { return this.request('DELETE', path, opts); }
    head(path, opts) { return this.request('HEAD', path, opts); }
    async close() { if (this._closer) await this._closer(); }
}

/**
 * Boot `master` for tests (setupServer → startMVC(app) → start → listen on an
 * ephemeral port) and return a TestClient. Idempotent on an already-started master.
 * @param {Object} master  the MasterControl instance (default export or new MasterControl())
 * @param {{root?:string, app?:string|false, environment?:string, configure?:(master, server)=>any}} [opts]
 */
export async function createTestClient(master, { root, app = 'app', environment = 'test', configure } = {}) {
    if (root) master.root = root;
    if (environment && !master.environmentType) master.environmentType = environment;
    let server = master.server;
    if (!server) {
        server = master.setupServer('http');
        if (typeof configure === 'function') await configure(master, server);
        if (app && master.root) await master.startMVC(app);
        await master.start(server);
    }
    if (!server.listening) await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const addr = server.address();
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const closer = () => new Promise((resolve) => { try { server.close(() => resolve()); } catch (_) { resolve(); } });
    return new TestClient(baseUrl, { closer });
}

/** Boot a throwaway app from an in-memory routes/controllers definition (minimal APIs) — handy for unit-style tests. */
export async function createTestHost(master, configure) {
    return createTestClient(master, { app: false, configure });
}

export default { TestClient, createTestClient, createTestHost };
