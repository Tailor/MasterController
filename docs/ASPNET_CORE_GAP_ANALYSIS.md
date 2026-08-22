# MasterController vs ASP.NET Core — enterprise gap analysis

*Audit of MasterController 2.2.0 (Aug 2026) against ASP.NET Core 9/10 (with Ruby on Rails 8 as a cross-check), ranked by what an enterprise team expects to exist before calling a framework ".NET-level". Status line at the bottom is updated as items ship.*

## How this was done

Every ASP.NET Core building block (hosting, DI, configuration, middleware, routing, controllers/minimal APIs, model binding + validation, authentication/authorization, data protection, caching, health, logging, background services, real-time, OpenAPI, testing, localization, deployment) was checked against the 2.2.0 source (`MasterControl.js`, `MasterRouter.js`, `MasterRequest.js`, `MasterAction.js`, `MasterPipeline.js`, `MasterActionFilters.js`, `security/*`, `monitoring/*`, `error/*`) and README. "Have" means the feature exists and is usable; "partial" means a piece exists but not the ASP.NET contract; "missing" means nothing.

## Scorecard

| Area | ASP.NET Core | MasterController 2.2.0 | Verdict |
|---|---|---|---|
| Hosting / server | Kestrel, HTTPS, HSTS, HTTP→HTTPS redirect, timeouts, proxy headers, graceful shutdown | `setupServer('http'\|'https')`, TLS from env + hot reload, `enableHSTS`, redirect, timeout system, trusted proxies, SIGTERM flush | **have** |
| Middleware pipeline | `Use`/`Map`/`UseWhen`/exception handler, ordering | `pipeline.use/run/map/useError`, file auto-discovery with numeric ordering | **have** |
| Dependency injection | Singleton / Scoped / Transient, scopes (`CreateScope`), constructor injection | `addSingleton/addScoped/addTransient`, lazy per-request scoped resolution, `createScope()/useScope()`; services on `this` | **have** (2.1–2.2) |
| Routing | conventional + attribute routing, constraints, route groups, named routes / URL generation, `resources`-style | `router.route/resources`, `:param`, constraint functions, controller auto-discovery | partial — no route groups/areas, no named routes / `urlFor`, no typed constraints (`:id(int)`) |
| Controllers & results | `ControllerBase` helpers (Ok/Created/NoContent/Problem/File/...), filters (auth/resource/action/exception/result), `TempData` | `returnJson/returnError/redirectTo/returnView/partial`, before/after action filters, MasterTemp (TempData) | partial — no typed result helpers (`created`, `noContent`, `file`, `problem`), no exception/result filters |
| Model binding | `[FromBody]/[FromQuery]/[FromRoute]/[FromForm]`, typed binding, `ModelState` | `obj.params` (route/query/formData/files), multipart via formidable | partial — no typed binding into objects, no ModelState |
| Validation | DataAnnotations / FluentValidation, automatic 400 with ProblemDetails | `MasterValidator` (strings/ints/email/url/uuid/injection scans), `validateRequest(schema)` | partial — no declarative per-action schema binding, no `ValidationProblemDetails` |
| Error responses | RFC 7807 `ProblemDetails` / `ValidationProblemDetails`, `UseExceptionHandler`, content negotiation | structured `{ error }` JSON, error pages, content negotiation, request ids | partial — **no ProblemDetails** shape |
| **Authentication** | cookie, JWT bearer, OpenID Connect, schemes, `SignIn/SignOut`, `HttpContext.User` | **nothing** (sessions + CSRF only) | **missing — #1 gap** |
| **Authorization** | `[Authorize(Roles/Policy)]`, `[AllowAnonymous]`, policies/requirements/handlers, resource-based | route constraints / beforeAction hand-rolled | **missing** |
| Identity | `UserManager`/`SignInManager`, password hasher, tokens, lockout, 2FA | nothing | missing (password hashing + token primitives are the minimum) |
| Data protection | `IDataProtector` purpose-bound encrypt/unprotect, key ring | `tools.encrypt/decrypt(secret)`, cookie signing in sessions | partial — no purpose-scoped protector / key rotation |
| Configuration | layered `appsettings.json` + env-specific + env vars + user-secrets + command line; `IOptions<T>` with validation | `config/environments/env.<env>.json` (flat), `process.env` by hand | partial — no layering, no env-var overrides, no secrets, **no Options pattern** |
| Logging | `ILogger<T>` categories/levels/scopes, providers, structured | winston-based error logger, request ids | partial — no category logger API for app code, no scopes |
| Health checks | `AddHealthChecks().AddCheck()`, readiness/liveness, tags | `HealthCheck.addCheck`, `/_health`, memory, cache | **have** (add readiness/liveness split) |
| Metrics / tracing | OpenTelemetry, `/metrics` | Prometheus exporter, profiler, perf monitor | have (no tracing) |
| Caching | `IMemoryCache`, `IDistributedCache` (Redis), response caching, output caching | `MasterCache` (LRU), ETag/Cache-Control helpers, Redis adapters for sessions/rate-limit/CSRF | partial — no distributed cache abstraction, **no output caching** |
| Response compression | `UseResponseCompression` (gzip/br) | nothing | **missing** |
| Rate limiting | `AddRateLimiter` (fixed/sliding/token/concurrency), policies, 429 | fixed-window limiter, Redis store, 429 | have (one algorithm) |
| CORS / security headers / CSRF / sessions / static files / uploads | yes | yes (hardened in 2.0.4–2.1.x) | **have** |
| Background work | `IHostedService`/`BackgroundService`, `PeriodicTimer`, hosted lifetime, queues | nothing | **missing** |
| Real-time | SignalR hubs, groups, auth | socket.io integration, socket controllers | have |
| Views / components | Razor, view components, partials, layouts | view engines, `extendView`, components | have |
| OpenAPI | built-in OpenAPI document + Swagger UI | nothing | **missing** |
| API versioning | `Asp.Versioning` | nothing | missing |
| Localization | `IStringLocalizer`, request culture | nothing | missing |
| Testing | `WebApplicationFactory` / `TestServer` (in-process, no port) | spin a real server | missing |
| Minimal APIs | `app.MapGet(path, handler)` | controllers only | missing (cheap to add) |
| File results / streaming | `File()`, ranges, streaming | static streaming, `fileToBuffer` | partial — no `this.file()` result |
| Tooling (CLI) | `dotnet new/watch/test/publish/user-secrets/ef` | `master new/g/dev/build/start/db/routes` | partial — see Master CLI below |

