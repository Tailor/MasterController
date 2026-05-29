# Security Quick Start Guide

**Goal:** Enable automatic security enforcement in 5 minutes

> **MasterController v2.0+ is ESM-only.** All examples below use `import` syntax. Your `package.json` must have `"type": "module"`. For CJS see v1.x docs.

> **🔐 v2.0.4 changes:** This guide is updated for the v2.0.4 security release. Key changes you must know about:
> - Static files now default to `<root>/public/` (no app-root fallback)
> - `master.trustedProxies` must be set if you deploy behind a reverse proxy
> - `master.session.regenerate(req, res)` is required after login for fixation defense
> - `master.startHttpToHttpsRedirect(80, host, allowedHosts)` now throws if `allowedHosts` is missing
> - CSRF tokens are session-bound and single-use — clients must capture the `X-CSRF-Token` response header
> - CORS no longer combines wildcard origin with `credentials: true`

---

## Step 1: Update config/initializers/config.js

Add these lines at the top of your config file:

```javascript
// config/initializers/config.js
import master from 'mastercontroller';
import SecurityEnforcement from 'mastercontroller/security/SecurityEnforcement.js';

// ===========================
// CONFIGURE REVERSE PROXY (v2.0.4+)
// ===========================
// If you're behind nginx, ALB, Cloudflare, or k8s ingress, set this BEFORE
// any security middleware. Without it, HTTPS enforcement and rate limiting
// will be broken (the framework will see all requests as HTTP from the proxy).
master.trustedProxies = ['127.0.0.1', '::1'];  // add your proxy IPs

// ===========================
// AUTOMATIC SECURITY ENFORCEMENT
// ===========================

const securityConfig = SecurityEnforcement.init({
    csrf: true,                // Auto-validate CSRF tokens (session-bound in v2.0.4+)
    sanitizeInputs: true,      // Auto-sanitize all user inputs
    httpsOnly: true,           // Require HTTPS in production
    csrfExcludePaths: [        // Paths that don't need CSRF (segment-matched in v2.0.4+)
        '/api/webhook',
        '/api/public'
    ]
});

// Register security middleware (IMPORTANT!)
master.pipeline.use(SecurityEnforcement.middleware(securityConfig));

// ===========================
// STATIC FILES (v2.0.4+)
// ===========================
// Default: serves from <master.root>/public/. If you have no static assets
// (pure API), nothing to do — static serving is off when there's no public/.
// To override:
//   master.staticRoot = path.join(master.root, 'assets');
// To disable explicitly:
//   master.staticRoot = false;

// ... rest of your config
```

---

## Step 2: Configure Hostname

Add hostname to your production environment config:

```json
// config/environments/env.production.json
{
    "server": {
        "hostname": "yourapp.com",
        "httpsPort": 443,
        "requestTimeout": 120000
    },
    "error": {
        "showStackTrace": false
    }
}
```

---

## Step 3: Include CSRF Tokens in Forms

### HTML Forms

```html
<form method="POST" action="/users">
    <!-- Add CSRF token -->
    <input type="hidden" name="_csrf" value="<%= this.generateCSRFToken() %>">

    <input type="text" name="username">
    <input type="email" name="email">
    <button type="submit">Create User</button>
</form>
```

### AJAX Requests (v2.0.4+ — capture rotated token)

```javascript
// Get initial CSRF token from meta tag
let csrfToken = document.querySelector('meta[name="csrf-token"]').content;

async function apiCall(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken
        },
        body: JSON.stringify(body)
    });
    // v2.0.4+: server rotates the token on every successful validation and
    // returns the fresh one in this header. Update your stored token so the
    // NEXT request will succeed. Without this, the second request 403s.
    csrfToken = res.headers.get('x-csrf-token') ?? csrfToken;
    return res;
}

apiCall('/api/users', { username: 'john', email: 'john@example.com' });
```

### Add CSRF Meta Tag to Layout

```html
<!-- app/views/layouts/master.html -->
<!DOCTYPE html>
<html>
<head>
    <meta name="csrf-token" content="<%= this.generateCSRFToken() %>">
    <!-- ... other meta tags -->
</head>
<body>
    <%= yield %>
</body>
</html>
```

---

## Step 4: Test Your Security

### Test CSRF Protection

```bash
# Should FAIL (no CSRF token)
curl -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -d '{"username":"test"}'

# Should SUCCEED (with CSRF token)
curl -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_TOKEN_HERE" \
  -d '{"username":"test"}'
```

### Test Input Sanitization

```javascript
// Try to inject XSS
const form = {
    comment: '<script>alert("XSS")</script>'
};

// After security enforcement, this will be sanitized automatically:
// "<script>alert("XSS")</script>" becomes "&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;"
```

### Test HTTPS Enforcement

```bash
# In production, HTTP request should redirect to HTTPS
curl -I http://yourapp.com/admin

# Should return:
# HTTP/1.1 301 Moved Permanently
# Location: https://yourapp.com/admin
```

---

## Step 5: Remove Manual Security Checks (Optional)

Since security is now automatic, you can remove redundant checks:

### Before (Manual)

```javascript
class UsersController {
    create(obj) {
        // Manual security checks (can remove now)
        if (!this.validateCSRF()) {
            return this.returnError(403, 'CSRF invalid');
        }

        if (!this.requireHTTPS()) {
            return;
        }

        const username = this.sanitizeInput(obj.params.formData.username);
        const email = this.sanitizeInput(obj.params.formData.email);

        // ... create user
    }
}
```

### After (Automatic)

```javascript
class UsersController {
    create(obj) {
        // All security checks done automatically!
        // Just handle the business logic
        const username = obj.params.formData.username; // Already sanitized
        const email = obj.params.formData.email;       // Already sanitized

        const user = this.userContext.create({ username, email });
        this.json({ user });
    }
}
```

