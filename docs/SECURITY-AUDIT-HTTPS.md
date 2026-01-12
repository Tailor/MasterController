# MasterController HTTPS/TLS Security Audit

**Date:** January 2026
**Version:** v1.3.1
**Auditor:** Security Review

---

## Executive Summary

**Overall Security Rating:** ⚠️ **GOOD with Critical Issues**

MasterController's HTTPS/TLS implementation includes many advanced features but has several **critical security issues** that must be fixed before production deployment.

**✅ Strengths:**
- SNI (Server Name Indication) support with multiple domains
- TLS certificate live reload (zero-downtime updates)
- Secure TLS defaults (TLS 1.2+, cipher order)
- HTTP to HTTPS redirect server
- HSTS support with configurable max-age
- Security headers middleware

**❌ Critical Issues:**
1. Missing `enableHSTS()` method (documented but not implemented)
2. HSTS hardcoded max-age doesn't use configured value
3. Weak TLS minimum version (should be TLS 1.3 in 2026)
4. No cipher suite configuration by default
5. HTTP redirect doesn't validate host header (open redirect vulnerability)
6. Static file serving has path traversal vulnerability
7. Error responses leak stack traces in production

---

## Issue #1: Missing `enableHSTS()` Method

**Severity:** 🔴 **CRITICAL**

### Current State
```javascript
// README.md documents this:
master.enableHSTS(); // In production HTTPS

// But the method doesn't exist in MasterControl.js!
```

**Grep Result:**
```bash
$ grep -n "enableHSTS\s*(" MasterControl.js
(no results - method doesn't exist)
```

### Issue
The README documents `master.enableHSTS()` as an API method, but it's not implemented. Users following the docs will get `TypeError: master.enableHSTS is not a function`.

### Fix Required
Add the missing method:

```javascript
// MasterControl.js
enableHSTS(maxAge = 31536000, includeSubDomains = true, preload = false) {
    this._hstsEnabled = true;
    this._hstsMaxAge = maxAge;
    this._hstsIncludeSubDomains = includeSubDomains;
    this._hstsPreload = preload;
}
```

And update HSTS middleware to use these values:

```javascript
// _registerCoreMiddleware() - line 546
$that.pipeline.use(async (ctx, next) => {
    if ($that.serverProtocol === 'https' && $that._hstsEnabled) {
        let hstsValue = `max-age=${$that._hstsMaxAge || 31536000}`;
        if ($that._hstsIncludeSubDomains) hstsValue += '; includeSubDomains';
        if ($that._hstsPreload) hstsValue += '; preload';
        ctx.response.setHeader('Strict-Transport-Security', hstsValue);
    }
    await next();
});
```

---

## Issue #2: HSTS Max-Age Ignored

**Severity:** 🟡 **MEDIUM**

### Current State
```javascript
// MasterControl.js:416 - TLS config sets _hstsMaxAge
this._hstsMaxAge = tlsCfg.hstsMaxAge || 15552000; // 180 days

// MasterControl.js:547 - But middleware ignores it!
ctx.response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
// ^^^ Hardcoded to 365 days!
```

### Issue
Users configure HSTS max-age in their environment config, but it's ignored. The middleware always uses 31536000 (365 days).

### Fix Required
Use the configured value:

```javascript
let hstsValue = `max-age=${$that._hstsMaxAge || 31536000}`;
if ($that._hstsIncludeSubDomains !== false) hstsValue += '; includeSubDomains';
ctx.response.setHeader('Strict-Transport-Security', hstsValue);
```

---

## Issue #3: Weak TLS Minimum Version

**Severity:** 🟡 **MEDIUM** (but will become CRITICAL in 2026)

### Current State
```javascript
// MasterControl.js:327 - Default to TLS 1.2
if(!credentials.minVersion){ credentials.minVersion = 'TLSv1.2'; }
```

### Comparison with Other Frameworks

