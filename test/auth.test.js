/**
 * 2.3.0 — Authentication & authorization (ASP.NET Core parity):
 *   JWT (HS/RS/ES) sign/verify, PasswordHasher, ClaimsPrincipal, policies,
 *   enforce() -> 401/403 ProblemDetails, cookie sign-in/out, and an END-TO-END
 *   run through a real HTTP server with routes/controllers in a temp app:
 *   route-level { authorize }, controller-level static authorize/allowAnonymous,
 *   this.user / this.signIn() / this.authorize() inside actions.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AuthenticationService, ClaimsPrincipal, PasswordHasher, jwt, JwtError, resolveControllerAuthorize } from '../security/MasterAuth.js';
import { MasterControl } from '../MasterControl.js';
import masterSingleton from '../MasterControl.js';

const SECRET = 'a-very-long-test-secret-at-least-32-chars!!';

function fakeRes() {
    const headers = {};
    return {
        statusCode: 200, headersSent: false, _headerSent: false, body: null, head: null,
        getHeader(n) { return headers[n.toLowerCase()]; },
        setHeader(n, v) { headers[n.toLowerCase()] = v; },
        writeHead(code, h) { this.head = { code, headers: { ...h } }; this.statusCode = code; },
        end(b) { this.body = b; this.headersSent = true; this._headerSent = true; },
        headers,
    };
}
const fakeReq = (headers = {}, url = '/secure') => ({ request: { headers, url, method: 'GET' }, response: fakeRes(), pathName: url.slice(1), params: {} });

test('jwt: HS256 round trip, claims, expiry, audience/issuer, tampering, algorithm allow-list', () => {
    const token = jwt.sign({ sub: '42', role: ['admin'] }, SECRET, { expiresIn: '15m', issuer: 'me', audience: 'api' });
    const p = jwt.verify(token, SECRET, { issuer: 'me', audience: 'api' });
    assert.equal(p.sub, '42'); assert.deepEqual(p.role, ['admin']); assert.ok(p.exp > p.iat);
    assert.throws(() => jwt.verify(token + 'x', SECRET), (e) => e instanceof JwtError && e.code === 'bad_signature');
    assert.throws(() => jwt.verify(token, SECRET, { issuer: 'other' }), /issuer/);
    assert.throws(() => jwt.verify(token, SECRET, { audience: 'web' }), /audience/);
    assert.throws(() => jwt.verify(token, SECRET, { algorithms: ['RS256'] }), /not allowed/);
    const expired = jwt.sign({ sub: 1 }, SECRET, { expiresIn: -120 });
    assert.throws(() => jwt.verify(expired, SECRET), (e) => e.code === 'expired');
    assert.equal(jwt.verify(expired, SECRET, { ignoreExpiration: true }).sub, 1);
    assert.throws(() => jwt.sign({ a: 1 }, 'short'), /at least 32/);
    // alg=none style attack: header alg not in allow-list
    const [h, b] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') + '.' + b + '.';
    assert.throws(() => jwt.verify(forged, SECRET), /not allowed|unsupported/);
    void h;
});

test('jwt: RS256 and ES256 with node:crypto key pairs', () => {
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const t1 = jwt.sign({ sub: 'r' }, rsa.privateKey, { algorithm: 'RS256' });
    assert.equal(jwt.verify(t1, rsa.publicKey, { algorithms: ['RS256'] }).sub, 'r');
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    assert.throws(() => jwt.verify(t1, other.publicKey, { algorithms: ['RS256'] }), /signature/);
    const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const t2 = jwt.sign({ sub: 'e' }, ec.privateKey, { algorithm: 'ES256' });
    assert.equal(jwt.verify(t2, ec.publicKey, { algorithms: ['ES256'] }).sub, 'e');
    const t3 = jwt.sign({ sub: 'p' }, rsa.privateKey, { algorithm: 'PS256' });
    assert.equal(jwt.verify(t3, rsa.publicKey, { algorithms: ['PS256'] }).sub, 'p');
});

test('PasswordHasher: scrypt, salted, constant-time verify, needsRehash', async () => {
    const h = new PasswordHasher();
    const stored = await h.hash('correct horse battery staple');
    assert.match(stored, /^\$scrypt\$N=32768,r=8,p=1\$/);
    assert.notEqual(await h.hash('correct horse battery staple'), stored, 'random salt');
    assert.deepEqual(await h.verify('correct horse battery staple', stored), { valid: true, needsRehash: false });
    assert.equal((await h.verify('wrong', stored)).valid, false);
    assert.equal((await h.verify('x', 'garbage')).valid, false);
    const weak = new PasswordHasher({ N: 2 ** 10 });
    const old = await weak.hash('pw');
    assert.deepEqual(await h.verify('pw', old), { valid: true, needsRehash: true }, 'weaker stored params -> rehash');
});

test('ClaimsPrincipal: from object / claims list / JWT payload; roles, hasClaim, isInRole, anonymous', () => {
    const p = ClaimsPrincipal.from({ sub: 7, name: 'Teela', roles: ['admin', 'editor'], email: 't@e.dev', nested: { x: 1 } }, 'bearer');
    assert.equal(p.isAuthenticated, true); assert.equal(p.id, 7); assert.equal(p.name, 'Teela');
    assert.deepEqual(p.roles, ['admin', 'editor']); assert.ok(p.isInRole('admin')); assert.ok(!p.isInRole('root'));
    assert.ok(p.hasClaim('email', 't@e.dev')); assert.ok(p.hasClaim('email')); assert.ok(!p.hasClaim('nested'));
    const a = ClaimsPrincipal.anonymous();
    assert.equal(a.isAuthenticated, false); assert.equal(a.name, null); assert.deepEqual(a.roles, []);
    const fromList = new ClaimsPrincipal([{ type: 'sub', value: 'u1' }, { type: 'role', value: 'x' }], { authenticationType: 'cookie' });
    assert.equal(fromList.id, 'u1'); assert.deepEqual(JSON.parse(JSON.stringify(fromList)).roles, ['x']);
});

test('AuthenticationService: bearer authenticate, policies, evaluate/enforce -> 401/403 ProblemDetails', async () => {
    const m = new MasterControl();
    const auth = new AuthenticationService(m);
    auth.addJwtBearer('bearer', { secret: SECRET, issuer: 'test' });
    auth.addPolicy('AdminOnly', { roles: ['admin'] });
    auth.addPolicy('Senior', (user) => Number(user.findFirst('level')) >= 5);
    assert.throws(() => auth.addJwtBearer('weak', { secret: 'short' }), /at least 32/);
    assert.throws(() => auth.addScheme('x', { type: 'custom' }), /authenticate/);

    const token = auth.issueToken({ sub: 'u1', name: 'ann', roles: ['user'], level: 3 }, { expiresIn: '5m' });
    const ro = fakeReq({ authorization: `Bearer ${token}` });
    const user = await auth.authenticate(ro);
    assert.equal(user.isAuthenticated, true); assert.equal(user.name, 'ann'); assert.equal(ro.user, user);
    assert.equal(auth.verifyToken(token).sub, 'u1');

    // anonymous -> 401 with WWW-Authenticate + problem+json
    const anon = fakeReq({});
    assert.equal(await auth.enforce(anon, true), false);
    assert.equal(anon.response.head.code, 401);
    assert.equal(anon.response.head.headers['Content-Type'], 'application/problem+json');
    assert.match(anon.response.head.headers['WWW-Authenticate'], /^Bearer realm=/);
    assert.equal(JSON.parse(anon.response.body).status, 401);

    // invalid token -> 401 with error="invalid_token"
    const bad = fakeReq({ authorization: 'Bearer nope.nope.nope' });
    assert.equal(await auth.enforce(bad, true), false);
    assert.match(bad.response.head.headers['WWW-Authenticate'], /error="invalid_token"/);

    // authenticated but wrong role -> 403
    assert.equal(await auth.enforce(ro, 'AdminOnly'), false);
    assert.equal(ro.response.head.code, 403);
    assert.equal(JSON.parse(ro.response.body).title, 'Forbidden');

    // evaluate without writing; roles (any), claims (all), handler, policy function
    const ro2 = fakeReq({ authorization: `Bearer ${token}` });
    assert.equal((await auth.evaluate(ro2, { roles: ['user', 'admin'] })).allowed, true);
    assert.equal((await auth.evaluate(ro2, { claims: { level: [3, 4] } })).allowed, true);
    assert.equal((await auth.evaluate(ro2, { claims: { level: 9 } })).allowed, false);
    assert.equal((await auth.evaluate(ro2, 'Senior')).allowed, false);
    assert.equal((await auth.evaluate(ro2, (u) => u.name === 'ann')).allowed, true);
    assert.equal((await auth.evaluate(ro2, false)).allowed, true, 'false/anonymous = no requirement');
    assert.equal(ro2.response.head, null, 'evaluate never writes');
    assert.throws(() => AuthenticationService.normalizeSpec(42), /invalid authorize/);
});

test('cookie scheme: signIn writes a signed cookie, authenticate round-trips, tamper/expiry rejected, signOut expires, secret rotation', async () => {
    const m = new MasterControl();
    const auth = new AuthenticationService(m);
    auth.addCookie('cookie', { secret: SECRET, maxAgeMs: 60_000, mode: 'api' });
    const ro = fakeReq({}, '/login');
    await auth.signIn(ro, { sub: 'u9', name: 'bob', roles: ['admin'] });
    const setCookie = ro.response.getHeader('set-cookie');
    assert.ok(Array.isArray(setCookie) && /^mc_auth=/.test(setCookie[0]), 'Set-Cookie written');
    assert.match(setCookie[0], /HttpOnly/); assert.match(setCookie[0], /SameSite=Lax/);
    const value = setCookie[0].split(';')[0].split('=')[1];

    const ro2 = fakeReq({ cookie: `mc_auth=${value}` });
    const u = await auth.authenticate(ro2);
    assert.equal(u.isAuthenticated, true); assert.equal(u.name, 'bob'); assert.ok(u.isInRole('admin'));

    const tampered = fakeReq({ cookie: `mc_auth=${value.slice(0, -4)}AAAA` });
    assert.equal((await auth.authenticate(tampered)).isAuthenticated, false);
    assert.equal(tampered.__authFailures[0].code, 'bad_signature');

    // rotation: a cookie signed with the previous secret still validates when listed second
    const auth2 = new AuthenticationService(m);
    auth2.addCookie('cookie', { secret: ['new-secret-that-is-also-32-chars-long!!', SECRET] });
    assert.equal((await auth2.authenticate(fakeReq({ cookie: `mc_auth=${value}` }))).isAuthenticated, true);

    // signOut expires the cookie
    const ro3 = fakeReq({ cookie: `mc_auth=${value}` });
    await auth.signOut(ro3);
    assert.match(ro3.response.getHeader('set-cookie')[0], /Max-Age=0/);
    assert.equal(ro3.user.isAuthenticated, false);

    // web mode: challenge redirects to loginPath with returnUrl
    const web = new AuthenticationService(m);
    web.addCookie('cookie', { secret: SECRET, mode: 'web', loginPath: '/login' });
    const ro4 = fakeReq({ accept: 'text/html' }, '/admin/reports');
    assert.equal(await web.enforce(ro4, true), false);
    assert.equal(ro4.response.head.code, 302);
    assert.equal(ro4.response.head.headers.Location, '/login?returnUrl=%2Fadmin%2Freports');
});

test('resolveControllerAuthorize: static authorize / allowAnonymous shapes', () => {
    class A { static authorize = true; }
    class B { static authorize = { '*': 'AdminOnly', index: false }; static allowAnonymous = ['health']; }
    class C { static authorize = { roles: ['x'] }; }
    assert.equal(resolveControllerAuthorize(A, 'index'), true);
    assert.equal(resolveControllerAuthorize(B, 'index'), undefined);
    assert.equal(resolveControllerAuthorize(B, 'delete'), 'AdminOnly');
    assert.equal(resolveControllerAuthorize(B, 'health'), undefined);
    assert.deepEqual(resolveControllerAuthorize(C, 'anything'), { roles: ['x'] });
    assert.equal(resolveControllerAuthorize(class {}, 'x'), undefined);
});

// ---------------------------------------------------------------------------
// End-to-end through the real pipeline: temp app with routes + controllers.
// ---------------------------------------------------------------------------
let server;
after(() => new Promise((r) => (server ? server.close(() => r()) : r())));

test('e2e: route-level { authorize }, controller static authorize/allowAnonymous, this.user, signIn (bearer + cookie), this.authorize()', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-auth-app-'));
    const app = path.join(root, 'app');
    fs.mkdirSync(path.join(app, 'controllers'), { recursive: true });
    const masterUrl = pathToFileURL(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'MasterControl.js')).href;
    fs.writeFileSync(path.join(app, 'routes.js'), `
import master from ${JSON.stringify(masterUrl)};
const router = master.router.start();
router.route('/public', 'things#open', 'get', { allowAnonymous: true });
router.route('/things', 'things#index', 'get');                                   // controller-level static authorize
router.route('/things/admin', 'things#admin', 'get', { authorize: { roles: ['admin'] } });   // route-level
router.route('/things/senior', 'things#senior', 'get', { authorize: 'Senior' });
router.route('/things/me', 'things#me', 'get');
router.route('/things/inline', 'things#inline', 'get', { allowAnonymous: true });
router.route('/login/token', 'session#token', 'post', { allowAnonymous: true });
router.route('/login/cookie', 'session#cookie', 'post', { allowAnonymous: true });
router.route('/logout', 'session#logout', 'post', { allowAnonymous: true });
router.resources('widgets', { authorize: true, only: ['index'] });
`);
    fs.writeFileSync(path.join(app, 'controllers', 'thingsController.js'), `
export default class ThingsController {
  static authorize = { '*': true, open: false };
  constructor(requestObject) { this.requestObject = requestObject; }
  open() { this.returnJson({ ok: true, user: this.user ? this.user.isAuthenticated : null }); }
  index() { this.returnJson({ ok: true, name: this.user.name }); }
  admin() { this.returnJson({ ok: true, admin: this.user.isInRole('admin') }); }
  senior() { this.returnJson({ ok: true }); }
  me() { this.returnJson({ user: this.user }); }
  async inline() {
    if (!(await this.authorize({ roles: ['admin'] }))) return;   // writes 401/403 itself
    this.returnJson({ ok: true, inline: true });
  }
}
`);
    fs.writeFileSync(path.join(app, 'controllers', 'widgetsController.js'), `
export default class WidgetsController { constructor(r) { this.r = r; } index() { this.returnJson({ widgets: [] }); } }
`);
    fs.writeFileSync(path.join(app, 'controllers', 'sessionController.js'), `
export default class SessionController {
  constructor(requestObject) { this.requestObject = requestObject; }
  async token() {
    const { token } = await this.signIn({ sub: 'u1', name: 'ann', roles: ['admin'], level: 7 }, { scheme: 'bearer', expiresIn: '10m' });
    this.returnJson({ token });
  }
  async cookie() {
    await this.signIn({ sub: 'u2', name: 'bob', roles: ['user'] }, { scheme: 'cookie' });
    this.returnJson({ ok: true, user: this.user.name });
  }
  async logout() { await this.signOut({ scheme: 'cookie' }); this.returnJson({ ok: true }); }
}
`);

    const master = masterSingleton;
    master.root = root;
    master.environmentType = 'development';
    server = master.setupServer('http');
    master.auth.addJwtBearer('bearer', { secret: SECRET, issuer: 'mc-test' });
    master.auth.addCookie('cookie', { secret: SECRET, mode: 'api' });
    master.auth.addPolicy('Senior', (user) => Number(user.findFirst('level')) >= 5);
    await master.startMVC('app');
    await master.start(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (p, headers = {}) => fetch(base + p, { headers, redirect: 'manual' });
    const post = (p, headers = {}) => fetch(base + p, { method: 'POST', headers });

    // anonymous
    let r = await get('/public'); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, user: false });
    r = await get('/things'); assert.equal(r.status, 401, 'controller-level static authorize');
    assert.equal(r.headers.get('content-type'), 'application/problem+json');
    assert.match(r.headers.get('www-authenticate'), /^Bearer realm=/);
    r = await get('/things/admin'); assert.equal(r.status, 401, 'route-level authorize');
    r = await get('/widgets'); assert.equal(r.status, 401, 'resources({ authorize })');

    // bearer sign-in via controller -> token
    r = await post('/login/token'); assert.equal(r.status, 200);
    const { token } = await r.json(); assert.ok(token.split('.').length === 3);
    const H = { authorization: `Bearer ${token}` };
    r = await get('/things', H); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, name: 'ann' });
    r = await get('/things/admin', H); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, admin: true });
    r = await get('/things/senior', H); assert.equal(r.status, 200);
    r = await get('/things/me', H); const me = await r.json(); assert.equal(me.user.name, 'ann'); assert.deepEqual(me.user.roles, ['admin']); assert.equal(me.user.authenticationType, 'bearer');
    r = await get('/things/inline', H); assert.deepEqual(await r.json(), { ok: true, inline: true });
    r = await get('/things/inline'); assert.equal(r.status, 401, 'this.authorize() inside the action');
    r = await get('/widgets', H); assert.equal(r.status, 200);
    r = await get('/things', { authorization: 'Bearer ' + token.slice(0, -3) + 'xyz' }); assert.equal(r.status, 401);

    // cookie sign-in via controller (second scheme): default scheme is bearer, so
    // authorize with schemes must be explicit — here the cookie user is a plain 'user'
    r = await post('/login/cookie'); assert.equal(r.status, 200);
    const setCookie = r.headers.get('set-cookie'); assert.match(setCookie, /^mc_auth=/);
    const cookieVal = setCookie.split(';')[0];
    r = await get('/things/senior', { cookie: cookieVal, accept: 'application/json' });
    assert.equal(r.status, 401, 'default authenticate scheme is bearer; cookie alone does not satisfy');
    // a route that accepts the cookie scheme explicitly
    master.auth.setDefaultScheme('cookie');
    r = await get('/things', { cookie: cookieVal }); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, name: 'bob' });
    r = await get('/things/admin', { cookie: cookieVal }); assert.equal(r.status, 403, 'authenticated via cookie but not admin');
    r = await post('/logout', { cookie: cookieVal }); assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
    master.auth.setDefaultScheme('bearer');
});
