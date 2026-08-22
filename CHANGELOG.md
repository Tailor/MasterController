# MasterController Changelog

## 2.9.0 — OpenAPI (AddOpenApi/MapOpenApi + Swagger UI)

Closes gap #7 of `docs/ASPNET_CORE_GAP_ANALYSIS.md`. No new dependencies.

- **`master.useOpenApi({ path, ui, title, version, description, servers, tags, filter, transform })`** (`MasterOpenApi.js`) serves an **OpenAPI 3.1 document** generated from the app: routes (`route`/`resources`) → paths/operations, typed route constraints → path parameter schemas, `static schemas` → `requestBody` / query / header / path parameters (validation rules → JSON Schema) + `400 ValidationProblemDetails`, route/controller `authorize` → `security` + `401/403`, `master.auth` schemes → `components.securitySchemes`, `static openapi = { action: { summary, description, tags, responses, deprecated, operationId } }`, `outputCache` → `x-output-cache`. Optional **Swagger UI** page (`ui: '/docs'`, CDN-loaded). `master.openApi.document()` / `invalidate()`.

Tests: `test/openapi.test.js` (schema conversion, path conversion, end-to-end document + UI). Docs: `docs/OPENAPI.md`, README.

## 2.8.0 — Response compression, output caching, distributed cache

Closes gap #6 of `docs/ASPNET_CORE_GAP_ANALYSIS.md`. No new dependencies.

- **`master.useResponseCompression({ threshold, level, brotli, brotliQuality, mimeTypes })`** (`MasterCaching.js`): streaming gzip/brotli for clients that accept it; skips encoded/204/304/HEAD/`no-transform`/non-compressible/small-known-length responses; sets `Content-Encoding` + `Vary: Accept-Encoding`.
- **Output caching** (`[OutputCache]`): route `{ outputCache: { duration, varyByQuery, varyByHeader, varyByUser, tags, cacheAuthenticated, maxBodyBytes } | 'PolicyName' | true }`, controller `static outputCache = { action: …, '*': … }`, `resources(name, { outputCache })`; named policies `master.outputCache.addPolicy`; `evictByTag/evict/clear`; `X-Output-Cache: HIT|MISS` + `Age`; only GET/HEAD 200s, authenticated requests bypass by default, `Set-Cookie`/`no-store`/`private` never cached; runs after authorization + binding.
- **`master.cache`** (`IDistributedCache`): `get/set(ttlMs|slidingMs, tags)/remove/getOrCreate (single-flight)/evictByTag/clear`; `MemoryCacheStore` (LRU, TTL, sliding, tags) by default, `RedisCacheStore(client)` for Redis — shared by the output cache. Named exports: `DistributedCache`, `MemoryCacheStore`, `RedisCacheStore`, `OutputCache`.

Tests: `test/caching.test.js` (stores, single-flight, Redis contract, policy/key resolution, end-to-end gzip/br/skips + output cache HIT/MISS/vary/tags/auth-bypass/POST). Docs: `docs/CACHING.md`, README.

## 2.7.0 — Logging (ILogger<T> parity)

Closes gap #5 of `docs/ASPNET_CORE_GAP_ANALYSIS.md`. No new dependencies.

- **`master.createLogger(category)`** / **`this.logger`** in controllers (`MasterLogging.js`): levels `trace…critical`, `isEnabled`, message templates (`'user {id}'`), structured properties + error serialization, **redaction** of sensitive keys, `child(suffix)`.
- **Levels from configuration**: `Logging:LogLevel:Default` and per-category prefixes (longest wins), `Logging:MinimumLevel`; re-applied on configuration reload; `master.logging.setMinimumLevel(level, prefix)`.
- **Scopes** (`BeginScope`): `logger.beginScope(state)` / `await logger.scope(state, fn)` — carried across `await` via `AsyncLocalStorage`, nested merge.
- **Request correlation**: each request runs in a scope `{ requestId, method, path }`; `X-Request-Id` honored or generated and echoed; access-log line per request (`Request` category; `master.requestLogging = 'scopeOnly' | false`).
- **Providers**: `consoleProvider({ json })` default (JSON lines in production / `Logging:Console:Json`), `memoryProvider()`, `master.logging.addProvider(fn | { write, minimumLevel })`, `enrich()`; a throwing sink never breaks the app. Named exports: `LoggerFactory`, `consoleProvider`, `memoryProvider`.

Tests: `test/logging.test.js` (levels/categories/templates/redaction/providers, scopes across awaits, console renderers, end-to-end request correlation + `this.logger`). Docs: `docs/LOGGING.md`, README.

## 2.6.0 — Hosted services, background work & host lifetime (ASP.NET generic host)

Closes gap #4 of `docs/ASPNET_CORE_GAP_ANALYSIS.md`. No new dependencies.

