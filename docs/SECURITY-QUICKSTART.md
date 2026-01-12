# Security Quick Start Guide

**Goal:** Enable automatic security enforcement in 5 minutes

---

## Step 1: Update config/initializers/config.js

Add these lines at the top of your config file:

```javascript
// config/initializers/config.js
var master = require('mastercontroller');
const SecurityEnforcement = require('mastercontroller/security/SecurityEnforcement');

// ===========================
// AUTOMATIC SECURITY ENFORCEMENT
// ===========================

const securityConfig = SecurityEnforcement.init({
    csrf: true,                // Auto-validate CSRF tokens
    sanitizeInputs: true,      // Auto-sanitize all user inputs
    httpsOnly: true,           // Require HTTPS in production
    csrfExcludePaths: [        // Paths that don't need CSRF (webhooks, APIs)
        '/api/webhook',
        '/api/public'
    ]
});

// Register security middleware (IMPORTANT!)
master.pipeline.use(SecurityEnforcement.middleware(securityConfig));

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

### AJAX Requests

```javascript
// Get CSRF token from meta tag
const csrfToken = document.querySelector('meta[name="csrf-token"]').content;

// Include in request
fetch('/api/users', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken
    },
    body: JSON.stringify({
        username: 'john',
        email: 'john@example.com'
    })
});
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

- [ ] Security enforcement enabled in `config/initializers/config.js`
- [ ] Hostname configured in `config/environments/env.production.json`
- [ ] CSRF tokens included in all forms
- [ ] CSRF meta tag in layout
- [ ] AJAX requests include X-CSRF-Token header
- [ ] Webhook paths excluded from CSRF
- [ ] HTTPS certificate installed
- [ ] Testing: CSRF validation works
- [ ] Testing: XSS blocked in forms
- [ ] Testing: Path traversal blocked
- [ ] Testing: HTTPS redirect works

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
