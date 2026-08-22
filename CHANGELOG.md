# MasterController Changelog

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