- **`master.addHostedService(Class | instance)`** (`MasterHosting.js`): started in registration order at `master.start()` (a failing start aborts the boot), stopped in **reverse** by `master.stop()` with a per-service budget from `master.shutdownTimeoutMs` (30 s, `HostOptions.ShutdownTimeout`); services added after start are started immediately.
- **`BackgroundService`** base (`executeAsync(signal)`, not awaited by start — ASP.NET semantics; `delay(ms, signal)`, `useScope()`/`createScope()`; `exceptionBehavior: 'stopHost'` default = `BackgroundServiceExceptionBehavior.StopHost`, `'ignore'` to opt out). Exported from the package (`import { BackgroundService } from 'mastercontroller'`).
- **`master.addPeriodicService(name, intervalMs, run(scope, signal), { runOnStart, jitterMs, exceptionBehavior })`** — `PeriodicTimer` loop with a fresh DI scope per run (scoped MasterRecord context built and disposed per tick); failing ticks are logged and the loop continues.
- **`master.backgroundQueue.enqueue(job(scope, signal))`** (`IBackgroundTaskQueue` + queued hosted worker, `master.backgroundQueueConcurrency`); resolves with the job result / rejects with its error.
- **`master.lifetime`** (`IHostApplicationLifetime`): `onStarted` (fires when the server is listening), `onStopping`, `onStopped`, `stoppingSignal`, `isStopping`; **`master.stop()`** = stopping → `server.close()` (+ idle connections) → services reverse → stopped (idempotent); **`master.useGracefulShutdown({ signals, exit })`** for SIGTERM/SIGINT.

Tests: `test/hosting.test.js`. Docs: `docs/HOSTED_SERVICES.md`, README.

## 2.5.0 — Configuration & Options (IConfiguration / IOptions<T> / IHostEnvironment)

Closes gap #3 of `docs/ASPNET_CORE_GAP_ANALYSIS.md`. No new dependencies.

- **`master.configuration`** (`MasterConfiguration.js`): layered, case-insensitive, `:`-keyed configuration built in `setupServer()` (rebuilt at `start()` when root/environment changed): `config/appsettings.json` < `config/appsettings.{env}.json` < `config/environments/env.{env}.json` < **user secrets** (`~/.master/usersecrets/<id>/secrets.json`, `master.userSecretsId` / `MASTER_USER_SECRETS_ID`, base dir `MASTER_USER_SECRETS_PATH`) < **environment variables** (`Section__Key`, optional `master.configurationEnvPrefix`) < **command line** (`--Section:Key=value`) < `set()`. API: `get(key, default)`, `has`, `getSection`, `getConnectionString`, `bind(section, defaults)`, `set`, `reload`, `onChange`, `sources`; builders `addJsonFile/addUserSecrets/addEnvironmentVariables/addCommandLine/addInMemory`; `master.buildConfiguration({ sources })` to replace the defaults; `reloadOnChange` file watching.
- **`master.options`** (Options pattern): `configure(name, { section, defaults, schema, validate, postConfigure })` using the 2.4.0 validation rules; **validated on `start()`** (`ValidateOnStart` — a misconfigured app fails at boot with every error listed); `get(name)` (frozen), `getAsync`, `validateAll`, `onChange(name, cb)` (`IOptionsMonitor`).
- **`master.environment`** (`IHostEnvironment`): `name`, `isDevelopment/isStaging/isProduction/isTest`, `is(name)`.
- Controllers get **`this.options`**, `this.configuration`, `this.environment` per request.

Tests: `test/configuration.test.js`. Docs: `docs/CONFIGURATION.md`, README.

## 2.4.0 — Model binding, validation, ProblemDetails, typed results, typed route constraints

Closes gap #2 of `docs/ASPNET_CORE_GAP_ANALYSIS.md`. No new dependencies.

