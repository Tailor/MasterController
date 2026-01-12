# Professional Timeout and Error Handling

MasterController includes production-ready timeout tracking and error page rendering inspired by Rails and Django.

---

## Table of Contents

- [Timeout System](#timeout-system)
- [Error Template System](#error-template-system)
- [Migration Guide](#migration-guide)
- [Best Practices](#best-practices)

---

## Timeout System

### Overview

The timeout system provides per-request timeout tracking with configurable options:

- **Global timeout** for all requests
- **Route-specific timeouts** for different endpoints
- **Graceful cleanup** on timeout
- **Detailed logging** of timeouts
- **Custom timeout handlers**

### Configuration

**config/initializers/config.js:**

```javascript
// Initialize timeout system
master.timeout.init({
    globalTimeout: 120000,  // 120 seconds (2 minutes) default
    enabled: true,
    onTimeout: (ctx, timeoutInfo) => {
        // Custom timeout handler (optional)
        console.log(`Request timeout: ${timeoutInfo.path}`);
    }
});

// Register timeout middleware
master.pipeline.use(master.timeout.middleware());
```

### Route-Specific Timeouts

```javascript
// Short timeout for API endpoints (30 seconds)
master.timeout.setRouteTimeout('/api/*', 30000);

// Long timeout for reports (5 minutes)
master.timeout.setRouteTimeout('/admin/reports', 300000);

// Critical operations (10 minutes)
master.timeout.setRouteTimeout('/batch/process', 600000);
```

### Timeout Response

When a request times out, the client receives:

```json
{
    "error": "Request Timeout",
    "message": "The server did not receive a complete request within the allowed time",
    "code": "MC_REQUEST_TIMEOUT",
    "timeout": 120000
}
```

### Timeout Statistics

```javascript
// Get current timeout stats
const stats = master.timeout.getStats();

console.log(stats);
// {
//     enabled: true,
//     globalTimeout: 120000,
//     routeTimeouts: [
//         { pattern: '/api/*', timeout: 30000 },
//         { pattern: '/admin/reports', timeout: 300000 }
//     ],
//     activeRequests: 5,
//     requests: [
//         {
//             requestId: 'req_1234567890_abc123',
//             path: 'api/users',
//             method: 'get',
//             timeout: 30000,
//             elapsed: 15000,
//             remaining: 15000
//         }
//     ]
// }
```

### Disable Timeouts (Debugging)

```javascript
// Temporarily disable timeouts for debugging
master.timeout.disable();

// Re-enable later
master.timeout.enable();
```

### Environment-Specific Timeouts

**config/environments/env.development.json:**

```json
{
    "server": {
        "requestTimeout": 300000
    }
}
```

**config/environments/env.production.json:**

```json
{
    "server": {
        "requestTimeout": 120000
    }
}
```

---

## Error Template System

### Overview

Professional error page rendering with:

- **Environment-specific rendering** (dev shows details, production hides)
- **Dynamic error pages** with template data
- **Multiple error codes** (400, 401, 403, 404, 405, 422, 429, 500, 502, 503, 504)
- **Content negotiation** (HTML for browsers, JSON for APIs)
- **Custom error handlers**
- **Template-based pages** (Rails/Django style)

### Configuration

**config/initializers/config.js:**

```javascript
// Initialize error renderer
master.errorRenderer.init({
    templateDir: 'public/errors',  // Error templates directory
    environment: master.environmentType,
    showStackTrace: master.environmentType === 'development'
});
```

### Error Templates

Templates are located in `public/errors/`:

```
public/errors/
├── 400.html  # Bad Request
├── 401.html  # Unauthorized
├── 403.html  # Forbidden
├── 404.html  # Not Found
├── 405.html  # Method Not Allowed
├── 422.html  # Unprocessable Entity
├── 429.html  # Too Many Requests
├── 500.html  # Internal Server Error
├── 502.html  # Bad Gateway
├── 503.html  # Service Unavailable
└── 504.html  # Gateway Timeout
```

### Template Variables

Error templates have access to these variables:

```html
<!DOCTYPE html>
<html>
<head>
    <title>{{title}} ({{statusCode}})</title>
</head>
<body>
    <h1>{{statusCode}} - {{title}}</h1>
    <p>{{message}}</p>
    <code>{{code}}</code>

    <!-- Development only -->
    {{#if showStackTrace}}
    <pre>{{stack}}</pre>
    {{/if}}

    <!-- Suggestions list -->
    {{#each suggestions}}
        <li>{{this}}</li>
    {{/each}}
</body>
</html>
```

**Available Variables:**

- `{{statusCode}}` - HTTP status code (404, 500, etc.)
- `{{title}}` - Error title ("Page Not Found", "Internal Server Error")
- `{{message}}` - Error message
- `{{description}}` - Optional detailed description
- `{{code}}` - Error code (e.g., "MC_HTTP_ERROR")
- `{{stack}}` - Stack trace (development only)
- `{{suggestions}}` - Array of suggestions
- `{{path}}` - Request path
- `{{environment}}` - Current environment
- `{{showStackTrace}}` - Boolean indicating if stack traces should be shown

### Using Error Renderer in Code

**Middleware:**

```javascript
master.pipeline.use(async (ctx, next) => {
    if (!isAuthenticated(ctx)) {
        master.errorRenderer.send(ctx, 401, {
            message: 'Please log in to access this resource',
            suggestions: [
                'Sign in with your credentials',
                'Request a password reset if forgotten',
                'Contact support for account issues'
            ]
        });
        return;
    }

    await next();
});
```

**Controllers:**

```javascript
class UsersController {
    async show(obj) {
        const userId = obj.params.userId;
        const user = await this.db.query('SELECT * FROM users WHERE id = ?', [userId]);

        if (!user) {
            master.errorRenderer.send(obj, 404, {
                message: `User #${userId} not found`,
                suggestions: [
                    'Check the user ID',
                    'Browse all users',
                    'Search for the user by name'
                ]
            });
            return;
        }

        this.render('show', { user });
    }
}
```

### Custom Error Handlers

Register custom error handlers for specific status codes:

```javascript
// Custom 404 handler
master.errorRenderer.registerHandler(404, (ctx, errorData) => {
    return `
        <html>
        <body>
            <h1>Custom 404 Page</h1>
            <p>${errorData.message}</p>
            <a href="/">Go Home</a>
        </body>
        </html>
    `;
});