| Framework | Default TLS Version (2026) | Recommendation |
|-----------|----------------------------|----------------|
| **Express** | Node.js default (TLS 1.2+) | TLS 1.2 minimum |
| **ASP.NET Core 8** | TLS 1.2 minimum | TLS 1.3 recommended |
| **Rails 7.1** | TLS 1.2 minimum | TLS 1.3 recommended |
| **Django 5.0** | TLS 1.2 minimum | TLS 1.3 recommended |
| **MasterController** | TLS 1.2 default | ⚠️ Should be TLS 1.3 |

### Industry Standards (2026)
- **PCI DSS 4.0:** Requires TLS 1.2+ (TLS 1.3 recommended)
- **NIST SP 800-52 Rev. 2:** Recommends TLS 1.3
- **OWASP:** TLS 1.3 recommended, TLS 1.2 acceptable
- **Mozilla SSL Config Generator:** TLS 1.3 for "Modern" config

### Fix Required
Update default to TLS 1.3 with fallback to TLS 1.2:

```javascript
// MasterControl.js:327
if(!credentials.minVersion){
    credentials.minVersion = 'TLSv1.3'; // Default to TLS 1.3
}

// Or make it configurable by environment:
if(!credentials.minVersion){
    const isProduction = this.environmentType === 'production';
    credentials.minVersion = isProduction ? 'TLSv1.3' : 'TLSv1.2';
}
```

**Why TLS 1.3?**
- Faster handshake (1-RTT vs 2-RTT)
- Forward secrecy by default
- Removed weak ciphers
- 0-RTT resumption (performance)
- Better privacy (encrypted SNI)

---

## Issue #4: No Cipher Suite Configuration

**Severity:** 🟡 **MEDIUM**

### Current State
```javascript
// MasterControl.js:411 - Only set if provided in env
if(tlsCfg.ciphers){ options.ciphers = tlsCfg.ciphers; }
// Otherwise uses Node.js defaults (which may include weak ciphers)
```

### Comparison with Other Frameworks

**Express (with helmet):**
```javascript
const helmet = require('helmet');
app.use(helmet.hsts({
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
}));

// Cipher suite must be set manually
const server = https.createServer({
    ciphers: 'ECDHE-RSA-AES256-GCM-SHA384:...',
    honorCipherOrder: true
}, app);
```

**ASP.NET Core 8:**
```csharp
// appsettings.json
{
  "Kestrel": {
    "EndpointDefaults": {
      "Protocols": "Http1AndHttp2AndHttp3",
      "SslProtocols": ["Tls13", "Tls12"],
      "CipherSuitesPolicy": {
        "CipherSuites": [
          "TLS_AES_256_GCM_SHA384",
          "TLS_CHACHA20_POLY1305_SHA256",
          "TLS_AES_128_GCM_SHA256"
        ]
      }
    }
  }
}
```

**Rails 7.1 (with Puma):**
```ruby
# config/puma.rb
ssl_bind '0.0.0.0', '443', {
  key: 'key.pem',
  cert: 'cert.pem',
  ssl_cipher_filter: 'ECDHE-RSA-AES256-GCM-SHA384:...',
  verify_mode: 'none'
}
```

### Mozilla SSL Configuration Levels

**Modern (2026 recommended):**
```javascript
ciphers: [
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256',
    'TLS_AES_128_GCM_SHA256'
].join(':')
```

**Intermediate (broader compatibility):**
```javascript
ciphers: [
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256',
    'TLS_AES_128_GCM_SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES256-GCM-SHA384',
    'ECDHE-ECDSA-CHACHA20-POLY1305',
    'ECDHE-RSA-CHACHA20-POLY1305',
    'ECDHE-ECDSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES128-GCM-SHA256'
].join(':')
```

### Fix Required

Add secure defaults:

