# Authentication & Authorization (v2.3.0)

MasterController's auth mirrors ASP.NET Core: **schemes** authenticate (JWT bearer, signed cookie, custom), **policies** authorize, `[Authorize]` lives on routes and controllers, and the caller is a `ClaimsPrincipal` on `this.user`. No extra dependencies — JWT and the password hasher use `node:crypto`.

| ASP.NET Core | MasterController |
|---|---|
| `AddAuthentication().AddJwtBearer(...)` | `master.auth.addJwtBearer('bearer', { secret \| publicKey, issuer, audience })` |
| `AddAuthentication().AddCookie(...)` | `master.auth.addCookie('cookie', { secret, loginPath, mode: 'web' \| 'api' })` |
| custom `AuthenticationHandler` | `master.auth.addScheme('apiKey', { type: 'custom', authenticate(requestObject) })` |
| `AddAuthorization(o => o.AddPolicy(...))` | `master.auth.addPolicy('AdminOnly', { roles: ['admin'] })` / `(user, ctx) => bool` |
| `[Authorize]`, `[Authorize(Roles = "…")]`, `[Authorize(Policy = "…")]` | route `{ authorize: true \| 'Policy' \| { roles, claims, schemes } }`, controller `static authorize` |
| `[AllowAnonymous]` | route `{ allowAnonymous: true }`, controller `static allowAnonymous = true \| ['index']` |
| `HttpContext.User` | `this.user` / `requestObject.user` (`isAuthenticated`, `id`, `name`, `roles`, `claims`, `hasClaim()`, `isInRole()`) |
| `SignInAsync` / `SignOutAsync` | `await this.signIn(claims, { scheme })` / `await this.signOut({ scheme })` |
| `JwtSecurityTokenHandler` | `master.auth.issueToken(claims, { expiresIn: '15m' })`, `verifyToken(token)` |
| `PasswordHasher<TUser>` | `master.auth.passwordHasher.hash(pw)` / `verify(pw, stored)` (scrypt) |
| `UseAuthentication()` | registered automatically before routing (never blocks; authorization decides) |
| `ChallengeAsync` / `ForbidAsync` | 401 / 403 as RFC 7807 `application/problem+json` (+ `WWW-Authenticate`), or a redirect for cookie `mode: 'web'` |

## Setup

```js
// server.js — after master.setupServer()
master.auth.addJwtBearer('bearer', {
  secret: process.env.JWT_SECRET,          // >= 32 chars (HS256); or publicKey + algorithm: 'RS256' | 'ES256' | 'PS256'
  issuer: 'my-api', audience: 'my-app',
  expiresIn: '1h',                          // default for issueToken()
});
master.auth.addCookie('cookie', {
  secret: [process.env.COOKIE_SECRET, process.env.COOKIE_SECRET_PREVIOUS],   // rotation: sign with the first, accept all
  mode: 'web', loginPath: '/login', accessDeniedPath: '/denied',            // 'api' (default) answers 401/403 JSON instead
  maxAgeMs: 14 * 24 * 3600 * 1000, slidingExpiration: true, sameSite: 'lax',
});
master.auth.setDefaultScheme('bearer');     // DefaultAuthenticateScheme (first registered by default)

master.auth.addPolicy('AdminOnly', { roles: ['admin'] });                          // any of the roles
master.auth.addPolicy('Verified', { claims: { email_verified: true } });           // all claims must match
master.auth.addPolicy('Senior', (user, requestObject) => Number(user.findFirst('level')) >= 5);
```

## Protecting routes and controllers

```js
// app/routes.js
router.route('/admin/reports', 'reports#index', 'get', { authorize: { roles: ['admin'] } });
router.route('/me', 'account#me', 'get', { authorize: true });                 // any authenticated user
router.route('/billing', 'billing#index', 'get', { authorize: 'Verified' });   // policy
router.route('/health', 'health#index', 'get', { allowAnonymous: true });
router.route('/partner', 'partner#index', 'get', { authorize: { schemes: ['apiKey'] } });   // a specific scheme
router.resources('posts', { authorize: true, except: ['index', 'show'] });     // only/except supported

// app/controllers/postsController.js
export default class PostsController {
  static authorize = { '*': true, index: false, show: false };   // per action; '*' is the default
  static allowAnonymous = ['health'];                             // alternative opt-out list

  async destroy(obj) {
    if (!(await this.authorize('AdminOnly'))) return;  // in-action check: writes 401/403 itself
    // ...
  }
  async me() { this.returnJson({ id: this.user.id, name: this.user.name, roles: this.user.roles }); }
}
```

Order of enforcement: route-level `authorize` → controller-level `static authorize` → your `beforeAction` filters → the action. A route with `allowAnonymous: true` skips the controller-level requirement.

## Signing in and out

```js
export default class SessionController {
  async login(obj) {
    const { email, password } = obj.params.formData;
    const user = await this.db.User.where('u => u.email == $$', email).single();
    const { valid, needsRehash } = user ? await master.auth.passwordHasher.verify(password, user.passwordHash) : { valid: false };
    if (!valid) return this.returnError(401, 'Invalid credentials');
    if (needsRehash) { user.passwordHash = await master.auth.passwordHasher.hash(password); await this.db.saveChanges(); }

    // API clients: issue a JWT
    const { token } = await this.signIn({ sub: user.id, name: user.name, roles: user.roles }, { scheme: 'bearer', expiresIn: '15m' });
    // Browser clients: set the signed auth cookie (session id is rotated automatically)
    // await this.signIn({ sub: user.id, name: user.name, roles: user.roles }, { scheme: 'cookie', isPersistent: true });
    this.returnJson({ token });
  }
  async logout() { await this.signOut({ scheme: 'cookie' }); this.returnJson({ ok: true }); }
}
```

## Custom schemes (API keys, external identity providers)

```js
master.auth.addScheme('apiKey', {
  type: 'custom',
  async authenticate(requestObject) {
    const key = requestObject.request.headers['x-api-key'];
    const partner = key && await lookupPartner(key);
    return partner ? { sub: partner.id, name: partner.name, roles: ['partner'] } : null;   // claims or null
  },
  challenge(requestObject) { requestObject.response.writeHead(401, { 'WWW-Authenticate': 'ApiKey' }); requestObject.response.end(); },
});
```

## ClaimsPrincipal

`requestObject.user` is always set once a request reaches routing (an anonymous principal when nothing authenticates). Claims come from the JWT payload / cookie / custom result: `sub` → `id`, `name`/`preferred_username`/`email` → `name`, `role`/`roles` → `roles`. `hasClaim(type, value?)`, `isInRole(role)`, `findFirst(type)`, `findAll(type)`, `toJSON()`.

## Security notes

- HMAC secrets must be ≥ 32 characters; cookies are HMAC-SHA256 signed (`payload.signature`, base64url) and verified in constant time; `secret` can be an array for rotation.
- JWT verification enforces the algorithm allow-list (no `alg: none`), `exp`/`nbf` with 60 s tolerance, `iss`/`aud` when configured.
- Cookie sign-in rotates the session id when sessions are enabled (fixation defense), sets `HttpOnly`, `SameSite`, and `Secure` automatically on TLS (`secure: 'auto'`).
- Password hashing is scrypt (N=2^15, r=8, p=1, 64-byte key, 16-byte salt) with `needsRehash` for parameter upgrades.