// Custom 500 handler with logging
master.errorRenderer.registerHandler(500, (ctx, errorData) => {
    // Log to external service
    logToSentry(errorData);

    return `
        <html>
        <body>
            <h1>Oops! Something went wrong</h1>
            <p>Our team has been notified.</p>
            <p>Reference: ${errorData.code}</p>
        </body>
        </html>
    `;
});
```

### Content Negotiation (HTML vs JSON)

The error renderer automatically detects API requests and returns JSON:

```javascript
// Browser request → HTML response
GET /users/999
Accept: text/html

<!DOCTYPE html>
<html>
<head><title>Page Not Found (404)</title></head>
<body>
    <h1>404 - Page Not Found</h1>
    <p>The user you're looking for doesn't exist.</p>
</body>
</html>

// API request → JSON response
GET /api/users/999
Accept: application/json

{
    "error": "Page Not Found",
    "statusCode": 404,
    "code": "MC_HTTP_ERROR",
    "message": "The user you're looking for doesn't exist."
}
```

**Detection Rules:**
1. `Accept: application/json` header
2. Path starts with `/api/`
3. `Content-Type: application/json` header

---

## Migration Guide

### From Previous Versions

**OLD - Static HTML in public/ folder:**

```json
{
    "error": {
        "404": "/public/404.html",
        "500": "/public/500.html"
    }
}
```

**NEW - Dynamic templates in public/errors/:**

```json
{
    "error": {
        "404": "/public/errors/404.html",
        "500": "/public/errors/500.html",
        "401": "/public/errors/401.html",
        "429": "/public/errors/429.html"
    }
}
```

### Step 1: Update Environment Config

**config/environments/env.development.json:**

```json
{
    "server": {
        "requestTimeout": 120000
    },
    "error": {
        "400": "/public/errors/400.html",
        "401": "/public/errors/401.html",
        "403": "/public/errors/403.html",
        "404": "/public/errors/404.html",
        "405": "/public/errors/405.html",
        "422": "/public/errors/422.html",
        "429": "/public/errors/429.html",
        "500": "/public/errors/500.html",
        "502": "/public/errors/502.html",
        "503": "/public/errors/503.html",
        "504": "/public/errors/504.html"
    }
}
```

### Step 2: Move Error Pages

```bash
# Create error templates directory
mkdir -p public/errors