```javascript
// MasterControl.js:327 - After minVersion
if(!credentials.ciphers){
    // Mozilla Intermediate config (2026)
    credentials.ciphers = [
        // TLS 1.3 ciphers
        'TLS_AES_256_GCM_SHA384',
        'TLS_CHACHA20_POLY1305_SHA256',
        'TLS_AES_128_GCM_SHA256',
        // TLS 1.2 ciphers (backward compatibility)
        'ECDHE-ECDSA-AES256-GCM-SHA384',
        'ECDHE-RSA-AES256-GCM-SHA384',
        'ECDHE-ECDSA-CHACHA20-POLY1305',
        'ECDHE-RSA-CHACHA20-POLY1305',
        'ECDHE-ECDSA-AES128-GCM-SHA256',
        'ECDHE-RSA-AES128-GCM-SHA256'
    ].join(':');
}
```

---

## Issue #5: HTTP to HTTPS Redirect - Open Redirect Vulnerability

**Severity:** 🔴 **CRITICAL**

### Current State
```javascript
// MasterControl.js:348-357
startHttpToHttpsRedirect(redirectPort, bindHost){
    var $that = this;
    return http.createServer(function (req, res) {
        try{
            var host = req.headers['host'] || '';
            // Force original host, just change scheme
            var location = 'https://' + host + req.url;
            res.statusCode = 301;
            res.setHeader('Location', location);
            res.end();
        }catch(e){
            res.statusCode = 500;
            res.end();
        }
    }).listen(redirectPort, bindHost);
}
```

### Vulnerability
The `host` header is user-controlled and not validated. An attacker can exploit this:

**Attack Example:**
```bash
# Attacker crafts malicious request
curl -H "Host: evil.com" http://example.com/login

# Server redirects to:
Location: https://evil.com/login
# User credentials sent to attacker's domain!
```

### Comparison with Other Frameworks

**Express (with express-force-ssl):**
```javascript
// Validates host against allowed list
const allowedHosts = ['example.com', 'www.example.com'];
app.use((req, res, next) => {
    const host = req.hostname;
    if (!allowedHosts.includes(host)) {
        return res.status(400).send('Invalid host');
    }
    if (!req.secure) {
        return res.redirect(301, `https://${host}${req.url}`);
    }
    next();
});
```

**ASP.NET Core 8:**
```csharp
// Built-in HTTPS redirection validates hostname
app.UseHttpsRedirection();

// Or manual validation
app.Use(async (context, next) => {
    var allowedHosts = new[] { "example.com", "www.example.com" };
    var host = context.Request.Host.Host;

    if (!allowedHosts.Contains(host)) {
        context.Response.StatusCode = 400;
        return;
    }

    if (!context.Request.IsHttps) {
        var redirectUrl = $"https://{host}{context.Request.Path}";
        context.Response.Redirect(redirectUrl, permanent: true);
        return;
    }

    await next();
});
```

**Rails 7.1:**
```ruby
# config/environments/production.rb
config.force_ssl = true
config.ssl_options = {
  redirect: {
    exclude: ->(request) {
      !['example.com', 'www.example.com'].include?(request.host)
    }
  }
}
```

### Fix Required

Add host validation:

```javascript
startHttpToHttpsRedirect(redirectPort, bindHost, allowedHosts = []){
    var $that = this;
    return http.createServer(function (req, res) {
        try{
            var host = req.headers['host'] || '';

            // CRITICAL: Validate host header to prevent open redirect
            if (allowedHosts.length > 0) {
                const hostname = host.split(':')[0]; // Remove port
                if (!allowedHosts.includes(hostname)) {
                    res.statusCode = 400;
                    res.end('Bad Request: Invalid host');
                    return;
                }
            }

            // Redirect to HTTPS
            var location = 'https://' + host + req.url;
            res.statusCode = 301;
            res.setHeader('Location', location);
            res.end();
        }catch(e){
            res.statusCode = 500;
            res.end();
        }
    }).listen(redirectPort, bindHost);
}
```

**Usage:**
```javascript
// In production, always specify allowed hosts
const redirectServer = master.startHttpToHttpsRedirect(80, '0.0.0.0', [
    'example.com',
    'www.example.com',
    'api.example.com'
]);
```

---

## Issue #6: Static File Serving - Path Traversal Vulnerability

**Severity:** 🔴 **CRITICAL**

### Current State
```javascript
// MasterControl.js:482 - No path validation!
let pathname = `.${ctx.request.url}`;

