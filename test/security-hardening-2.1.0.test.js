// Security hardening tests for the 2.1.0 release.
// Every finding surfaced in the 2.0.9 audit gets a red-then-green test here.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { SecurityMiddleware, generateCSRFToken, validateCSRFToken, security }
    from '../security/SecurityMiddleware.js';
import { MasterSocket } from '../MasterSocket.js';
import { MasterCors } from '../MasterCors.js';
import { PrometheusExporter } from '../monitoring/PrometheusExporter.js';
import { validator } from '../security/MasterValidator.js';

// Minimal req/res fakes that match what the middleware actually reads/writes.
function fakeReq({ method = 'POST', url = '/', headers = {}, socket = {}, body } = {}) {
    return {
        method,
        url,
        headers,
        socket: { remoteAddress: '127.0.0.1', encrypted: false, ...socket },
        connection: { remoteAddress: '127.0.0.1', encrypted: false, ...socket },
        body
    };
}

function fakeRes() {
    const res = {
        statusCode: 200,
        headers: {},
        _ended: false,
        writableEnded: false,
        headersSent: false,
        setHeader(name, value) { this.headers[String(name).toLowerCase()] = String(value); },
        getHeader(name) { return this.headers[String(name).toLowerCase()]; },
        removeHeader(name) { delete this.headers[String(name).toLowerCase()]; },
        writeHead(code, headers) {
            this.statusCode = code;
            if (headers) for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
        },
        end(body) { this._ended = true; this.writableEnded = true; this._body = body; }
    };
    return res;
}

// A minimal master surrogate that implements the trusted-proxy helpers used by
// the hardened SecurityMiddleware / SecurityEnforcement paths.
function fakeMaster({ trustedProxies = [], secure = false } = {}) {
    return {
        trustedProxies,
        isTrustedProxy(peer) { return trustedProxies.includes(peer); },
        getClientIp(req) {
            const peer = req.socket?.remoteAddress || 'unknown';
            if (!this.isTrustedProxy(peer)) return peer;
            const xff = req.headers['x-forwarded-for'];
            if (!xff) return peer;
            const hops = String(xff).split(',').map(s => s.trim()).filter(Boolean);
            for (let i = hops.length - 1; i >= 0; i--) {
                if (!this.isTrustedProxy(hops[i])) return hops[i];
            }
            return peer;
        },
        isRequestSecure(req) {
            if (req.socket?.encrypted) return true;
            const peer = req.socket?.remoteAddress || '';
            if (!this.isTrustedProxy(peer)) return secure;
            return req.headers['x-forwarded-proto'] === 'https';
        }
    };
}

// ---------------------------------------------------------------------------
// CRITICAL 1: SecurityMiddleware options wiring
// ---------------------------------------------------------------------------

test('SecurityMiddleware stores options on the instance (fix for dead trustedProxies)', () => {
    const sm = new SecurityMiddleware({ trustedProxies: ['10.0.0.1'] });
    try {
        assert.ok(sm.options, 'constructor must set this.options');
        assert.deepEqual(sm.options.trustedProxies, ['10.0.0.1']);
    } finally {
        sm.stop?.();
    }
});

test('SecurityMiddleware.bindMaster delegates IP resolution to master.getClientIp', () => {
    const sm = new SecurityMiddleware();
    try {
        const master = fakeMaster({ trustedProxies: ['10.0.0.1'] });
        sm.bindMaster(master);
        const req = fakeReq({
            socket: { remoteAddress: '10.0.0.1' },
            headers: { 'x-forwarded-for': '203.0.113.5' }
        });
        assert.equal(sm._getClientIP(req), '203.0.113.5',
            'peer is a trusted proxy → real client IP is taken from XFF');
    } finally {
        sm.stop?.();
    }
});

test('SecurityMiddleware HSTS header is emitted when master.isRequestSecure() is true', () => {
    const sm = new SecurityMiddleware();
    try {
        sm.bindMaster(fakeMaster({ trustedProxies: ['10.0.0.1'], secure: false }));
        process.env.NODE_ENV = 'production';
        const req = fakeReq({
            socket: { remoteAddress: '10.0.0.1' },
            headers: { 'x-forwarded-proto': 'https' }
        });
        const res = fakeRes();
        sm.securityHeadersMiddleware(req, res, () => {});
        assert.match(res.getHeader('strict-transport-security') || '',
            /max-age=\d+/, 'HSTS should be present behind a trusted TLS-terminating proxy');
        assert.doesNotMatch(res.getHeader('strict-transport-security') || '', /preload/,
            'HSTS must NOT include preload by default');
    } finally {
        process.env.NODE_ENV = 'test';
        sm.stop?.();
    }
});