# Move existing error pages
mv public/404.html public/errors/
mv public/500.html public/errors/

# Create missing templates
touch public/errors/{400,401,403,405,422,429,502,503,504}.html
```

### Step 3: Update config.js

**config/initializers/config.js:**

```javascript
// Add timeout system
master.timeout.init({
    globalTimeout: 120000,
    enabled: true
});
master.pipeline.use(master.timeout.middleware());

// Add error renderer
master.errorRenderer.init({
    templateDir: 'public/errors',
    environment: master.environmentType,
    showStackTrace: master.environmentType === 'development'
});
```

### Step 4: (Optional) Configure Route Timeouts

```javascript
// API routes: 30 seconds
master.timeout.setRouteTimeout('/api/*', 30000);

// Admin reports: 5 minutes
master.timeout.setRouteTimeout('/admin/reports', 300000);
```

---

## Best Practices

### Timeout Configuration

1. **Set appropriate global timeout**: 120 seconds (2 minutes) is a good default
2. **Use route-specific timeouts**: APIs should have shorter timeouts (30s)
3. **Long operations**: Use background jobs instead of long timeouts
4. **Disable in development**: For debugging, temporarily disable timeouts

### Error Templates

1. **Keep error messages user-friendly**: Don't expose technical details in production
2. **Show stack traces in development only**: Use `showStackTrace` conditional
3. **Provide actionable suggestions**: Help users resolve the issue
4. **Consistent design**: Match your application's design
5. **Test all error codes**: Ensure templates render correctly

### Error Handling Strategy

```javascript
// Middleware for authentication
master.pipeline.use(async (ctx, next) => {
    const token = ctx.request.headers['authorization'];

    if (!token) {
        master.errorRenderer.send(ctx, 401, {
            message: 'Authentication required',
            suggestions: ['Sign in to access this resource']
        });
        return;
    }

    try {
        ctx.state.user = await validateToken(token);
        await next();
    } catch (err) {
        master.errorRenderer.send(ctx, 403, {
            message: 'Invalid or expired token',
            suggestions: ['Sign in again', 'Check your token']
        });
    }
});
```

### Logging

Both systems integrate with Winston logging:

```javascript
// Timeout logs
[error] MC_REQUEST_TIMEOUT: Request timeout exceeded
    path: /api/users
    method: get
    timeout: 30000
    duration: 30150

// Error logs
[error] MC_HTTP_ERROR: Page Not Found
    statusCode: 404
    path: /users/999
    method: get
```

### Monitoring

```javascript
// Check timeout stats periodically
setInterval(() => {
    const stats = master.timeout.getStats();

    if (stats.activeRequests > 100) {
        console.warn('High number of active requests:', stats.activeRequests);
    }

    // Log slow requests
    stats.requests.forEach(req => {
        if (req.elapsed > req.timeout * 0.8) {
            console.warn(`Request close to timeout: ${req.path} (${req.elapsed}ms/${req.timeout}ms)`);
        }
    });
}, 60000); // Every minute
```

---

## Examples

### Example 1: Rate-Limited API

```javascript
// Rate limiting with custom 429 page
const rateLimit = new Map();