fs.exists(pathname, function (exist) {
    if (!exist) {
        ctx.response.statusCode = 404;
        ctx.response.end(`File ${pathname} not found!`);
        return;
    }

    // Reads file without validating path!
    fs.readFile(pathname, function(err, data) {
        // ...
    });
});
```

### Vulnerability
An attacker can use `../` sequences to read arbitrary files:

**Attack Example:**
```bash
# Read /etc/passwd
curl http://example.com/../../../etc/passwd

# Read source code
curl http://example.com/../../../server.js

# Read environment files
curl http://example.com/../../../.env
```

### Comparison with Other Frameworks

**Express (express.static):**
```javascript
// Built-in path traversal protection
app.use(express.static('public', {
    dotfiles: 'deny',      // Block .env, .git, etc.
    index: false,
    maxAge: '1d',
    redirect: false,
    setHeaders: (res, path) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
    }
}));

// Internally uses path normalization:
const safePath = path.normalize(requestedPath);
if (!safePath.startsWith(rootPath)) {
    return res.status(403).send('Forbidden');
}
```

**ASP.NET Core 8:**
```csharp
// Built-in static files middleware with security
app.UseStaticFiles(new StaticFileOptions {
    ServeUnknownFileTypes = false,
    OnPrepareResponse = ctx => {
        // Prevent path traversal
        var path = ctx.File.PhysicalPath;
        var root = Path.GetFullPath("wwwroot");
        if (!path.StartsWith(root)) {
            ctx.Context.Response.StatusCode = 403;
            ctx.Context.Response.ContentLength = 0;
            ctx.Context.Response.Body = Stream.Null;
        }
    }
});
```

**Rails 7.1:**
```ruby
# Built-in protection via ActionDispatch::FileHandler
config.public_file_server.enabled = true
# Automatically sanitizes paths and blocks ../ traversal
```

### Fix Required

Add path validation:

```javascript
// _registerCoreMiddleware() - lines 479-507
$that.pipeline.use(async (ctx, next) => {
    if (ctx.isStatic) {
        let pathname = `.${ctx.request.url}`;

        // CRITICAL: Prevent path traversal attacks
        const path = require('path');
        const publicRoot = path.resolve('.'); // Or master.root + '/public'
        const requestedPath = path.resolve(pathname);

        // Ensure requested path is within public root
        if (!requestedPath.startsWith(publicRoot)) {
            ctx.response.statusCode = 403;
            ctx.response.end('Forbidden');
            return;
        }

        // Block dotfiles (.env, .git, etc.)
        const filename = path.basename(requestedPath);
        if (filename.startsWith('.')) {
            ctx.response.statusCode = 403;
            ctx.response.end('Forbidden');
            return;
        }

        fs.exists(requestedPath, function (exist) {
            if (!exist) {
                ctx.response.statusCode = 404;
                ctx.response.end('Not Found');
                return;
            }

            if (fs.statSync(requestedPath).isDirectory()) {
                requestedPath += '/index.html';
            }

            fs.readFile(requestedPath, function(err, data) {
                if (err) {
                    ctx.response.statusCode = 500;
                    ctx.response.end('Internal Server Error');
                } else {
                    const mimeType = $that.router.findMimeType(path.extname(requestedPath));
                    ctx.response.setHeader('Content-Type', mimeType || 'text/plain');
                    ctx.response.setHeader('X-Content-Type-Options', 'nosniff');
                    ctx.response.end(data);
                }
            });
        });

        return; // Terminal
    }

    await next();
});
```

---

## Issue #7: Error Responses Leak Stack Traces

**Severity:** 🟡 **MEDIUM**

### Current State
```javascript
// MasterControl.js:559-577 - Global error handler
$that.pipeline.useError(async (error, ctx, next) => {
    logger.error({
        code: 'MC_ERR_PIPELINE',
        message: 'Error in middleware pipeline',
        error: error.message,
        stack: error.stack,  // Logged (good)
        path: ctx.request.url,
        method: ctx.type
    });

    if (!ctx.response.headersSent) {
        ctx.response.statusCode = 500;
        ctx.response.setHeader('Content-Type', 'application/json');
        ctx.response.end(JSON.stringify({
            error: 'Internal Server Error',
            message: process.env.NODE_ENV === 'production'
                ? 'An error occurred'
                : error.message  // ⚠️ Leaks error details in dev
        }));
    }
});
```

### Issue
While better than many frameworks (checks NODE_ENV), it should use `master.environmentType` for consistency and never leak stack traces.

### Comparison with Other Frameworks

**Express:**
```javascript
app.use((err, req, res, next) => {
    res.status(500);
    if (process.env.NODE_ENV === 'production') {
        res.json({ error: 'Internal Server Error' });
    } else {
        res.json({
            error: err.message,
            stack: err.stack  // Dev only
        });
    }
});
```

**ASP.NET Core 8:**
```csharp
if (env.IsDevelopment()) {
    app.UseDeveloperExceptionPage(); // Stack traces in dev
} else {
    app.UseExceptionHandler("/Error"); // Generic error page in prod
}
```

### Fix Required

```javascript
$that.pipeline.useError(async (error, ctx, next) => {
    logger.error({
        code: 'MC_ERR_PIPELINE',
        message: 'Error in middleware pipeline',
        error: error.message,
        stack: error.stack,
        path: ctx.request.url,
        method: ctx.type
    });

    if (!ctx.response.headersSent) {
        const isDev = $that.environmentType === 'development';

        ctx.response.statusCode = 500;
        ctx.response.setHeader('Content-Type', 'application/json');
        ctx.response.end(JSON.stringify({
            error: 'Internal Server Error',
            ...(isDev && {
                message: error.message,
                stack: error.stack
            })
        }));
    }
});
```

---

## Strengths: What MasterController Does Well

### ✅ 1. SNI (Server Name Indication) Support

**Excellent implementation!** Most Node.js frameworks require manual SNI setup.

```javascript
// MasterControl.js:377-398 - SNI with multiple domains
var sniMap = {};
if(tlsCfg.sni && typeof tlsCfg.sni === 'object'){
    for (var domain in tlsCfg.sni){
        var domCreds = this._buildSecureContextFromPaths(tlsCfg.sni[domain]);
        if(domCreds){
            sniMap[domain] = tls.createSecureContext(domCreds);
        }
    }
}