---

## Common Issues

### Issue 1: CSRF Token Missing

**Error:** `403 Forbidden - CSRF token required`

**Solution:** Include CSRF token in form or header:

```html
<!-- Option 1: Form field -->
<input type="hidden" name="_csrf" value="<%= this.generateCSRFToken() %>">

<!-- Option 2: AJAX header -->
<script>
fetch(url, {
    headers: { 'X-CSRF-Token': '<%= this.generateCSRFToken() %>' }
});
</script>
```

### Issue 2: Webhook Failing CSRF Check

**Error:** External webhook blocked by CSRF

**Solution:** Exclude webhook path from CSRF:

```javascript
const securityConfig = SecurityEnforcement.init({
    csrf: true,
    csrfExcludePaths: [
        '/api/webhook',           // Your webhook path
        '/api/stripe/webhook',    // Stripe webhook
        '/api/github/webhook'     // GitHub webhook
    ]
});
```

### Issue 3: HTTPS Redirect Loop

**Error:** Infinite redirect between HTTP and HTTPS

**Solution:** Configure hostname correctly:

```json
{
    "server": {
        "hostname": "yourapp.com",  // NOT "localhost"
        "httpsPort": 443
    }
}
```

### Issue 4: Input Sanitization Breaking HTML

**Error:** Rich text editor content gets sanitized

**Solution:** Disable sanitization for specific paths:

```javascript
// Coming in v1.3.3 - For now, manually handle rich text:
class PostsController {
    create(obj) {
        // For rich text, use different validation
        const body = obj.params.formData.body;

        // Validate allowed HTML tags only
        const result = this.validate(body, {
            type: 'html',
            allowedTags: ['p', 'strong', 'em', 'a', 'ul', 'li']
        });

        if (!result.valid) {
            return this.returnError(400, 'Invalid HTML');
        }

        // ... create post
    }
}
```

---

## Configuration Options

### Full Configuration

```javascript
const securityConfig = SecurityEnforcement.init({
    // CSRF Protection
    csrf: true,                     // Enable CSRF validation
    csrfExcludePaths: [             // Paths that skip CSRF check
        '/api/webhook',
        '/api/public'
    ],

    // Input Sanitization
    sanitizeInputs: true,           // Auto-sanitize all inputs

    // HTTPS Enforcement
    httpsOnly: true,                // Redirect HTTP to HTTPS (production only)

    // Future Features
    autoEscape: true,               // Auto-escape template output (v1.3.3)

    // Security Headers (always enabled)
    headers: {
        xss: true,                  // X-XSS-Protection
        frameOptions: true,         // X-Frame-Options
        contentType: true,          // X-Content-Type-Options
        referrer: true,             // Referrer-Policy
        csp: true,                  // Content-Security-Policy
        permissions: true           // Permissions-Policy
    }
});
```

### Minimal Configuration (Development)

```javascript
// For development/testing - relaxed security
const securityConfig = SecurityEnforcement.init({
    csrf: false,                    // Disable CSRF in development
    sanitizeInputs: true,           // Keep sanitization
    httpsOnly: false                // Allow HTTP in development
});
```

---

## Security Checklist

Use this checklist to ensure your app is secure:

**v2.0.4+ required items:**
- [ ] `master.trustedProxies` configured if behind a reverse proxy (nginx, ALB, k8s ingress, Cloudflare)
- [ ] `master.staticRoot` reviewed — using default `<root>/public/` or set to a dedicated dir; NOT set to `master.root`
- [ ] `master.session.regenerate(req, res)` called in login/logout/password-change/role-escalation handlers
- [ ] `master.startHttpToHttpsRedirect(80, host, allowedHosts)` — third arg is non-empty array of allowed hostnames
- [ ] CSRF tokens are generated with the session ID: `generateCSRFToken(req.sessionId)`
- [ ] Client AJAX code captures and reuses `X-CSRF-Token` from each response
- [ ] CORS is configured with explicit origin list (NOT `origin: '*'` with `credentials: true`, NOT `origin: true` with `credentials: true`)

**General:**
- [ ] Security enforcement enabled in `config/initializers/config.js`
- [ ] Hostname configured in `config/environments/env.production.json`
- [ ] CSRF tokens included in all forms
- [ ] CSRF meta tag in layout
- [ ] AJAX requests include X-CSRF-Token header
- [ ] Webhook paths excluded from CSRF (note: exclude paths are segment-boundary matched in v2.0.4+)
- [ ] HTTPS certificate installed
- [ ] Testing: CSRF validation works
- [ ] Testing: XSS blocked in forms
- [ ] Testing: Path traversal blocked
- [ ] Testing: HTTPS redirect works
- [ ] Testing: `GET /server.js`, `GET /package.json`, `GET /.env` all return 404 (source not exposed)

---

## Next Steps

1. **Run Security Tests:**
   ```bash
   npm test test/security/
   ```

2. **Test with SSL Labs:**
   ```
   https://www.ssllabs.com/ssltest/analyze.html?d=yourapp.com
   ```

3. **Test with Security Headers:**
   ```
   https://securityheaders.com/?q=yourapp.com
   ```

4. **Read Full Documentation:**
   - `SECURITY-FIXES-v1.3.2.md` - All fixes explained
   - `SECURITY-AUDIT-ACTION-SYSTEM.md` - Security audit details
   - `README.md` - General documentation

---

## Support

**Issues:** https://github.com/alexanderrich/MasterController/issues
**Security:** security@mastercontroller.com

---

**You're Done!** Your app now has industry-standard security.