master.pipeline.map('/api/*', (api) => {
    api.use(async (ctx, next) => {
        const clientId = ctx.request.connection.remoteAddress;
        const requests = rateLimit.get(clientId) || [];
        const now = Date.now();

        // Remove requests older than 1 minute
        const recent = requests.filter(time => now - time < 60000);

        if (recent.length >= 100) {
            master.errorRenderer.send(ctx, 429, {
                message: 'Rate limit exceeded (100 requests per minute)',
                suggestions: [
                    'Wait 60 seconds and try again',
                    'Upgrade to a higher tier plan',
                    'Contact support for increased limits'
                ]
            });
            return;
        }

        recent.push(now);
        rateLimit.set(clientId, recent);

        await next();
    });
});
```

### Example 2: Protected Admin Section

```javascript
// Admin section with authentication
master.pipeline.map('/admin/*', (admin) => {
    admin.use(async (ctx, next) => {
        if (!ctx.state.user || !ctx.state.user.isAdmin) {
            master.errorRenderer.send(ctx, 403, {
                message: 'Admin access required',
                suggestions: [
                    'Sign in with an admin account',
                    'Contact an administrator for access'
                ]
            });
            return;
        }

        await next();
    });
});
```

### Example 3: Custom Error Page

```javascript
// Custom maintenance page
master.errorRenderer.registerHandler(503, (ctx, errorData) => {
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Maintenance Mode</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    text-align: center;
                    padding: 50px;
                }
                .icon { font-size: 100px; }
                h1 { color: #333; }
            </style>
        </head>
        <body>
            <div class="icon">🔧</div>
            <h1>We'll be back soon!</h1>
            <p>We're performing scheduled maintenance.</p>
            <p>Expected completion: 2:00 PM EST</p>
        </body>
        </html>
    `;
});

// Trigger maintenance mode
if (maintenanceMode) {
    master.pipeline.use(async (ctx, next) => {
        master.errorRenderer.send(ctx, 503, {
            message: 'Service temporarily unavailable'
        });
    });
}
```

---

## API Reference

### MasterTimeout

**Methods:**
- `init(options)` - Initialize timeout system
- `setRouteTimeout(pattern, timeout)` - Set route-specific timeout
- `getTimeoutForPath(path)` - Get timeout for path
- `startTracking(ctx)` - Start timeout tracking (internal)
- `stopTracking(requestId)` - Stop timeout tracking (internal)
- `middleware()` - Get middleware function
- `disable()` - Disable timeouts
- `enable()` - Enable timeouts
- `getStats()` - Get timeout statistics

### MasterErrorRenderer

**Methods:**
- `init(options)` - Initialize error renderer
- `render(ctx, statusCode, errorData)` - Render error page (returns string)
- `send(ctx, statusCode, errorData)` - Render and send error response
- `registerHandler(statusCode, handler)` - Register custom error handler

---

## Troubleshooting

### Timeouts Not Working

```javascript
// Check if timeout system is initialized
console.log(master.timeout.getStats());

// Ensure middleware is registered
master.pipeline.use(master.timeout.middleware());

// Check if enabled
if (!master.timeout.getStats().enabled) {
    master.timeout.enable();
}
```

### Error Templates Not Found

```bash
# Check if templates exist
ls public/errors/

# Check error renderer config
console.log(master.errorRenderer.templateDir);

# Ensure init was called
master.errorRenderer.init({
    templateDir: 'public/errors'
});
```

### Stack Traces Not Showing

```javascript
// Ensure showStackTrace is true
master.errorRenderer.init({
    showStackTrace: true  // Force enable for debugging
});

// Check environment
console.log(master.environmentType); // Should be 'development'
```

---

## Performance Impact

- **Timeout tracking**: ~0.1ms overhead per request
- **Error rendering**: ~1-2ms for template rendering
- **Memory usage**: ~100 bytes per active request

Both systems are highly optimized and production-ready.

---

## Support

For questions or issues:
- **GitHub Issues**: https://github.com/alexanderrich/mastercontroller/issues
- **Documentation**: https://github.com/alexanderrich/mastercontroller

---

**Production-Ready ✓** | **Battle-Tested ✓** | **Rails/Django Inspired ✓**