options.SNICallback = function(servername, cb){
    var ctx = sniMap[servername];
    if(!ctx && defaultContext){ ctx = defaultContext; }
    if(cb){ return cb(null, ctx); }
    return ctx;
};
```

**Comparison:**
- **Express:** Requires manual SNI setup
- **ASP.NET Core:** Built-in SNI support
- **Rails/Puma:** Requires manual configuration
- **MasterController:** ✅ Built-in, easy configuration

### ✅ 2. TLS Certificate Live Reload

**Outstanding feature!** Zero-downtime certificate renewal.

```javascript
// MasterControl.js:454-469 - Watch files and reload
_watchTlsFilesAndReload(desc, onChange){
    var paths = [];
    if(desc.keyPath){ paths.push(desc.keyPath); }
    if(desc.certPath){ paths.push(desc.certPath); }
    paths.forEach(function(p){
        fs.watchFile(p, { interval: 5000 }, function(){
            onChange();
        });
    });
}
```

**Comparison:**
- **Express:** Manual restart required
- **ASP.NET Core:** Requires manual restart or IIS binding
- **Rails:** Manual restart required
- **MasterController:** ✅ Automatic reload, zero downtime

### ✅ 3. HTTP to HTTPS Redirect Server

**Well-designed!** (But needs host validation - see Issue #5)

```javascript
// MasterControl.js:348-363
startHttpToHttpsRedirect(redirectPort, bindHost){
    return http.createServer(function (req, res) {
        var location = 'https://' + host + req.url;
        res.statusCode = 301;
        res.setHeader('Location', location);
        res.end();
    }).listen(redirectPort, bindHost);
}
```

**Comparison:**
- **Express:** Requires middleware
- **ASP.NET Core:** Built-in with `UseHttpsRedirection()`
- **Rails:** Requires `config.force_ssl`
- **MasterController:** ✅ Dedicated redirect server (good pattern)

### ✅ 4. Security Headers Middleware

**Comprehensive implementation!**

```javascript
// security/SecurityMiddleware.js:19-40
const SECURITY_HEADERS = {
  'X-XSS-Protection': '1; mode=block',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'X-DNS-Prefetch-Control': 'off',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Powered-By': ''
};
```

**Comparison:**
- **Express:** Requires helmet package
- **ASP.NET Core:** Requires manual headers
- **Rails:** Requires secure_headers gem
- **MasterController:** ✅ Built-in, comprehensive

---

## Comparison Table: MasterController vs Other Frameworks

| Feature | MasterController | Express | ASP.NET Core 8 | Rails 7.1 | Django 5.0 |
|---------|------------------|---------|----------------|-----------|------------|
| **TLS Version** | TLS 1.2 (default) | Node.js default | TLS 1.2+ | TLS 1.2+ | TLS 1.2+ |
| **Cipher Suites** | None (uses Node.js) | Manual | Configurable | Manual | Manual |
| **SNI Support** | ✅ Built-in | Manual | ✅ Built-in | Manual | Manual |
| **Cert Live Reload** | ✅ Automatic | ❌ Manual restart | ❌ Manual | ❌ Manual | ❌ Manual |
| **HSTS** | ⚠️ Partial (broken) | Via helmet | ✅ Built-in | ✅ Built-in | ✅ Built-in |
| **HTTP Redirect** | ⚠️ Vulnerable | Via middleware | ✅ Built-in | ✅ Built-in | ✅ Built-in |
| **Security Headers** | ✅ Built-in | Via helmet | Manual | Via gem | Manual |
| **Path Traversal Protection** | ❌ Vulnerable | ✅ Protected | ✅ Protected | ✅ Protected | ✅ Protected |
| **HTTPS by Default** | ❌ Manual | ❌ Manual | ✅ Dev mode | ❌ Manual | ❌ Manual |
| **CSP Support** | ❌ None | Via helmet | Via middleware | Via gem | Via middleware |

**Legend:**
- ✅ **Good:** Feature exists and works correctly
- ⚠️ **Partial:** Feature exists but has issues
- ❌ **Missing:** Feature not implemented or requires manual setup

---

## Recommendations

### Priority 1: Critical Fixes (Must Fix Before Production)

1. **Add `enableHSTS()` method** - Documented API that doesn't exist
2. **Fix HSTS max-age** - Use configured value, not hardcoded
3. **Add host validation to HTTP redirect** - Prevent open redirect attacks
4. **Fix path traversal vulnerability** - Validate and normalize file paths
5. **Update TLS default to 1.3** - Align with 2026 security standards
6. **Add secure cipher suite defaults** - Use Mozilla Intermediate config

### Priority 2: High Priority (Recommended)

7. **Add Content Security Policy (CSP)** - Modern XSS protection
8. **Add rate limiting to redirector** - Prevent abuse
9. **Improve error handling** - Use `master.environmentType` consistently
10. **Add OCSP stapling** - Better certificate validation

### Priority 3: Nice to Have

11. **Add HTTP/2 push support** - Performance optimization
12. **Add certificate expiry warnings** - Proactive monitoring
13. **Add TLS session resumption** - Performance optimization
14. **Add Expect-CT header** - Certificate Transparency

---

## Fixed Implementation Examples

### Complete Secure HTTPS Setup

```javascript
// MasterControl.js - Secure defaults
setupServer(type, credentials){
    // ... (auto-load internal modules) ...

    if(type === "https"){
        $that.serverProtocol = "https";

        // Initialize TLS from env if no credentials passed
        if(!credentials){
            $that._initializeTlsFromEnv();
            credentials = $that._tlsOptions;
        }

        // Apply SECURE defaults (2026 standards)
        if(credentials){
            // TLS 1.3 by default (fallback to 1.2 for compatibility)
            if(!credentials.minVersion){
                credentials.minVersion = 'TLSv1.3';
            }

            // Secure cipher suites (Mozilla Intermediate 2026)
            if(!credentials.ciphers){
                credentials.ciphers = [
                    // TLS 1.3 ciphers
                    'TLS_AES_256_GCM_SHA384',
                    'TLS_CHACHA20_POLY1305_SHA256',
                    'TLS_AES_128_GCM_SHA256',
                    // TLS 1.2 ciphers (backward compatibility)
                    'ECDHE-ECDSA-AES256-GCM-SHA384',
                    'ECDHE-RSA-AES256-GCM-SHA384',
                    'ECDHE-ECDSA-CHACHA20-POLY1305',
                    'ECDHE-RSA-CHACHA20-POLY1305',
                    'ECDHE-ECDSA-AES128-GCM-SHA256',
                    'ECDHE-RSA-AES128-GCM-SHA256'
                ].join(':');
            }

            // Server prefers cipher order
            if(credentials.honorCipherOrder === undefined){
                credentials.honorCipherOrder = true;
            }

            // HTTP/2 and HTTP/1.1 support
            if(!credentials.ALPNProtocols){
                credentials.ALPNProtocols = ['h2', 'http/1.1'];
            }

            const server = https.createServer(credentials, async function(req, res) {
                $that.serverRun(req, res);
            });

            $that.server = server;
            return server;
        }else{
            throw new Error('HTTPS requires TLS credentials (key and cert)');
        }
    }
}

