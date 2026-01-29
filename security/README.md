# Security Architecture

**MasterController Security Layer** - Comprehensive security middleware and utilities protecting against OWASP Top 10 vulnerabilities.

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Security Modules](#security-modules)
3. [Architecture & Integration](#architecture--integration)
4. [CSRF Protection](#csrf-protection)
5. [Rate Limiting](#rate-limiting)
6. [Session Security](#session-security)
7. [Input Validation](#input-validation)
8. [XSS Prevention](#xss-prevention)
9. [Event Handler Validation](#event-handler-validation)
10. [Content Security Policy](#content-security-policy)
11. [Configuration Guide](#configuration-guide)
12. [Best Practices](#best-practices)

---

## Overview

The MasterController security layer provides **defense-in-depth** protection through multiple coordinated modules. Every HTTP request passes through security middleware that validates, sanitizes, and enforces security policies before reaching application code.

### Key Features

- ✅ **CSRF Protection** - Token-based validation for state-changing requests
- ✅ **Rate Limiting** - Prevents brute force and DoS attacks
- ✅ **Session Security** - Hijacking detection via fingerprinting
- ✅ **Input Validation** - SQL/NoSQL/command injection detection
- ✅ **XSS Prevention** - Multi-layer HTML sanitization
- ✅ **Event Validation** - Component @event security
- ✅ **CSP Management** - Content Security Policy with nonce support
- ✅ **Security Headers** - X-Frame-Options, HSTS, etc.

### Threat Coverage (OWASP Top 10)

| Threat | Protection | Module |
|--------|-----------|---------|
| **A01: Broken Access Control** | CSRF tokens, session validation | SecurityMiddleware, SessionSecurity |
| **A02: Cryptographic Failures** | Secure session management | SessionSecurity |
| **A03: Injection** | SQL/NoSQL/command detection | MasterValidator |
| **A04: Insecure Design** | Defense-in-depth architecture | All modules |
| **A05: Security Misconfiguration** | Automatic enforcement | SecurityEnforcement |
| **A06: Vulnerable Components** | Event handler validation | EventHandlerValidator |
| **A07: Auth Failures** | Session fingerprinting | SessionSecurity |
| **A08: Data Integrity** | Input sanitization | MasterSanitizer |
| **A09: Security Logging** | Comprehensive logging | All modules |
| **A10: SSRF** | URL validation | MasterValidator |

---

## Security Modules

### 1. SecurityMiddleware.js (15 KB)

**Purpose:** Central security orchestration - CSRF, rate limiting, security headers, CORS

**Key Features:**
- CSRF token generation and validation
- Per-client rate limiting with time windows
- Security headers (X-Frame-Options, X-Content-Type-Options, etc.)
- CORS preflight handling
- Request logging and security auditing

**Used By:** MasterRouter.js (called on every HTTP request)

---

### 2. SessionSecurity.js (14 KB)

**Purpose:** Secure session management with hijacking detection

**Key Features:**
- Session fingerprinting (IP + User-Agent)
- Session regeneration on auth changes
- Session timeout enforcement
- Concurrent session detection
- Session fixation prevention

**Used By:** MasterAction.js (session creation/validation)

---

### 3. MasterValidator.js (13 KB)

**Purpose:** Input validation for injection attacks

**Key Features:**
- SQL injection detection (UNION, DROP, etc.)
- NoSQL injection detection (MongoDB operators)
- Command injection detection (shell metacharacters)
- Path traversal detection (../, directory escape)
- URL validation with protocol whitelist
- Email validation

**Used By:** MasterAction.js (validates user input before processing)

---

### 4. MasterSanitizer.js (11 KB)

**Purpose:** XSS prevention via HTML sanitization

**Key Features:**
- Dangerous tag removal (`<script>`, `<iframe>`, etc.)
- Event attribute removal (`onclick`, `onerror`, etc.)
- Protocol sanitization (blocks `javascript:`, `data:`)
- Whitelist-based approach
- CSS sanitization (removes `expression()`, `url()`)

**Used By:** MasterAction.js (sanitizes HTML before rendering)

---

### 5. EventHandlerValidator.js (12 KB)

**Purpose:** Validates @event bindings in Web Components

**Key Features:**
- Validates event handler syntax
- Checks for dangerous patterns
- Prevents arbitrary code execution
- Component security enforcement

**Used By:** runtime-ssr.cjs (SSR component rendering)

---

### 6. CSPConfig.js (7.8 KB)

**Purpose:** Content Security Policy configuration

**Key Features:**
- Development preset (permissive for debugging)
- Production preset (strict CSP)
- CDN preset (trusted external sources)
- Nonce generation for inline scripts
- CSP header generation

**Used By:** SecurityMiddleware.js (CSP header injection)

---

### 7. SecurityEnforcement.js (6.8 KB)

**Purpose:** Automatic security policy enforcement

**Key Features:**
- Auto-enables CSRF in production
- Auto-enables rate limiting
- Enforces security headers
- Validates security configuration
- Production hardening checks

**Used By:** MasterControl.js (initialization time)

---

## Architecture & Integration

### Request Flow

```
HTTP Request
    ↓
[SecurityMiddleware]
    ↓
┌─────────────────────────────────┐
│ 1. Rate Limiting                │ → Block if exceeded
│ 2. CORS Preflight               │ → Return 200 if OPTIONS
│ 3. Security Headers             │ → Inject headers
│ 4. CSRF Validation (POST/PUT)   │ → Block if invalid
└─────────────────────────────────┘
    ↓
[MasterRouter] → Route Resolution
    ↓
[MasterAction] → Controller Method
    ↓
┌─────────────────────────────────┐
│ Input Validation                │ → MasterValidator
│ Input Sanitization              │ → MasterSanitizer
│ Session Security                │ → SessionSecurity
└─────────────────────────────────┘
    ↓
[View Rendering]
    ↓
┌─────────────────────────────────┐
│ Event Handler Validation        │ → EventHandlerValidator
│ CSP Nonce Injection             │ → CSPConfig
└─────────────────────────────────┘
    ↓
HTTP Response
```

### Initialization in MasterControl.js

```javascript
// Line 305-319: Security module registration
this.internalModules = [
    "MasterTools",
    "MasterAction",
    "MasterRouter",
    "MasterValidator",      // ← Input validation
    "MasterSanitizer",      // ← XSS prevention
    "SessionSecurity",      // ← Session management
    "SecurityMiddleware",   // ← Central security
    "SecurityEnforcement",  // ← Auto-enforcement
    "CSPConfig",           // ← CSP management
    "EventHandlerValidator" // ← Component security
];

// Line 324-336: Module loading
this.moduleRegistry = {
    validator: './MasterValidator',
    sanitizer: './MasterSanitizer',
    sessionSecurity: './security/SessionSecurity',
    securityMiddleware: './security/SecurityMiddleware',
    securityEnforcement: './security/SecurityEnforcement',
    cspConfig: './security/CSPConfig',
    eventValidator: './security/EventHandlerValidator'
};
```

### Integration in MasterRouter.js

```javascript
// Line 95-110: Security middleware execution
routeMiddleware(requestObject, _loadEmit, routeList, middlewareList) {
    // 1. Execute security middleware FIRST
    this._master.securityMiddleware.checkRequest(requestObject);

    // 2. Rate limiting
    if (this._master.securityMiddleware.isRateLimited(requestObject)) {
        requestObject.response.writeHead(429, {'Content-Type': 'text/plain'});
        requestObject.response.end('Too Many Requests');
        return;
    }

    // 3. CSRF validation for state-changing methods
    if (['POST', 'PUT', 'DELETE'].includes(requestObject.request.method)) {
        if (!this._master.securityMiddleware.validateCSRF(requestObject)) {
            requestObject.response.writeHead(403, {'Content-Type': 'text/plain'});
            requestObject.response.end('CSRF validation failed');
            return;
        }
    }

    // 4. Continue to route processing
    this.processRoute(requestObject, _loadEmit, routeList);
}
```

---

## CSRF Protection

### Business Logic

**CSRF (Cross-Site Request Forgery)** protection prevents attackers from making unauthorized requests on behalf of authenticated users.

#### How It Works

1. **Token Generation** - Server generates unique token per session
2. **Token Embedding** - Token embedded in forms/AJAX headers
3. **Token Validation** - Server validates token on state-changing requests
4. **Token Rotation** - Tokens rotate periodically for security

### Workflow

```
User Visits Page
    ↓
[SecurityMiddleware.generateCSRFToken()]
    ↓
Token stored in session: {
    token: "abc123...",
    timestamp: 1706534400000
}
    ↓
Token embedded in HTML:
<input type="hidden" name="_csrf" value="abc123...">
    ↓
User Submits Form
    ↓
[SecurityMiddleware.validateCSRF()]
    ↓
✓ Token matches session
✓ Token not expired (< 1 hour)
✓ Token used only once
    ↓
Request Processed
```

### Implementation

**SecurityMiddleware.js (Lines 45-120)**

```javascript
generateCSRFToken(sessionId) {
    // Generate cryptographically secure token
    const token = crypto.randomBytes(32).toString('hex');

    // Store in session
    this.csrfTokens.set(sessionId, {
        token: token,
        timestamp: Date.now(),
        used: false
    });

    return token;
}

validateCSRF(requestObject) {
    const sessionId = requestObject.session.id;
    const submittedToken = requestObject.body._csrf ||
                          requestObject.headers['x-csrf-token'];

    const storedData = this.csrfTokens.get(sessionId);

    // Validation checks
    if (!storedData) return false;
    if (storedData.token !== submittedToken) return false;
    if (storedData.used) return false; // One-time use
    if (Date.now() - storedData.timestamp > 3600000) return false; // 1 hour expiry

    // Mark as used
    storedData.used = true;

    return true;
}
```

### Usage in Controllers

```javascript
class FormController {
    // Display form with CSRF token
    showForm(obj) {
        const csrfToken = this.generateCSRFToken();
        this.returnView({ csrfToken });
    }

    // Process form with CSRF validation
    submitForm(obj) {
        // CSRF automatically validated by SecurityMiddleware
        // If we reach here, token was valid

        const data = this.params;
        // Process form...
    }
}
```

### HTML Template

```html
<form method="POST" action="/form/submit">
    <!-- CSRF token (auto-validated on submit) -->
    <input type="hidden" name="_csrf" value="${csrfToken}">

    <input type="text" name="username">
    <button type="submit">Submit</button>
</form>
```

---

## Rate Limiting

### Business Logic

**Rate limiting** prevents brute force attacks, credential stuffing, and DoS by limiting requests per client per time window.

#### Strategy

- **Time Window:** 15 minutes (configurable)
- **Max Requests:** 100 per window (configurable)
- **Client Identification:** IP address + User-Agent
- **Storage:** In-memory Map (production: Redis)

### Workflow

```
Request arrives
    ↓
[SecurityMiddleware.isRateLimited()]
    ↓
Identify client: IP + User-Agent hash
    ↓
Check rate limit storage:
{
    "192.168.1.1:Mozilla/5.0": {
        count: 95,
        windowStart: 1706534400000
    }
}
    ↓
If count < 100:
    Increment count → Allow request
If count >= 100:
    Block request → Return 429 Too Many Requests
    ↓
If windowStart > 15 minutes ago:
    Reset count → Allow request
```

### Implementation

**SecurityMiddleware.js (Lines 125-200)**

```javascript
isRateLimited(requestObject) {
    // Client identification
    const clientId = this._getClientId(requestObject);

    const now = Date.now();
    const windowMs = 15 * 60 * 1000; // 15 minutes
    const maxRequests = 100;

    // Get or create client record
    let clientData = this.rateLimitStore.get(clientId);

    if (!clientData) {
        clientData = { count: 0, windowStart: now };
        this.rateLimitStore.set(clientId, clientData);
    }

    // Check if window expired
    if (now - clientData.windowStart > windowMs) {
        clientData.count = 0;
        clientData.windowStart = now;
    }

    // Increment and check
    clientData.count++;

    if (clientData.count > maxRequests) {
        logger.warn({
            code: 'RATE_LIMIT_EXCEEDED',
            clientId,
            count: clientData.count
        });
        return true; // Rate limited
    }

    return false; // Allowed
}

_getClientId(requestObject) {
    const ip = requestObject.request.connection.remoteAddress;
    const ua = requestObject.request.headers['user-agent'] || '';
    return `${ip}:${crypto.createHash('md5').update(ua).digest('hex')}`;
}
```

### Configuration

```javascript
// config/security.js
module.exports = {
    rateLimit: {
        enabled: true,
        windowMs: 15 * 60 * 1000,  // 15 minutes
        maxRequests: 100,           // 100 requests per window
        skipSuccessfulRequests: false,
        skipFailedRequests: false,
        whitelist: ['127.0.0.1']   // Exempt IPs
    }
};
```

---

## Session Security

### Business Logic

**Session security** prevents session hijacking, fixation, and unauthorized access through fingerprinting and validation.

#### Security Measures

1. **Session Fingerprinting** - Bind session to IP + User-Agent
2. **Session Regeneration** - New session ID after authentication
3. **Timeout Enforcement** - Sessions expire after inactivity
4. **Concurrent Session Detection** - Limit sessions per user
5. **Secure Cookie Flags** - HttpOnly, Secure, SameSite

### Workflow

```
User Logs In
    ↓
[SessionSecurity.createSession()]
    ↓
Generate session ID: crypto.randomBytes(32)
    ↓
Create fingerprint:
    IP: 192.168.1.1
    User-Agent: Mozilla/5.0...
    Hash: sha256(IP + UA)
    ↓
Store session:
{
    id: "abc123...",
    userId: 42,
    fingerprint: "def456...",
    createdAt: 1706534400000,
    lastActivity: 1706534400000
}
    ↓
Set secure cookie:
    HttpOnly: true
    Secure: true (HTTPS only)
    SameSite: Strict
    ↓
---
User Makes Request
    ↓
[SessionSecurity.validateSession()]
    ↓
Check fingerprint:
    Stored: "def456..."
    Current: "def456..."
    ✓ Match → Continue
    ✗ Mismatch → Destroy session → Redirect to login
    ↓
Check timeout:
    Last activity: 30 minutes ago
    Timeout: 60 minutes
    ✓ Active → Update lastActivity
    ✗ Expired → Destroy session → Redirect to login
    ↓
Request Processed
```

### Implementation

**SessionSecurity.js (Lines 40-250)**

```javascript
createSession(userId, requestObject) {
    // Generate secure session ID
    const sessionId = crypto.randomBytes(32).toString('hex');

    // Create fingerprint
    const fingerprint = this._createFingerprint(requestObject);

    // Store session
    const session = {
        id: sessionId,
        userId: userId,
        fingerprint: fingerprint,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        data: {}
    };

    this.sessions.set(sessionId, session);

    // Set secure cookie
    requestObject.response.setHeader('Set-Cookie',
        `sessionId=${sessionId}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=3600`
    );

    logger.info({
        code: 'SESSION_CREATED',
        userId,
        sessionId: sessionId.substring(0, 8) + '...'
    });

    return sessionId;
}

validateSession(requestObject) {
    const sessionId = this._extractSessionId(requestObject);
    if (!sessionId) return false;

    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Validate fingerprint
    const currentFingerprint = this._createFingerprint(requestObject);
    if (session.fingerprint !== currentFingerprint) {
        logger.warn({
            code: 'SESSION_HIJACK_DETECTED',
            sessionId: sessionId.substring(0, 8) + '...'
        });
        this.destroySession(sessionId);
        return false;
    }

    // Check timeout (60 minutes)
    const timeout = 60 * 60 * 1000;
    if (Date.now() - session.lastActivity > timeout) {
        logger.info({
            code: 'SESSION_TIMEOUT',
            sessionId: sessionId.substring(0, 8) + '...'
        });
        this.destroySession(sessionId);
        return false;
    }

    // Update activity
    session.lastActivity = Date.now();

    return true;
}

_createFingerprint(requestObject) {
    const ip = requestObject.request.connection.remoteAddress;
    const ua = requestObject.request.headers['user-agent'] || '';
    return crypto.createHash('sha256').update(ip + ua).digest('hex');
}

regenerateSession(oldSessionId, requestObject) {
    // Get old session data
    const oldSession = this.sessions.get(oldSessionId);
    if (!oldSession) return null;

    // Create new session with same data
    const newSessionId = this.createSession(oldSession.userId, requestObject);
    const newSession = this.sessions.get(newSessionId);
    newSession.data = oldSession.data;

    // Destroy old session
    this.destroySession(oldSessionId);

    logger.info({
        code: 'SESSION_REGENERATED',
        oldId: oldSessionId.substring(0, 8) + '...',
        newId: newSessionId.substring(0, 8) + '...'
    });

    return newSessionId;
}
```

### Usage in Authentication

```javascript
class AuthController {
    async login(obj) {
        const { username, password } = this.params;

        // Validate credentials
        const user = await User.findByUsername(username);
        if (!user || !user.verifyPassword(password)) {
            return this.returnError(401, 'Invalid credentials');
        }

        // Create secure session
        const sessionId = this.createSession(user.id, this.__requestObject);

        // Redirect to dashboard
        this.redirectTo('/dashboard');
    }

    logout(obj) {
        const sessionId = this._extractSessionId(this.__requestObject);
        this.destroySession(sessionId);
        this.redirectTo('/');
    }
}
```

---

## Input Validation

### Business Logic

**Input validation** prevents injection attacks by detecting malicious patterns before data reaches the database or OS.

#### Validation Types

1. **SQL Injection** - Detects SQL keywords (UNION, DROP, etc.)
2. **NoSQL Injection** - Detects MongoDB operators ($where, $ne, etc.)
3. **Command Injection** - Detects shell metacharacters (|, &, `, etc.)
4. **Path Traversal** - Detects directory escape (../, ..\, etc.)
5. **URL Validation** - Protocol whitelist (http, https only)

### Workflow

```
User Input Received
    ↓
[MasterValidator.validateInput()]
    ↓
Check for SQL injection:
    "'; DROP TABLE users; --"
    ✗ Contains SQL keywords → REJECT
    ↓
Check for NoSQL injection:
    {"$where": "this.password == 'admin'"}
    ✗ Contains NoSQL operators → REJECT
    ↓
Check for command injection:
    "test | rm -rf /"
    ✗ Contains shell metacharacters → REJECT
    ↓
Check for path traversal:
    "../../../etc/passwd"
    ✗ Contains directory escape → REJECT
    ↓
✓ All checks passed → ALLOW
```

### Implementation

**MasterValidator.js (Lines 30-400)**

```javascript
validateInput(input, type = 'string') {
    if (!input) return { valid: true };

    // SQL injection check
    const sqlCheck = this._checkSQLInjection(input);
    if (!sqlCheck.valid) {
        logger.warn({
            code: 'SQL_INJECTION_DETECTED',
            input: input.substring(0, 100),
            pattern: sqlCheck.pattern
        });
        return sqlCheck;
    }

    // NoSQL injection check
    const nosqlCheck = this._checkNoSQLInjection(input);
    if (!nosqlCheck.valid) {
        logger.warn({
            code: 'NOSQL_INJECTION_DETECTED',
            input: input.substring(0, 100)
        });
        return nosqlCheck;
    }

    // Command injection check
    const cmdCheck = this._checkCommandInjection(input);
    if (!cmdCheck.valid) {
        logger.warn({
            code: 'COMMAND_INJECTION_DETECTED',
            input: input.substring(0, 100)
        });
        return cmdCheck;
    }

    // Path traversal check
    const pathCheck = this._checkPathTraversal(input);
    if (!pathCheck.valid) {
        logger.warn({
            code: 'PATH_TRAVERSAL_DETECTED',
            input: input.substring(0, 100)
        });
        return pathCheck;
    }

    return { valid: true };
}

_checkSQLInjection(input) {
    const sqlPatterns = [
        /(\bUNION\b.*\bSELECT\b)/i,
        /(\bDROP\b.*\bTABLE\b)/i,
        /(\bINSERT\b.*\bINTO\b)/i,
        /(\bUPDATE\b.*\bSET\b)/i,
        /(\bDELETE\b.*\bFROM\b)/i,
        /(--[^\r\n]*)/,
        /('.*OR.*'.*=.*')/i,
        /;\s*DROP/i,
        /;\s*EXEC/i,
        /xp_cmdshell/i
    ];

    for (const pattern of sqlPatterns) {
        if (pattern.test(input)) {
            return {
                valid: false,
                error: 'SQL injection pattern detected',
                pattern: pattern.toString()
            };
        }
    }

    return { valid: true };
}

_checkNoSQLInjection(input) {
    // Check for MongoDB operators
    const nosqlPatterns = [
        /\$where/i,
        /\$ne/i,
        /\$gt/i,
        /\$lt/i,
        /\$regex/i,
        /\$in/i,
        /\$nin/i,
        /\$or/i,
        /\$and/i
    ];

    const inputStr = typeof input === 'object' ? JSON.stringify(input) : input;

    for (const pattern of nosqlPatterns) {
        if (pattern.test(inputStr)) {
            return {
                valid: false,
                error: 'NoSQL injection pattern detected'
            };
        }
    }

    return { valid: true };
}

_checkCommandInjection(input) {
    const cmdChars = ['|', '&', ';', '`', '$', '(', ')', '<', '>', '\n', '\r'];

    for (const char of cmdChars) {
        if (input.includes(char)) {
            return {
                valid: false,
                error: 'Command injection character detected',
                char: char
            };
        }
    }

    return { valid: true };
}

_checkPathTraversal(input) {
    const pathPatterns = [
        /\.\.\//,
        /\.\.\\/,
        /%2e%2e%2f/i,
        /%2e%2e%5c/i,
        /\.\.%2f/i,
        /\.\.%5c/i
    ];

    for (const pattern of pathPatterns) {
        if (pattern.test(input)) {
            return {
                valid: false,
                error: 'Path traversal pattern detected'
            };
        }
    }

    return { valid: true };
}
```

### Usage in Controllers

```javascript
class UserController {
    async search(obj) {
        const query = this.params.q;

        // Validate input
        const validation = this.validateInput(query, 'string');
        if (!validation.valid) {
            return this.returnError(400, validation.error);
        }

        // Safe to query database
        const results = await User.search(query);
        this.returnJson(results);
    }

    async uploadFile(obj) {
        const filename = this.params.filename;

        // Check for path traversal
        const validation = this.validateInput(filename, 'filename');
        if (!validation.valid) {
            return this.returnError(400, 'Invalid filename');
        }

        // Safe to write file
        await fs.writeFile(`uploads/${filename}`, fileData);
    }
}
```

---

## XSS Prevention

### Business Logic

**XSS (Cross-Site Scripting) prevention** protects against malicious JavaScript injection through multi-layer HTML sanitization.

#### Defense Layers

1. **Tag Removal** - Remove dangerous tags (`<script>`, `<iframe>`, `<object>`)
2. **Attribute Removal** - Remove event handlers (`onclick`, `onerror`)
3. **Protocol Sanitization** - Block dangerous protocols (`javascript:`, `data:`)
4. **CSS Sanitization** - Remove CSS expressions
5. **Whitelist Approach** - Only allow safe tags/attributes

### Workflow

```
User Input (HTML)
    ↓
[MasterSanitizer.sanitizeHTML()]
    ↓
Input: "<script>alert('XSS')</script><p onclick='hack()'>Hello</p>"
    ↓
Layer 1: Remove dangerous tags
    → <p onclick='hack()'>Hello</p>
    ↓
Layer 2: Remove event attributes
    → <p>Hello</p>
    ↓
Layer 3: Check protocols
    → (none to check)
    ↓
Layer 4: Sanitize CSS
    → (no inline styles)
    ↓
Output: "<p>Hello</p>"
    ↓
✓ Safe HTML
```

### Implementation

**MasterSanitizer.js (Lines 25-350)**

```javascript
sanitizeHTML(html) {
    if (!html || typeof html !== 'string') return '';

    let sanitized = html;

    // Layer 1: Remove dangerous tags
    sanitized = this._removeDangerousTags(sanitized);

    // Layer 2: Remove event attributes
    sanitized = this._removeEventAttributes(sanitized);

    // Layer 3: Sanitize protocols
    sanitized = this._sanitizeProtocols(sanitized);

    // Layer 4: Sanitize CSS
    sanitized = this._sanitizeCSS(sanitized);

    return sanitized;
}

_removeDangerousTags(html) {
    const dangerousTags = [
        'script', 'iframe', 'object', 'embed',
        'applet', 'meta', 'link', 'style',
        'form', 'input', 'button', 'textarea',
        'select', 'option', 'base'
    ];

    let result = html;

    for (const tag of dangerousTags) {
        // Remove opening and closing tags (case-insensitive)
        const openRegex = new RegExp(`<${tag}[^>]*>`, 'gi');
        const closeRegex = new RegExp(`</${tag}>`, 'gi');

        result = result.replace(openRegex, '');
        result = result.replace(closeRegex, '');
    }

    return result;
}

_removeEventAttributes(html) {
    // Remove all event handler attributes
    const eventPattern = /\s+on\w+\s*=\s*["'][^"']*["']/gi;
    return html.replace(eventPattern, '');
}

_sanitizeProtocols(html) {
    // Block dangerous protocols
    const dangerousProtocols = [
        'javascript:',
        'data:',
        'vbscript:',
        'file:',
        'about:'
    ];

    let result = html;

    for (const protocol of dangerousProtocols) {
        const regex = new RegExp(protocol, 'gi');
        result = result.replace(regex, '');
    }

    return result;
}

_sanitizeCSS(html) {
    // Remove dangerous CSS patterns
    const dangerousCSS = [
        /expression\s*\(/gi,
        /javascript\s*:/gi,
        /import\s+/gi,
        /@import/gi,
        /url\s*\(\s*["']?javascript:/gi
    ];

    let result = html;

    for (const pattern of dangerousCSS) {
        result = result.replace(pattern, '');
    }

    return result;
}

// Whitelist approach for rich text
sanitizeRichText(html) {
    const allowedTags = [
        'p', 'br', 'strong', 'em', 'u', 'h1', 'h2', 'h3',
        'ul', 'ol', 'li', 'a', 'img', 'blockquote', 'code', 'pre'
    ];

    const allowedAttributes = {
        'a': ['href', 'title', 'target'],
        'img': ['src', 'alt', 'width', 'height']
    };

    // Parse HTML and rebuild with only allowed tags/attributes
    // (Implementation uses DOM parser or regex)

    return sanitized;
}
```

### Usage in Controllers

```javascript
class CommentController {
    async create(obj) {
        const content = this.params.content;

        // Sanitize user HTML input
        const sanitizedContent = this.sanitizeHTML(content);

        // Safe to store and display
        const comment = await Comment.create({
            content: sanitizedContent,
            userId: this.currentUser.id
        });

        this.returnJson(comment);
    }
}
```

### Template Usage

```javascript
// MasterTemplate automatically sanitizes variables
class MasterTemplate {
    render(template, data) {
        return template.replace(/\${(\w+)}/g, (match, key) => {
            const value = data[key];
            // Automatic HTML escaping
            return this._escapeHTML(value);
        });
    }

    _escapeHTML(str) {
        const htmlEscapes = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        };

        return String(str).replace(/[&<>"']/g, char => htmlEscapes[char]);
    }
}
```

---

## Event Handler Validation

### Business Logic

**Event handler validation** ensures Web Component `@event` bindings are safe and don't allow arbitrary code execution.

#### Validation Rules

1. **Syntax Validation** - Ensure handler uses correct syntax
2. **Dangerous Pattern Detection** - Block `eval()`, `Function()`, etc.
3. **Scoped Execution** - Handlers can only call controller methods
4. **No Inline Code** - Block inline JavaScript in attributes

### Implementation

**EventHandlerValidator.js (Lines 20-300)**

```javascript
validateEventHandler(eventName, handlerCode, componentName) {
    // Check syntax
    if (!this._isValidSyntax(handlerCode)) {
        logger.error({
            code: 'INVALID_EVENT_SYNTAX',
            component: componentName,
            event: eventName,
            handler: handlerCode
        });
        return false;
    }

    // Check for dangerous patterns
    if (this._containsDangerousPattern(handlerCode)) {
        logger.error({
            code: 'DANGEROUS_EVENT_HANDLER',
            component: componentName,
            event: eventName
        });
        return false;
    }

    return true;
}

_isValidSyntax(handlerCode) {
    // Valid: "methodName()" or "obj.methodName()"
    const validPattern = /^[a-zA-Z_$][a-zA-Z0-9_$]*(\.[a-zA-Z_$][a-zA-Z0-9_$]*)*\(\)$/;
    return validPattern.test(handlerCode);
}

_containsDangerousPattern(handlerCode) {
    const dangerousPatterns = [
        /eval\(/,
        /Function\(/,
        /setTimeout\(/,
        /setInterval\(/,
        /new Function/,
        /constructor/,
        /__proto__/,
        /prototype/
    ];

    return dangerousPatterns.some(pattern => pattern.test(handlerCode));
}
```

### Usage in SSR

```javascript
// runtime-ssr.cjs (Lines 450-500)
function validateComponentEvents(component) {
    const eventAttributes = component.getAttributeNames()
        .filter(attr => attr.startsWith('@'));

    for (const attr of eventAttributes) {
        const eventName = attr.substring(1); // Remove '@'
        const handlerCode = component.getAttribute(attr);

        // Validate handler
        const isValid = eventValidator.validateEventHandler(
            eventName,
            handlerCode,
            component.tagName
        );

        if (!isValid) {
            // Remove dangerous handler
            component.removeAttribute(attr);

            logger.warn({
                code: 'EVENT_HANDLER_REMOVED',
                component: component.tagName,
                event: eventName
            });
        }
    }
}
```

---

## Content Security Policy

### Business Logic

**CSP (Content Security Policy)** defines approved sources for scripts, styles, images, and other resources, preventing XSS and data injection attacks.

### Presets

#### Development Preset (Permissive)
```javascript
{
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", "data:", "https:"],
    'connect-src': ["'self'", "ws:", "wss:"]
}
```

#### Production Preset (Strict)
```javascript
{
    'default-src': ["'self'"],
    'script-src': ["'self'", "'nonce-{random}'"],
    'style-src': ["'self'", "'nonce-{random}'"],
    'img-src': ["'self'", "https:"],
    'connect-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"]
}
```

#### CDN Preset
```javascript
{
    'default-src': ["'self'"],
    'script-src': [
        "'self'",
        "'nonce-{random}'",
        "https://cdn.jsdelivr.net",
        "https://unpkg.com"
    ],
    'style-src': [
        "'self'",
        "'nonce-{random}'",
        "https://fonts.googleapis.com"
    ],
    'font-src': [
        "'self'",
        "https://fonts.gstatic.com"
    ]
}
```

### Implementation

**CSPConfig.js (Lines 15-250)**

```javascript
class CSPConfig {
    constructor() {
        this.presets = {
            development: { /* ... */ },
            production: { /* ... */ },
            cdn: { /* ... */ }
        };
    }

    generateCSPHeader(preset = 'production', customRules = {}) {
        const config = { ...this.presets[preset], ...customRules };

        // Generate nonce for inline scripts
        const nonce = crypto.randomBytes(16).toString('base64');

        // Build CSP directives
        const directives = [];

        for (const [directive, sources] of Object.entries(config)) {
            const sourcesStr = sources
                .map(src => src.replace('{random}', nonce))
                .join(' ');
            directives.push(`${directive} ${sourcesStr}`);
        }

        return {
            header: directives.join('; '),
            nonce: nonce
        };
    }
}
```

### Usage in Middleware

```javascript
// SecurityMiddleware.js
checkRequest(requestObject) {
    // Generate CSP
    const { header, nonce } = this.cspConfig.generateCSPHeader('production');

    // Inject header
    requestObject.response.setHeader('Content-Security-Policy', header);

    // Store nonce for template rendering
    requestObject.cspNonce = nonce;
}
```

### Template Usage

```html
<!DOCTYPE html>
<html>
<head>
    <!-- Inline script with nonce -->
    <script nonce="${cspNonce}">
        console.log('Safe inline script');
    </script>

    <!-- External script (allowed by CSP) -->
    <script src="/app.js"></script>
</head>
</html>
```

---

## Configuration Guide

### Production Configuration

**config/security.js**

```javascript
module.exports = {
    // CSRF Protection
    csrf: {
        enabled: true,
        tokenLength: 32,
        expiryMs: 3600000, // 1 hour
        oneTimeUse: true
    },

    // Rate Limiting
    rateLimit: {
        enabled: true,
        windowMs: 15 * 60 * 1000,    // 15 minutes
        maxRequests: 100,             // 100 requests per window
        whitelist: ['127.0.0.1'],    // Exempt IPs
        storage: 'redis',            // redis or memory
        redisUrl: 'redis://localhost:6379'
    },

    // Session Security
    session: {
        enabled: true,
        fingerprintEnabled: true,
        timeoutMs: 60 * 60 * 1000,   // 60 minutes
        regenerateOnAuth: true,
        maxConcurrentSessions: 3,
        cookieOptions: {
            httpOnly: true,
            secure: true,              // HTTPS only
            sameSite: 'strict',
            maxAge: 3600
        }
    },

    // Input Validation
    validation: {
        enabled: true,
        strictMode: true,
        logBlocked: true
    },

    // XSS Prevention
    sanitization: {
        enabled: true,
        allowRichText: false,        // Strict sanitization
        whitelistTags: ['p', 'br', 'strong', 'em']
    },

    // Content Security Policy
    csp: {
        enabled: true,
        preset: 'production',
        customRules: {
            'script-src': ["'self'", "https://trusted-cdn.com"]
        },
        reportUri: '/csp-report'
    },

    // Security Headers
    headers: {
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'X-XSS-Protection': '1; mode=block',
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
        'Referrer-Policy': 'no-referrer-when-downgrade'
    }
};
```

### Initialization

**config/initializers/security.js**

```javascript
const master = require('mastercontroller');
const securityConfig = require('../security');

// Initialize security modules
master.securityMiddleware.configure(securityConfig);
master.sessionSecurity.configure(securityConfig.session);
master.cspConfig.setPreset(securityConfig.csp.preset);

// Enable automatic enforcement
master.securityEnforcement.enable({
    autoCSRF: true,
    autoRateLimit: true,
    autoHeaders: true
});

console.log('[Security] Initialized with production configuration');
```

---

## Best Practices

### 1. Always Validate User Input

```javascript
// ❌ BAD - No validation
class UserController {
    async search(obj) {
        const query = this.params.q;
        const results = await User.search(query); // SQL injection risk!
        this.returnJson(results);
    }
}

// ✅ GOOD - Validate before use
class UserController {
    async search(obj) {
        const query = this.params.q;

        // Validate input
        const validation = this.validateInput(query, 'string');
        if (!validation.valid) {
            return this.returnError(400, validation.error);
        }

        const results = await User.search(query);
        this.returnJson(results);
    }
}
```

### 2. Sanitize HTML Output

```javascript
// ❌ BAD - Raw HTML from user
class CommentController {
    async show(obj) {
        const comment = await Comment.findById(this.params.id);
        // XSS risk if comment.content contains <script>
        this.returnView({ content: comment.content });
    }
}

// ✅ GOOD - Sanitize HTML
class CommentController {
    async show(obj) {
        const comment = await Comment.findById(this.params.id);
        const sanitized = this.sanitizeHTML(comment.content);
        this.returnView({ content: sanitized });
    }
}
```

### 3. Use CSRF Tokens for State-Changing Requests

```javascript
// ❌ BAD - No CSRF protection
class AccountController {
    deleteAccount(obj) {
        // Anyone can call this endpoint!
        User.delete(this.currentUser.id);
        this.redirectTo('/');
    }
}

// ✅ GOOD - CSRF token required
class AccountController {
    showDeleteForm(obj) {
        const csrfToken = this.generateCSRFToken();
        this.returnView({ csrfToken });
    }

    deleteAccount(obj) {
        // CSRF automatically validated by SecurityMiddleware
        User.delete(this.currentUser.id);
        this.redirectTo('/');
    }
}
```

### 4. Regenerate Sessions After Authentication

```javascript
// ❌ BAD - Session fixation risk
class AuthController {
    async login(obj) {
        const user = await User.authenticate(this.params.username, this.params.password);
        this.__session.userId = user.id; // Session fixation!
        this.redirectTo('/dashboard');
    }
}

// ✅ GOOD - Regenerate session
class AuthController {
    async login(obj) {
        const user = await User.authenticate(this.params.username, this.params.password);

        // Regenerate session ID
        const oldSessionId = this.__session.id;
        const newSessionId = this.regenerateSession(oldSessionId, this.__requestObject);

        this.redirectTo('/dashboard');
    }
}
```

### 5. Use Parameterized Queries

```javascript
// ❌ BAD - SQL injection risk
class UserController {
    async search(obj) {
        const query = `SELECT * FROM users WHERE name = '${this.params.name}'`;
        const results = await db.query(query); // Dangerous!
        this.returnJson(results);
    }
}

// ✅ GOOD - Parameterized query
class UserController {
    async search(obj) {
        // ORM handles parameterization
        const results = await User.where({ name: this.params.name });
        this.returnJson(results);
    }
}
```

### 6. Set Secure Cookie Flags

```javascript
// ❌ BAD - Insecure cookies
response.setHeader('Set-Cookie', `sessionId=${id}; Path=/`);

// ✅ GOOD - Secure cookies
response.setHeader('Set-Cookie',
    `sessionId=${id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=3600`
);
```

### 7. Use CSP in Production

```javascript
// ❌ BAD - No CSP
// Vulnerable to XSS attacks

// ✅ GOOD - Strict CSP
const { header, nonce } = this.cspConfig.generateCSPHeader('production');
response.setHeader('Content-Security-Policy', header);
```

### 8. Log Security Events

```javascript
// ✅ GOOD - Comprehensive logging
logger.warn({
    code: 'RATE_LIMIT_EXCEEDED',
    ip: requestObject.ip,
    userAgent: requestObject.headers['user-agent'],
    count: attempts,
    timestamp: Date.now()
});
```

---

## Monitoring & Logging

### Security Event Codes

| Code | Description | Severity | Action |
|------|-------------|----------|--------|
| `CSRF_VALIDATION_FAILED` | CSRF token invalid/missing | HIGH | Block request |
| `RATE_LIMIT_EXCEEDED` | Too many requests | MEDIUM | Block request (429) |
| `SESSION_HIJACK_DETECTED` | Fingerprint mismatch | CRITICAL | Destroy session |
| `SESSION_TIMEOUT` | Session expired | LOW | Redirect to login |
| `SQL_INJECTION_DETECTED` | SQL pattern found | CRITICAL | Block + alert |
| `NOSQL_INJECTION_DETECTED` | NoSQL operator found | CRITICAL | Block + alert |
| `COMMAND_INJECTION_DETECTED` | Shell metachar found | CRITICAL | Block + alert |
| `PATH_TRAVERSAL_DETECTED` | Directory escape found | HIGH | Block request |
| `XSS_SANITIZED` | Dangerous HTML removed | MEDIUM | Log + sanitize |
| `INVALID_EVENT_SYNTAX` | Bad @event handler | MEDIUM | Remove handler |
| `CSP_VIOLATION` | CSP rule broken | MEDIUM | Log + investigate |

### Log Analysis Queries

```bash
# Failed CSRF attempts (potential attack)
grep "CSRF_VALIDATION_FAILED" logs/security.log | wc -l

# Rate limit violations by IP
grep "RATE_LIMIT_EXCEEDED" logs/security.log | awk '{print $4}' | sort | uniq -c | sort -nr

# Session hijack attempts
grep "SESSION_HIJACK_DETECTED" logs/security.log

# Injection attack attempts
grep -E "(SQL|NOSQL|COMMAND)_INJECTION_DETECTED" logs/security.log
```

---

## Testing

### Security Test Suite

**test/security/csrf.test.js**

```javascript
const request = require('supertest');
const app = require('../../server');

describe('CSRF Protection', () => {
    it('should block POST without CSRF token', async () => {
        const res = await request(app)
            .post('/user/create')
            .send({ name: 'Test' });

        expect(res.status).toBe(403);
    });

    it('should allow POST with valid CSRF token', async () => {
        // Get token
        const tokenRes = await request(app).get('/form');
        const token = extractCSRFToken(tokenRes.text);

        // Submit with token
        const res = await request(app)
            .post('/user/create')
            .send({ name: 'Test', _csrf: token });

        expect(res.status).toBe(200);
    });
});
```

**test/security/rate-limit.test.js**

```javascript
describe('Rate Limiting', () => {
    it('should block after 100 requests', async () => {
        // Make 100 requests
        for (let i = 0; i < 100; i++) {
            await request(app).get('/');
        }

        // 101st request should be blocked
        const res = await request(app).get('/');
        expect(res.status).toBe(429);
    });
});
```

---

## Troubleshooting

### Common Issues

#### 1. CSRF Validation Failing

**Symptom:** Forms return 403 Forbidden

**Causes:**
- Token not included in form
- Token expired (> 1 hour)
- Session not persisted

**Solution:**
```javascript
// Ensure token is embedded
<input type="hidden" name="_csrf" value="${csrfToken}">

// Check session storage
console.log(this.__session.id); // Should be defined
```

#### 2. Rate Limit Too Aggressive

**Symptom:** Legitimate users blocked

**Solution:**
```javascript
// Increase limits in config/security.js
rateLimit: {
    windowMs: 15 * 60 * 1000,
    maxRequests: 200, // Increase from 100
    whitelist: ['192.168.1.0/24'] // Exempt internal network
}
```

#### 3. Session Hijack False Positives

**Symptom:** Users logged out unexpectedly

**Causes:**
- Mobile users switching networks
- Users behind proxy with rotating IPs

**Solution:**
```javascript
// Disable fingerprinting or use less strict validation
session: {
    fingerprintEnabled: false, // Disable IP check
    // OR
    fingerprintStrict: false   // Only check User-Agent
}
```

#### 4. CSP Blocking Resources

**Symptom:** Scripts/styles not loading

**Solution:**
```javascript
// Add trusted sources to CSP
csp: {
    customRules: {
        'script-src': ["'self'", "https://trusted-cdn.com"],
        'style-src': ["'self'", "https://fonts.googleapis.com"]
    }
}

// OR use 'unsafe-inline' in development (NOT production!)
csp: {
    preset: 'development'
}
```

---

## Migration Guide

### Upgrading Existing Projects

**Step 1:** Update dependencies
```bash
npm install mastercontroller@latest
```

**Step 2:** Enable security modules in config
```javascript
// config/initializers/security.js
const securityConfig = require('../security');
master.securityMiddleware.configure(securityConfig);
```

**Step 3:** Add CSRF tokens to forms
```html
<input type="hidden" name="_csrf" value="${csrfToken}">
```

**Step 4:** Update controllers
```javascript
class FormController {
    showForm(obj) {
        const csrfToken = this.generateCSRFToken();
        this.returnView({ csrfToken });
    }
}
```

**Step 5:** Test thoroughly
```bash
npm test
```

---

## Support

For security issues or questions:

1. Review this documentation
2. Check logs: `logs/security.log`
3. Run security tests: `npm run test:security`
4. Report security vulnerabilities privately (do not open public issues)

---

**Last Updated:** 2026-01-29
**Version:** 1.0.0
**Maintained By:** MasterController Security Team