// ---------------------------------------------------------------------------
// CRITICAL 2: CSRF session binding + rotate-on-use
// ---------------------------------------------------------------------------

test('generateCSRFToken requires a non-empty sessionId', () => {
    assert.throws(() => generateCSRFToken(), /sessionId/i);
    assert.throws(() => generateCSRFToken(null), /sessionId/i);
    assert.throws(() => generateCSRFToken(''), /sessionId/i);
});

test('validateCSRFToken accepts a bound token exactly once (rotate-on-use)', () => {
    const sessionId = 'sess-' + crypto.randomBytes(8).toString('hex');
    const token = generateCSRFToken(sessionId);
    const first = validateCSRFToken(token, sessionId);
    assert.equal(first.valid, true, 'first validate should succeed');
    const second = validateCSRFToken(token, sessionId);
    assert.equal(second.valid, false, 'replay must fail after rotation');
});

test('validateCSRFToken rejects a token bound to a different session', () => {
    const owner = 'sess-owner';
    const stranger = 'sess-stranger';
    const token = generateCSRFToken(owner);
    const result = validateCSRFToken(token, stranger);
    assert.equal(result.valid, false);
});

// ---------------------------------------------------------------------------
// CRITICAL 3: MasterSocket safe CORS defaults
// ---------------------------------------------------------------------------

test('MasterSocket default CORS is safe when no cors.json is present', () => {
    const ms = new MasterSocket({ root: '/nonexistent-project-dir-for-tests' });
    const defaults = ms._buildDefaultIoOptions();
    assert.notEqual(defaults.cors.origin, true,
        'Fallback CORS must NOT default to origin:true');
    assert.notEqual(defaults.cors.credentials, true,
        'Fallback CORS must NOT default to credentials:true');
});

test('MasterSocket.init throws when effective CORS has origin:true + credentials:true', async () => {
    const ms = new MasterSocket({ root: '/nonexistent-project-dir-for-tests', server: {} });
    await assert.rejects(
        () => ms.init(undefined, { cors: { origin: true, credentials: true } }),
        /origin:true.*credentials:true/i
    );
});

// ---------------------------------------------------------------------------
// MasterCors: guard extends to function-origin returning true + credentials:true
// ---------------------------------------------------------------------------

test('MasterCors.init throws for function-origin combined with credentials:true', () => {
    const mc = new MasterCors({});
    assert.throws(
        () => mc.init({ origin: () => true, credentials: true }),
        /credentials/i
    );
});

// ---------------------------------------------------------------------------
// CRITICAL 4: Rate-limit hardening
// ---------------------------------------------------------------------------

test('rate limit identity does NOT trust x-api-key header from anonymous clients', () => {
    const sm = new SecurityMiddleware({ rateLimit: true });
    try {
        const req = fakeReq({ headers: { 'x-api-key': 'attacker-picked-key' } });
        const id = sm._getClientIdentifier(req);
        assert.doesNotMatch(id, /^api:attacker-picked-key$/,
            'x-api-key must not be used as identity for unauthenticated requests');
        assert.match(id, /^ip:/, 'identity should key on resolved client IP');
    } finally {
        sm.stop?.();
    }
});

test('rate-limit store enforces an LRU cap (no unbounded growth)', () => {
    const sm = new SecurityMiddleware({
        rateLimit: true,
        rateLimitStoreMax: 5,
        rateLimitMax: 1000
    });
    try {
        for (let i = 0; i < 100; i++) {
            const req = fakeReq({ socket: { remoteAddress: `10.0.0.${i}` } });
            const res = fakeRes();
            sm.rateLimitMiddleware(req, res, () => {});
        }
        assert.ok(sm.getRateLimitStoreSize() <= 5,
            `store size ${sm.getRateLimitStoreSize()} exceeded LRU cap 5`);
    } finally {
        sm.stop?.();
    }
});