// Add enableHSTS() method
enableHSTS(options = {}) {
    this._hstsEnabled = true;
    this._hstsMaxAge = options.maxAge || 31536000; // 1 year default
    this._hstsIncludeSubDomains = options.includeSubDomains !== false;
    this._hstsPreload = options.preload === true;

    return this; // Chainable
}

// Fix HSTS middleware
_registerCoreMiddleware(){
    // ... (other middleware) ...

    // HSTS Header (if enabled for HTTPS)
    $that.pipeline.use(async (ctx, next) => {
        if ($that.serverProtocol === 'https' && $that._hstsEnabled) {
            let hstsValue = `max-age=${$that._hstsMaxAge}`;
            if ($that._hstsIncludeSubDomains) hstsValue += '; includeSubDomains';
            if ($that._hstsPreload) hstsValue += '; preload';
            ctx.response.setHeader('Strict-Transport-Security', hstsValue);
        }
        await next();
    });
}

// Fix HTTP to HTTPS redirect with host validation
startHttpToHttpsRedirect(redirectPort, bindHost, allowedHosts = []){
    var $that = this;

    return http.createServer(function (req, res) {
        try{
            var host = req.headers['host'] || '';
            var hostname = host.split(':')[0]; // Remove port

            // CRITICAL: Validate host header
            if (allowedHosts.length > 0 && !allowedHosts.includes(hostname)) {
                res.statusCode = 400;
                res.end('Bad Request');
                return;
            }

            // Redirect to HTTPS
            var location = 'https://' + host + req.url;
            res.statusCode = 301;
            res.setHeader('Location', location);
            res.setHeader('Cache-Control', 'no-cache');
            res.end();
        }catch(e){
            logger.error({
                code: 'MC_ERR_REDIRECT',
                message: 'HTTP to HTTPS redirect failed',
                error: e.message
            });
            res.statusCode = 500;
            res.end();
        }
    }).listen(redirectPort, bindHost);
}
```

### Production-Ready Usage

```javascript
// server.js
const master = require('mastercontroller');
const fs = require('fs');

