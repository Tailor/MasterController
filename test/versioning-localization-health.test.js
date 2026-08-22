/**
 * 2.11.0 — API versioning (Asp.Versioning), request localization (IStringLocalizer),
 * readiness/liveness health endpoints — through the real pipeline via the test client.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { ApiVersioning, parseVersion, compareVersions } from '../MasterApiVersioning.js';
import { LocalizationService, parseAcceptLanguage } from '../MasterLocalization.js';
import masterSingleton from '../MasterControl.js';

test('versioning + localization units', () => {
    assert.deepEqual(parseVersion('v2'), { major: 2, minor: 0, status: null, text: '2.0' });
    assert.equal(parseVersion('2.1-beta').text, '2.1-beta'); assert.equal(parseVersion('x'), null);
    assert.ok(compareVersions('2.0', '10.0') < 0); assert.ok(compareVersions('1.1', '1.0') > 0);
    const v = new ApiVersioning({ defaultVersion: '1.0', readers: ['query:api-version', 'header:x-api-version', 'media-type:v', 'url-segment'] });
    assert.deepEqual(v.read({ requrl: { query: { 'api-version': '2' } }, request: { headers: {} } }), { version: '2.0', source: 'query:api-version' });
    assert.deepEqual(v.read({ requrl: { query: {} }, request: { headers: { 'x-api-version': '3.1' } } }), { version: '3.1', source: 'header:x-api-version' });
    assert.deepEqual(v.read({ requrl: { query: {} }, request: { headers: { accept: 'application/json;v=2.0' } } }), { version: '2.0', source: 'media-type:v' });
    assert.deepEqual(v.read({ requrl: { query: {} }, request: { headers: {} }, pathName: 'v2/items' }), { version: '2.0', source: 'url-segment' });
    assert.equal(v.read({ requrl: { query: { 'api-version': 'nope' } }, request: { headers: {} } }).invalid, 'nope');
    assert.deepEqual(v.reportHeaders(['2.0', '1.0'], ['1.0']), { 'api-supported-versions': '1.0, 2.0', 'api-deprecated-versions': '1.0' });

    assert.deepEqual(parseAcceptLanguage('fr-CH, fr;q=0.9, en;q=0.8, de;q=0.7, *;q=0.5'), ['fr-CH', 'fr', 'en', 'de']);
    const loc = new LocalizationService({ defaultCulture: 'en', supportedCultures: ['en', 'de', 'fr-CA'], resources: { en: { greeting: 'Hello {name}', nav: { home: 'Home' } }, de: { greeting: 'Hallo {name}' }, 'fr-ca': { greeting: 'Bonjour {name}' } } });
    assert.equal(loc.match('DE'), 'de'); assert.equal(loc.match('de-AT'), 'de', 'parent fallback'); assert.equal(loc.match('fr'), 'fr-CA', 'language -> supported region variant'); assert.equal(loc.match('es'), null);
    assert.equal(loc.get('de', 'greeting', { name: 'Ann' }), 'Hallo Ann');
    assert.equal(loc.get('de', 'nav.home'), 'Home', 'falls back to the default culture'); assert.equal(loc.get('de', 'missing.key'), 'missing.key');
    assert.equal(loc.resolve({ request: { headers: { 'accept-language': 'es, de;q=0.8' } }, requrl: { query: {} } }).culture, 'de');
    assert.equal(loc.resolve({ request: { headers: { cookie: '.Culture=c%3Dfr-CA%7Cuic%3Dfr-CA' } }, requrl: { query: {} } }).culture, 'fr-CA', 'ASP.NET cookie format');
    assert.equal(loc.resolve({ request: { headers: {} }, requrl: { query: { culture: 'xx' } } }).culture, 'en', 'unsupported -> default');
    const l = loc.localizer('de'); assert.equal(l('greeting', { name: 'Bob' }), 'Hallo Bob'); assert.equal(l.has('greeting'), true); assert.equal(l.formatNumber(1234.5), '1.234,5');
});

let client;
after(() => client && client.close());

test('e2e: versioned routes (query/header/url-segment readers, 400 unsupported, report headers), localization in handlers, health live/ready/full', async () => {
    const master = masterSingleton;
    process.env.MC_DISABLE_DEFAULT_LOG_PROVIDER = '1';
    master.environmentType = 'development';
    let dbHealthy = true;
    client = await master.createTestClient({
        app: false,
        configure: (m) => {
            m.useApiVersioning({ defaultVersion: '1.0', readers: ['query:api-version', 'header:x-api-version', 'url-segment'] });
            m.useRequestLocalization({ defaultCulture: 'en', supportedCultures: ['en', 'de'], resources: { en: { hello: 'Hello {name}' }, de: { hello: 'Hallo {name}' } } });
            m.useHealthChecks({ checks: { db: { check: async () => ({ healthy: dbHealthy, data: { pool: 3 } }), tags: ['ready'] }, slow: { check: () => new Promise(r => setTimeout(() => r(true), 5)), tags: [] }, soft: { check: () => false, critical: false, tags: ['ready'] } } });
            m.map.get('/things', function () { this.ok({ v: 1 }); }, { allowAnonymous: true, apiVersion: '1.0', deprecated: true });
            m.map.get('/things', function () { this.ok({ v: 2, requested: this.apiVersion }); }, { allowAnonymous: true, apiVersion: ['2.0', '3.0'] });
            m.map.get('/v:version/only', function () { this.ok({ ok: true, v: this.apiVersion }); }, { allowAnonymous: true });
            m.map.get('/hello', function () { this.ok({ text: this.localizer('hello', { name: 'Ann' }), culture: this.culture }); }, { allowAnonymous: true });
            m.map.get('/plain', function () { this.ok({ v: this.apiVersion }); }, { allowAnonymous: true });
        },
    });

    let r = await client.get('/things'); assert.equal(r.status, 200); assert.deepEqual(r.json(), { v: 1 }, 'default 1.0 when unspecified');
    assert.equal(r.header('api-supported-versions'), '1.0, 2.0, 3.0'); assert.equal(r.header('api-deprecated-versions'), '1.0');
    r = await client.get('/things', { query: { 'api-version': '2.0' } }); assert.deepEqual(r.json(), { v: 2, requested: '2.0' });
    r = await client.get('/things', { headers: { 'x-api-version': '3' } }); assert.deepEqual(r.json(), { v: 2, requested: '3.0' });
    r = await client.get('/things', { query: { 'api-version': '9.0' } }); assert.equal(r.status, 400, 'unsupported version');
    assert.equal(r.header('content-type'), 'application/problem+json'); assert.equal(r.json().title, 'Unsupported API version'); assert.deepEqual(r.json().supportedVersions, ['1.0', '2.0', '3.0']);
    r = await client.get('/things', { query: { 'api-version': 'bad' } }); assert.equal(r.status, 400); assert.equal(r.json().title, 'Invalid API version');
    r = await client.get('/plain', { query: { 'api-version': '7' } }); assert.equal(r.status, 200, 'unversioned routes serve any version'); assert.deepEqual(r.json(), { v: '7.0' });
    r = await client.get('/v2/only'); assert.deepEqual(r.json(), { ok: true, v: '2.0' }, 'url-segment reader');

    r = await client.get('/hello'); assert.deepEqual(r.json(), { text: 'Hello Ann', culture: 'en' }); assert.equal(r.header('content-language'), 'en');
    r = await client.get('/hello', { headers: { 'accept-language': 'de-CH, en;q=0.5' } }); assert.deepEqual(r.json(), { text: 'Hallo Ann', culture: 'de' });
    r = await client.get('/hello', { query: { culture: 'de' } }); assert.equal(r.json().culture, 'de');

    r = await client.get('/health/live'); assert.equal(r.status, 200); assert.equal(r.json().status, 'Healthy');
    r = await client.get('/health/ready'); assert.equal(r.status, 200); assert.equal(r.json().status, 'Degraded', 'non-critical failing check -> Degraded (200)');
    assert.deepEqual(Object.keys(r.json().checks).sort(), ['db', 'soft'], 'readiness runs ready-tagged checks only'); assert.deepEqual(r.json().checks.db.data, { pool: 3 });
    r = await client.get('/health'); assert.deepEqual(Object.keys(r.json().checks).sort(), ['db', 'slow', 'soft']);
    dbHealthy = false;
    r = await client.get('/health/ready'); assert.equal(r.status, 503); assert.equal(r.json().status, 'Unhealthy');
    master.healthChecks.add('queue', () => ({ status: 'Healthy' }), { tags: ['ready'] }); master.healthChecks.remove('soft'); dbHealthy = true;
    r = await client.get('/health/ready'); assert.equal(r.status, 200); assert.deepEqual(Object.keys(r.json().checks).sort(), ['db', 'queue']);
});