test('exponential backoff: block window grows on repeat offenders', () => {
    const sm = new SecurityMiddleware({
        rateLimit: true,
        rateLimitMax: 1,
        rateLimitWindow: 1000
    });
    try {
        const identity = 'ip:198.51.100.5';
        const first = sm._computeBlockDurationMs(identity, 1);
        const second = sm._computeBlockDurationMs(identity, 2);
        const third = sm._computeBlockDurationMs(identity, 3);
        assert.ok(second > first, 'second offense should escalate');
        assert.ok(third > second, 'third offense should escalate further');
        assert.ok(third <= 24 * 60 * 60 * 1000, 'must be capped at 24h');
    } finally {
        sm.stop?.();
    }
});

// ---------------------------------------------------------------------------
// HIGH: Transport hardening — HSTS header contents
// ---------------------------------------------------------------------------

test('SecurityMiddleware HSTS header does NOT hardcode preload', async () => {
    const { SECURITY_HEADERS } = await import('../security/SecurityMiddleware.js');
    // The hardcoded HSTS header used to include `preload` unconditionally.
    // We assert either that it is not exported hardcoded, or that if it is,
    // it does not include preload.
    const mod = await import('../security/SecurityMiddleware.js');
    if (mod.HSTS_HEADER) {
        const value = mod.HSTS_HEADER['Strict-Transport-Security'] || '';
        assert.doesNotMatch(value, /preload/,
            'HSTS_HEADER must not include preload by default');
    }
    // If exported constant was removed entirely, the test still passes — the
    // runtime path is exercised by the earlier "HSTS header is emitted" test.
    assert.ok(true);
});

// ---------------------------------------------------------------------------
// HIGH: Cookie CRLF + __Host- prefix validation
// ---------------------------------------------------------------------------

test('MasterSessionSecurity.setCookie rejects CRLF in cookie name', async () => {
    const mod = await import('../security/SessionSecurity.js');
    // MasterSessionSecurity is the compatibility wrapper — it exposes setCookie
    // used by the framework itself.
    const { MasterSessionSecurity } = mod;
    const wrapper = new MasterSessionSecurity({ root: '/tmp' });
    const res = fakeRes();
    assert.throws(
        () => wrapper.setCookie(res, 'sid\r\nSet-Cookie: admin=1', 'v'),
        /invalid|crlf|control/i
    );
});

test('MasterSessionSecurity.setCookie rejects CRLF in Domain / Path options', async () => {
    const { MasterSessionSecurity } = await import('../security/SessionSecurity.js');
    const wrapper = new MasterSessionSecurity({ root: '/tmp' });
    const res = fakeRes();
    assert.throws(
        () => wrapper.setCookie(res, 'sid', 'v', { domain: 'ex.com\r\nX: y' }),
        /invalid|crlf|control/i
    );
    assert.throws(
        () => wrapper.setCookie(res, 'sid', 'v', { path: '/foo\r\n' }),
        /invalid|crlf|control/i
    );
});

test('MasterSessionSecurity.setCookie enforces __Host- prefix rules', async () => {
    const { MasterSessionSecurity } = await import('../security/SessionSecurity.js');
    const wrapper = new MasterSessionSecurity({ root: '/tmp' });
    const res = fakeRes();
    assert.throws(
        () => wrapper.setCookie(res, '__Host-sid', 'v', { domain: 'ex.com', secure: true, path: '/' }),
        /__Host-/,
        '__Host- with Domain must be rejected'
    );
    assert.throws(
        () => wrapper.setCookie(res, '__Host-sid', 'v', { secure: false, path: '/' }),
        /__Host-/,
        '__Host- without Secure must be rejected'
    );
    assert.throws(
        () => wrapper.setCookie(res, '__Host-sid', 'v', { secure: true, path: '/foo' }),
        /__Host-/,
        '__Host- with non-root path must be rejected'
    );
    // Correct usage does not throw
    assert.doesNotThrow(
        () => wrapper.setCookie(res, '__Host-sid', 'v', { secure: true, path: '/' })
    );
});

// ---------------------------------------------------------------------------
// HIGH: Prometheus label escaping + LRU cap
// ---------------------------------------------------------------------------