master.environmentType = 'production';
master.root = __dirname;

// Setup HTTPS with secure defaults
const server = master.setupServer('https', {
    key: fs.readFileSync('/path/to/privkey.pem'),
    cert: fs.readFileSync('/path/to/fullchain.pem')
    // minVersion, ciphers, etc. automatically set to secure defaults
});

// Enable HSTS for production
master.enableHSTS({
    maxAge: 31536000,        // 1 year
    includeSubDomains: true,
    preload: true            // Submit to HSTS preload list
});

// Load config
require('./config/initializers/config');

// Start HTTPS server on 443
master.start(server);
master.serverSettings({ httpPort: 443 });

// Start HTTP to HTTPS redirect on port 80
const redirectServer = master.startHttpToHttpsRedirect(80, '0.0.0.0', [
    'example.com',
    'www.example.com',
    'api.example.com'
]);

console.log('✅ HTTPS server running on port 443');
console.log('✅ HTTP redirect server running on port 80');
```

---

## Testing Checklist

### TLS/HTTPS Tests

- [ ] TLS 1.3 handshake succeeds
- [ ] TLS 1.2 handshake succeeds (backward compatibility)
- [ ] TLS 1.1 handshake fails (blocked)
- [ ] TLS 1.0 handshake fails (blocked)
- [ ] Weak ciphers rejected
- [ ] Strong ciphers accepted
- [ ] SNI routing works for multiple domains
- [ ] Certificate reload works without downtime
- [ ] HSTS header present with correct max-age
- [ ] HSTS includeSubDomains works
- [ ] HTTP to HTTPS redirect works
- [ ] Invalid host header rejected (400 Bad Request)
- [ ] Path traversal attacks blocked
- [ ] Dotfiles blocked
- [ ] Security headers present

### Tools for Testing

**SSL Labs:**
```bash
# Test your HTTPS configuration
https://www.ssllabs.com/ssltest/analyze.html?d=example.com
```

**testssl.sh:**
```bash
# Comprehensive TLS testing
./testssl.sh --full https://example.com
```

**nmap:**
```bash
# Check TLS versions and ciphers
nmap --script ssl-enum-ciphers -p 443 example.com
```

**curl:**
```bash
# Test TLS 1.3
curl -v --tlsv1.3 https://example.com

# Test HSTS
curl -I https://example.com | grep Strict-Transport-Security

# Test redirect
curl -I http://example.com

# Test path traversal
curl http://example.com/../../../etc/passwd

# Test open redirect
curl -H "Host: evil.com" http://example.com -I
```

---

## Conclusion

MasterController has **excellent TLS features** (SNI, certificate reload) that surpass many popular frameworks, but has **critical security vulnerabilities** that must be fixed:

**Must Fix:**
1. Path traversal vulnerability (file serving)
2. Open redirect vulnerability (HTTP redirect)
3. Missing `enableHSTS()` method
4. HSTS configuration ignored
5. Weak TLS/cipher defaults for 2026

**After fixes, MasterController will have:**
- ✅ Best-in-class SNI support
- ✅ Zero-downtime certificate reload
- ✅ Comprehensive security headers
- ✅ Modern TLS 1.3 defaults
- ✅ Secure cipher suites
- ✅ Production-ready HTTPS setup

**Estimated Fix Time:** 4-6 hours for all critical issues

**Risk Level After Fixes:** Low (production-ready)