## Ranked implementation plan (each its own release with tests + docs)

1. **2.3.0 — Authentication & Authorization** (ASP.NET `AddAuthentication().AddJwtBearer()/AddCookie()`, `AddAuthorization(policies)`, `[Authorize]`, `[AllowAnonymous]`, `HttpContext.User`): `master.auth.addScheme('bearer'|'cookie', opts)`, JWT HS256/RS256/ES256 issue+verify with `node:crypto` (no dependencies), signed cookie scheme, `requestObject.user` (`isAuthenticated, id, name, roles, claims, hasClaim, isInRole`), `master.auth.addPolicy(name, handler)`, authorization at route level (`{ authorize: { roles, policy, schemes } }`), controller level (`static authorize = {…}` / `this.authorize()`), `allowAnonymous`, `this.signIn(principal)/signOut()`, challenge → 401 / forbid → 403 as ProblemDetails, `master.passwordHasher` (scrypt, constant-time verify, rehash-needed).
2. **2.4.0 — Model binding, validation, ProblemDetails**: `this.bind(schema, { from: 'body'|'query'|'route'|'form' })`/`static schemas`, ModelState, automatic `400 ValidationProblemDetails`, RFC 7807 `this.problem(...)` and global exception → ProblemDetails, typed result helpers (`ok/created/noContent/accepted/notFound/file`), route-param typed constraints.
3. **2.5.0 — Configuration & Options**: layered `appsettings.json` → `appsettings.{env}.json` → `config/environments/env.{env}.json` → `secrets.json` (user-secrets outside repo) → env vars (`MASTER__Section__Key`) → CLI args; `master.config.get('Section:Key')`; `master.options(name, { schema, validate })` (Options pattern, validated at startup, injected as `this.options.<name>`).
4. **2.6.0 — Hosted services & background work**: `master.addHostedService(Class)` (start/stop ordering, graceful shutdown with timeout), `BackgroundService` base with `executeAsync(signal)`, `PeriodicTimerService`, in-memory background queue.
5. **2.7.0 — Logging**: `master.createLogger(category)` → `ILogger`-like (levels, structured scopes, request correlation), providers (console/json/winston), `this.logger` in controllers/services.
6. **2.8.0 — Output/response caching + response compression**: `master.useResponseCompression()` (gzip/br, content-type allowlist), `master.outputCache(policy)` with tags/vary-by; `IDistributedCache`-style `master.cache` (memory/Redis).
7. **2.9.0 — OpenAPI**: generate `/openapi.json` from routes + bound schemas + auth schemes; optional Swagger UI page.
8. **2.10.0 — Testing host**: `master.createTestClient()` (in-process request without a socket; returns status/headers/body), fixtures for scoped services.
9. **2.11.0 — Routing extras + minimal APIs + API versioning + localization**: route groups/areas, named routes + `urlFor`, `master.map.get(path, handler)`, `?api-version`/header versioning, `IStringLocalizer` + request culture.

## Master CLI vs `dotnet` CLI

| dotnet | master | Gap |
|---|---|---|
| `dotnet new <template>` | `master new` (one template) | add `--template api|web|worker`, `--auth` |
| `dotnet watch` | `master dev` | have |
| `dotnet test` | none (per-package) | `master test` running backend tests |
| `dotnet ef migrations add/update/remove/script/list` | `master db new/migrate/rollback/list` | add `status`, `script`, `remove` (MasterRecord 1.11/1.15 have them) |
| `dotnet user-secrets` | none | `master secrets set/list/remove` (pairs with 2.5.0 configuration) |
| `dotnet publish` | `master build` | add Dockerfile/compose template in scaffold |
| Scaffolded `DbContext` is **scoped** per request | scaffold exports a **singleton** context (`db.js`) | fix: register `AppContext` via `master.addScoped` (MasterRecord 1.5.x lost-write class of bugs) |

## Rails cross-check

Rails pieces worth matching that ASP.NET also has: generators ✓, migrations ✓, `has_secure_password` (→ password hasher, 2.3.0), `before_action` ✓, strong parameters (→ bind/validate, 2.4.0), credentials (→ secrets, 2.5.0), Active Job (→ hosted services/queue, 2.6.0), ActionCable ✓ (sockets), caching (2.8.0), i18n (2.11.0).

## Status

- 2.3.0 … (updated as releases ship)
