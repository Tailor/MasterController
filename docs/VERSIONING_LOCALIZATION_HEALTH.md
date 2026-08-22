# API versioning, request localization & health endpoints (v2.11.0)

## API versioning (Asp.Versioning)

```js
master.useApiVersioning({ defaultVersion: '1.0', assumeDefaultWhenUnspecified: true, reportApiVersions: true,
  readers: ['query:api-version', 'header:x-api-version', 'media-type:v', 'url-segment'] });

router.route('/items', 'itemsV1#index', 'get', { apiVersion: '1.0', deprecated: true });   // [ApiVersion("1.0")] [Obsolete]
router.route('/items', 'itemsV2#index', 'get', { apiVersion: ['2.0', '3.0'] });           // [ApiVersion("2.0")] [ApiVersion("3.0")]
router.group('/api', { apiVersion: '2.0' }, (g) => g.resources('orders'));                   // group default
router.route('/v:version/reports', 'reports#index', 'get');                                  // url-segment: /v2/reports -> ctx.apiVersion '2.0'
```

- Requested version → `ctx.apiVersion` / `this.apiVersion` (`query`, `header`, `media-type` `Accept: application/json;v=2.0`, `url-segment` `/v2/...`); malformed → `400 Invalid API version` (ProblemDetails).
- A versioned route serves only its versions; a path that exists without a match for the requested version → `400 Unsupported API version` with `api-supported-versions` (ASP.NET behavior); unversioned routes serve any version.
- `reportApiVersions` adds `api-supported-versions` / `api-deprecated-versions` to versioned responses.

## Request localization (RequestLocalizationMiddleware + IStringLocalizer)

```js
master.useRequestLocalization({ defaultCulture: 'en', supportedCultures: ['en', 'de', 'fr-CA'],
  providers: ['query:culture', 'cookie:.Culture', 'accept-language'], resourcesDir: 'resources' });   // resources/en.json, de.json, fr-CA.json
master.localization.addResources('de', { greeting: 'Hallo {name}', nav: { home: 'Start' } });           // nested -> 'nav.home'

// controllers / minimal handlers
this.culture;                                  // 'de'
this.localizer('greeting', { name: 'Ann' });   // 'Hallo Ann' (falls back de-CH -> de -> en -> key)
this.localizer.formatCurrency(12.5, 'EUR');    // Intl with the request culture
```

Resolution follows the provider order; ASP.NET's `.Culture` cookie format (`c=de|uic=de`) is understood; responses carry `Content-Language`.

## Health endpoints (AddHealthChecks / MapHealthChecks)

```js
master.useHealthChecks({
  path: '/health', livePath: '/health/live', readyPath: '/health/ready',
  checks: { db: { check: () => ctx.db.canConnect(), tags: ['ready'] }, redis: { check: pingRedis, tags: ['ready'], critical: false, timeoutMs: 2000 } },
  authorize: (ctx) => ctx.request.socket.remoteAddress === '127.0.0.1',
});
master.healthChecks.add('queue', () => ({ status: 'Healthy', data: { depth: 3 } }), { tags: ['ready'] });
```

`/health/live` → 200 while the process runs (503 once `master.stop()` begins); `/health/ready` → ready-tagged checks (503 when any *critical* check fails, 200 `Degraded` for non-critical failures); `/health` → all checks. Response shape follows ASP.NET: `{ status: Healthy|Degraded|Unhealthy, totalDurationMs, uptimeSec, checks: { name: { status, durationMs, description?, data?, error? } } }`. Readiness automatically reports Unhealthy during graceful shutdown so load balancers drain.