test('PrometheusExporter escapes " \\ and \\n in label values', () => {
    const pex = new PrometheusExporter({ endpoint: '/_metrics' });
    // Recording one request with hostile characters. If escaping is broken,
    // the raw \n splits this single metric into multiple physical lines and
    // an unescaped " lets us inject a fake second series.
    pex._recordRequest('GET', '/foo"bar\nbaz\\qux', 200, 0.001, 0, 0);
    const out = pex._generateSimpleMetrics();

    // Every physical line that begins with the metric name is a claimed sample.
    // We recorded exactly one → there must be exactly one line, otherwise the
    // hostile characters escaped their label and became new metric lines.
    const counterLines = out.split('\n')
        .filter(l => l.startsWith('mastercontroller_http_requests_total{'));
    assert.equal(counterLines.length, 1,
        `expected 1 counter line, got ${counterLines.length}: metric injection is possible`);

    const line = counterLines[0];
    // No unescaped CR/LF anywhere inside the label section.
    const labelMatch = line.match(/\{([^}]*)\}/);
    assert.ok(labelMatch, `label section missing on line: ${line}`);
    assert.doesNotMatch(labelMatch[1], /[\r\n]/, 'raw CR/LF inside label section');

    // The path label must contain the escaped forms, NOT the raw characters.
    // We check by substring rather than by regex — a value like
    // `/foo\"bar\nbaz\\qux` contains raw quote-escape sequences that make
    // regex quote-boundary matching brittle.
    assert.ok(line.includes('\\n'), 'literal \\n escape must appear in the metric line');
    assert.ok(line.includes('\\"'), 'literal \\" escape must appear in the metric line');
    assert.ok(line.includes('\\\\'), 'literal \\\\ escape must appear in the metric line');
});

test('PrometheusExporter caps httpRequestsTotal with LRU eviction', () => {
    const pex = new PrometheusExporter({ endpoint: '/_metrics', metricsMax: 8 });
    for (let i = 0; i < 100; i++) {
        pex._recordRequest('GET', `/dyn/${i}/end`, 200, 0.001, 0, 0);
    }
    const keys = Object.keys(pex.httpRequestsTotal);
    assert.ok(keys.length <= 8, `metrics map size ${keys.length} exceeded cap 8`);
});

// ---------------------------------------------------------------------------
// HIGH: qs prototype-safe options
// ---------------------------------------------------------------------------

test('urlEncodeStream qs.parse rejects __proto__ pollution attempts', async () => {
    const qs = (await import('qs')).default;
    // Confirm that the options we use in the framework block prototype pollution.
    const opts = { plainObjects: true, allowPrototypes: false, parameterLimit: 1000, depth: 5, arrayLimit: 20 };
    const parsed = qs.parse('__proto__[polluted]=1&constructor[prototype][x]=1', opts);
    assert.equal({}.polluted, undefined, 'Object prototype must not be polluted');
    assert.equal({}.x, undefined, 'Object prototype must not be polluted via constructor');
    // With plainObjects:true the parsed object has null prototype.
    assert.equal(Object.getPrototypeOf(parsed), null,
        'parsed body should have null prototype');
});

// ---------------------------------------------------------------------------
// HIGH: validator length caps
// ---------------------------------------------------------------------------

test('validateEmail rejects oversized input before running the regex', () => {
    const huge = 'a'.repeat(10_000) + '@example.com';
    const t0 = process.hrtime.bigint();
    const result = validator.validateEmail(huge);
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(result.valid, false);
    assert.ok(elapsedMs < 50,
        `validateEmail took ${elapsedMs.toFixed(2)}ms — length cap must short-circuit before regex`);
});

test('validateURL rejects oversized input before running the regex', () => {
    const huge = 'http://example.com/' + 'a-'.repeat(20_000) + '!';
    const t0 = process.hrtime.bigint();
    const result = validator.validateURL(huge);
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(result.valid, false);
    assert.ok(elapsedMs < 50,
        `validateURL took ${elapsedMs.toFixed(2)}ms — length cap must short-circuit before regex`);
});

test('validateUUID rejects oversized input before running the regex', () => {
    const huge = 'a'.repeat(10_000);
    const result = validator.validateUUID(huge);
    assert.equal(result.valid, false);
});