- **Declarative binding** (`security/MasterModelBinding.js`): `static schemas = { action: { body, query, route, form, files, headers } }` binds **`this.model`** (merged, coerced, unknown fields stripped) and **`this.modelState`** before filters run; invalid input answers **400 `ValidationProblemDetails`** automatically (`static autoValidate = false` to handle `modelState` yourself). Explicit `await this.bind(spec)`, `this.validateModel(data, schema)`, `master.validation.validate/bind`.
- **Validation rules** (DataAnnotations-like): types `string/number/integer/boolean/email/url/uuid/date/datetime/array/object/any`, `required`, `default`, `min/max`, `minLength/maxLength`, `pattern`, `enum`, `items`, nested `properties`, `custom` (async), shorthands `'integer!'`; JSON-Schema-like object form accepted; errors keyed like `ModelState` (`address.city`, `tags[1]`).
- **ProblemDetails (RFC 7807)** everywhere: `this.problem({...})`, `this.validationProblem(errors)`, `badRequest/unauthorized/forbidden/notFound/conflict/unprocessable`; **unhandled controller/routing errors answer `application/problem+json` to API clients** (Accept JSON / XHR / JSON body / bearer token) and keep HTML pages for browsers; the pipeline's 500 handler body gains `type/title/status/instance` (superset of `{ error, errorId }`).
- **Typed results** (ControllerBase): `ok`, `created(location, data)`, `accepted`, `noContent`, `statusCode(code, body)`, `file(pathOrBuffer, { contentType, fileName, inline })` (streams files, `Content-Disposition`).
- **Typed route constraints**: `'/items/:id(int)'` → `obj.params.id` is a number; `int, number, bool, uuid, alpha, alphanum, slug, length(n), minlength(n), maxlength(n), min(n), max(n), regex:…`; a miss lets the next route match; unknown constraint names fail at registration.

Tests: `test/model-binding.test.js` (rules/coercion/nesting/custom, per-source binding, ModelState, ProblemDetails writer, end-to-end through HTTP: constraints, auto-400, 201+Location, query defaults, 422 manual, `bind()`, 204, file download, 500 problem+json vs HTML). Docs: `docs/MODEL_BINDING.md`, README.

## 2.3.0 — Authentication & Authorization (ASP.NET Core parity)

Closes gap #1 of `docs/ASPNET_CORE_GAP_ANALYSIS.md`. No new dependencies.

- **`master.auth`** (`security/MasterAuth.js`): `addJwtBearer(name, { secret | publicKey | keyResolver, algorithm(s), issuer, audience, clockToleranceSec, expiresIn, onAuthenticated })`, `addCookie(name, { secret | [current, previous…], cookieName, maxAgeMs, slidingExpiration, httpOnly, sameSite, secure: 'auto', mode: 'api' | 'web', loginPath, accessDeniedPath, returnUrlParam })`, `addScheme(name, { type: 'custom', authenticate, challenge, forbid, signIn, signOut })`, `setDefaultScheme`, `addPolicy(name, { roles (any), claims (all), requireAuthenticated, handler } | fn)`, `authenticate(requestObject, schemes?)`, `evaluate / enforce(requestObject, spec)`, `challenge / forbid`, `signIn / signOut`, `issueToken / verifyToken`, `passwordHasher` (scrypt), `middleware()`.
- **JWT** (`jwt.sign/verify/decode`): HS256/384/512, RS256/384/512, PS256/384/512, ES256/384/512 with `node:crypto`; algorithm allow-list, `exp`/`nbf`/`iat`, `iss`/`aud`, `maxAgeSec`, constant-time HMAC compare; durations `'15m' | '2h' | '7d'`.
- **`ClaimsPrincipal`** (`requestObject.user`, `this.user`): `isAuthenticated`, `id`, `name`, `roles`, `claims`, `hasClaim`, `isInRole`, `findFirst/findAll`, `authenticationType`.
- **Authorization everywhere `[Authorize]` goes:** route options `router.route(path, 'c#a', 'get', { authorize, allowAnonymous, constraint })`, `router.resources(name, { authorize, only, except })`, controller `static authorize = true | 'Policy' | { roles } | { '*': spec, action: spec | false }` and `static allowAnonymous = true | [actions]`, in-action `await this.authorize(spec)` / `this.isAuthorized(spec)`. Failures answer **401/403 as RFC 7807 `application/problem+json`** (+ `WWW-Authenticate: Bearer …` with `error="invalid_token"` when a bad token was sent) or redirect to `loginPath?returnUrl=` / `accessDeniedPath` for cookie `mode: 'web'`.
- **Authentication middleware** is registered automatically just before routing (ASP.NET `UseAuthentication`): it only resolves `ctx.user`, never blocks.
- Controller mixin: `this.signIn(claims, { scheme, expiresIn | isPersistent })`, `this.signOut()`, `this.issueToken()`, `this.challenge()`, `this.forbid()`, `this.currentUser()`.

Tests: `test/auth.test.js` — JWT (HS/RS/PS/ES, tampering, alg allow-list, expiry, iss/aud), password hasher (salt, constant time, needsRehash), principal, policies/evaluate/enforce with ProblemDetails, cookie sign-in/out/rotation/web redirect, controller resolution, and an end-to-end run through a real HTTP server with routes + controllers (route-level, controller-level, in-action authorization, bearer + cookie sign-in). Docs: `docs/AUTHENTICATION.md`, README section.

## 2.2.0

- `createScope()` / `useScope()` (ASP.NET `IServiceScopeFactory.CreateScope`) for scoped services outside requests; lazy per-request scoped resolution (2.1.x).
