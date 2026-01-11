# MasterController Framework

MasterController is a lightweight MVC-style server framework for Node.js with middleware pipeline, routing, controllers, views, dependency injection, CORS, sessions, sockets, and more.

## Table of Contents
- [Installation](#installation)
- [Quickstart](#quickstart)
- [Middleware Pipeline](#middleware-pipeline)
- [Routing](#routing)
- [Controllers](#controllers)
- [Views and Templates](#views-and-templates)
- [View Pattern Hooks](#view-pattern-hooks)
- [Dependency Injection](#dependency-injection)
- [CORS](#cors)
- [Sessions](#sessions)
- [Security](#security)
- [Components](#components)
- [Timeout System](#timeout-system)
- [Error Handling](#error-handling)
- [HTTPS Setup](#https-setup)

---

## Installation

```bash
npm install mastercontroller
```

---

## Quickstart

```javascript
// server.js
const master = require('mastercontroller');

master.root = __dirname;
master.environmentType = 'development'; // or process.env.NODE_ENV

const server = master.setupServer('http'); // or 'https'

// Load configuration (registers middleware, routes, DI services)
require('./config/initializers/config');

master.start(server);
```

```javascript
// config/initializers/config.js
const master = require('mastercontroller');
const cors = require('./cors.json');

// Initialize CORS (auto-registers with pipeline)
master.cors.init(cors);

// Initialize sessions (auto-registers with pipeline)
master.sessions.init();

// Auto-discover custom middleware from middleware/ folder
master.pipeline.discoverMiddleware('middleware');

// Configure server settings
master.serverSettings({
    httpPort: 3000,
    hostname: '127.0.0.1',
    requestTimeout: 60000
});

// Register routes
master.startMVC('config');
```

---

## Middleware Pipeline

MasterController uses an ASP.NET Core-style middleware pipeline for request processing.

### Core Methods

#### `master.pipeline.use(middleware)`
Add pass-through middleware that calls `next()` to continue the chain.

```javascript
master.pipeline.use(async (ctx, next) => {
    // Before request
    console.log(`→ ${ctx.type.toUpperCase()} ${ctx.request.url}`);

    await next(); // Continue to next middleware

    // After response
    console.log(`← ${ctx.response.statusCode}`);
});
```

#### `master.pipeline.run(middleware)`
Add terminal middleware that ends the pipeline (does not call `next()`).

```javascript
master.pipeline.run(async (ctx) => {
    ctx.response.statusCode = 200;
    ctx.response.end('Hello World');
});
```

#### `master.pipeline.map(path, configure)`
Conditionally execute middleware only for matching paths.

```javascript
// Apply authentication only to /api/* routes
master.pipeline.map('/api/*', (api) => {
    api.use(async (ctx, next) => {
        const token = ctx.request.headers['authorization'];
        if (!token) {
            ctx.response.statusCode = 401;
            ctx.response.end('Unauthorized');
            return;
        }
        ctx.state.user = await validateToken(token);
        await next();
    });

    // Apply rate limiting to API
    api.use(rateLimitMiddleware);
});
```

#### `master.pipeline.useError(errorHandler)`
Add error handling middleware.

```javascript
master.pipeline.useError(async (error, ctx, next) => {
    console.error('Error:', error);

    if (!ctx.response.headersSent) {
        ctx.response.statusCode = 500;
        ctx.response.end('Internal Server Error');
    }
});
```

#### `master.pipeline.discoverMiddleware(options)`
Auto-discover and load middleware from folders.

```javascript
// Single folder
master.pipeline.discoverMiddleware('middleware');

// Multiple folders
master.pipeline.discoverMiddleware({
    folders: ['middleware', 'app/middleware']
});
```

### Context Object

Middleware receives a context object:

```javascript
{
    request: req,           // Node.js request object
    response: res,          // Node.js response object
    requrl: parsedUrl,      // Parsed URL with query
    pathName: 'api/users',  // Normalized path (lowercase)
    type: 'get',            // HTTP method (lowercase)
    params: {               // Route parameters + query + form data
        query: {},          // Query string parameters
        formData: {},       // POST body data
        periodId: '123'     // Route parameters (e.g., /period/:periodId)
    },
    state: {},              // Custom state to share between middleware
    master: master,         // Framework instance
    isStatic: false         // Is this a static file request?
}
```

### Custom Middleware Files

Create middleware files that are auto-discovered:

**Simple function export:**
```javascript
// middleware/01-logger.js
module.exports = async (ctx, next) => {
    const start = Date.now();
    await next();
    const duration = Date.now() - start;
    console.log(`${ctx.type.toUpperCase()} ${ctx.request.url} - ${duration}ms`);
};
```

**Object with register() method:**
```javascript
// middleware/02-auth.js
module.exports = {
    register: (master) => {
        master.pipeline.map('/admin/*', (admin) => {
            admin.use(async (ctx, next) => {
                if (!ctx.state.user?.isAdmin) {
                    ctx.response.statusCode = 403;
                    ctx.response.end('Forbidden');
                    return;
                }
                await next();
            });
        });
    }
};
```

Files are loaded alphabetically (use `01-`, `02-` prefixes for ordering).

---

## Routing

### Setup Routes

Create `config/routes.js`:

```javascript
var master = require('mastercontroller');
var router = master.router.start();

// Basic route
router.route('/users', 'users#index', 'get');

// Route with parameters (preserves casing!)
router.route('/period/:periodId/items/:itemId', 'period#show', 'get');

// RESTful routes (generates 7 routes automatically)
router.resources('posts');
```

### API

#### `router.route(path, toPath, method, constraint)`
Register a single route.

- `path`: URL path (can include `:paramName`)
- `toPath`: Controller#action (e.g., `'users#index'`)
- `method`: HTTP method (`'get'`, `'post'`, `'put'`, `'delete'`, `'patch'`)
- `constraint`: Optional constraint function

**Parameter casing is preserved:**
```javascript
router.route('/period/:periodId', 'period#show', 'get');
// In controller: obj.params.periodId (not periodid)
```

#### `router.resources(routeName)`
Generate RESTful routes for a resource:

```javascript
router.resources('posts');

// Generates:
// GET    /posts           -> posts#index
// GET    /posts/new       -> posts#new
// POST   /posts           -> posts#create
// GET    /posts/:id       -> posts#show
// GET    /posts/:id/edit  -> posts#edit
// PUT    /posts/:id       -> posts#update
// DELETE /posts/:id       -> posts#destroy
```

#### Route Constraints

Add custom logic to routes with constraints:

```javascript
router.route('/admin', 'admin#index', 'get', function(requestObject) {
    // Check authentication
    if (!isAuthenticated(requestObject)) {
        requestObject.response.statusCode = 401;
        requestObject.response.end('Unauthorized');
        return;
    }

    // Continue to controller
    this.next();
});
```

---

## Controllers

### Creating Controllers

Create controllers in `app/controllers/`:

```javascript
// app/controllers/usersController.js
class UsersController {
    constructor(requestObject) {
        // Called for every request
        this.requestObject = requestObject;
    }

    // Actions
    index(obj) {
        // obj = requestObject
        this.render('index', {
            users: ['Alice', 'Bob', 'Charlie']
        });
    }

    show(obj) {
        const userId = obj.params.id;
        this.render('show', { userId });
    }

    create(obj) {
        const userData = obj.params.formData;
        // Save user...
        this.redirect('/users');
    }
}

module.exports = UsersController;
```

### Controller API

#### `this.render(view, data)`
Render a view with data.

```javascript
this.render('index', {
    title: 'Users',
    users: userList
});
```

Views are located at: `app/views/<controller>/<view>.html`

#### `this.redirect(path)`
Redirect to another path.

```javascript
this.redirect('/users');
this.redirect('/users/123');
```

#### `this.renderComponent(componentName, viewName, data)`
Render a view from a component.

```javascript
this.renderComponent('mail', 'inbox', { emails });
```

#### `this.json(data)`
Send JSON response.

```javascript
this.json({
    success: true,
    users: userList
});
```

#### Access Request Data

```javascript
class UsersController {
    show(obj) {
        // Route parameters
        const userId = obj.params.id;
        const periodId = obj.params.periodId; // Casing preserved!

        // Query string
        const search = obj.params.query.search;

        // Form data
        const email = obj.params.formData.email;

        // Files (multipart/form-data)
        const avatar = obj.params.formData.files.avatar;

        // Request method
        const method = obj.type; // 'get', 'post', etc.

        // Full request/response
        const req = obj.request;
        const res = obj.response;
    }
}
```

### Before/After Action Filters

Execute code before or after specific actions:

```javascript
class UsersController {
    constructor(requestObject) {
        // Run before 'edit' and 'update' actions
        this.beforeAction(['edit', 'update'], function(obj) {
            if (!isAuthenticated(obj)) {
                obj.response.statusCode = 401;
                obj.response.end('Unauthorized');
                return;
            }

            // Continue to action
            this.next();
        });

        // Run after 'create' and 'update' actions
        this.afterAction(['create', 'update'], function(obj) {
            console.log('User saved');
        });
    }

    edit(obj) {
        // beforeAction runs first
        this.render('edit');
    }

    update(obj) {
        // beforeAction runs first
        // ... update user ...
        // afterAction runs after
        this.redirect('/users');
    }
}
```

**Methods:**
- `this.beforeAction(actionList, callback)` - Run before specific actions
- `this.afterAction(actionList, callback)` - Run after specific actions
- `this.next()` - Continue from beforeAction to action

---

## Views and Templates

### View Structure

```
app/
  views/
    layouts/
      master.html          # Main layout
    users/
      index.html           # Users index view
      show.html            # Users show view
```

### Layout (master.html)

```html
<!DOCTYPE html>
<html>
<head>
    <title>{{title}}</title>
</head>
<body>
    <header>
        <h1>My App</h1>
    </header>

    <main>
        {{body}}  <!-- View content inserted here -->
    </main>

    <footer>
        &copy; 2025
    </footer>
</body>
</html>
```

### View (users/index.html)

```html
<h2>{{title}}</h2>

<ul>
{{#each users}}
    <li>{{this}}</li>
{{/each}}
</ul>
```

### Template Syntax

MasterController uses Handlebars-style templates:

```html
<!-- Variables -->
{{name}}
{{user.email}}

<!-- HTML escaping (automatic) -->
{{description}}

<!-- Conditionals -->
{{#if isAdmin}}
    <a href="/admin">Admin Panel</a>
{{/if}}

{{#unless isGuest}}
    <p>Welcome back!</p>
{{/unless}}

<!-- Loops -->
{{#each items}}
    <div>{{this.name}}</div>
{{/each}}

<!-- Partials -->
{{> header}}
```

---

## View Pattern Hooks

Extend views with custom methods using the **view pattern hook system**.

### `master.extendView(name, ViewClass)`

Add custom methods that are available in all views via `this` keyword.

```javascript
// Create a view helper class
class MyViewHelpers {
    // Format currency
    currency(amount) {
        return `$${amount.toFixed(2)}`;
    }

    // Format date
    formatDate(date) {
        return new Date(date).toLocaleDateString();
    }

    // Truncate text
    truncate(text, length) {
        if (text.length <= length) return text;
        return text.substring(0, length) + '...';
    }

    // Check if user has permission
    can(permission) {
        // Access request context if needed
        return this.__requestObject.user?.permissions.includes(permission);
    }
}

// Register the helpers
master.extendView('helpers', MyViewHelpers);
```

**Use in views:**

```html
<p>Price: {{helpers.currency(product.price)}}</p>
<p>Posted: {{helpers.formatDate(post.createdAt)}}</p>
<p>{{helpers.truncate(post.body, 100)}}</p>

{{#if helpers.can('edit')}}
    <button>Edit</button>
{{/if}}
```

### Built-in View Context

View methods have access to:
- `this.__requestObject` - Full request object
- `this.__response` - Response object
- `this.__request` - Request object
- `this.__namespace` - Controller namespace
- All methods from registered view extensions

**Example: Access request data in view helpers**

```javascript
class AuthHelpers {
    currentUser() {
        return this.__requestObject.session?.user;
    }

    isAuthenticated() {
        return !!this.currentUser();
    }

    csrf() {
        // Generate CSRF token
        return this.__requestObject.csrfToken;
    }
}

master.extendView('auth', AuthHelpers);
```

```html
<!-- In views -->
{{#if auth.isAuthenticated}}
    <p>Welcome, {{auth.currentUser.name}}!</p>
{{else}}
    <a href="/login">Login</a>
{{/if}}

<form method="post">
    <input type="hidden" name="_csrf" value="{{auth.csrf}}">
    <!-- form fields -->
</form>
```

---

## Dependency Injection

MasterController provides three DI lifetimes:

### `master.addSingleton(name, Class)`
One instance for the entire application lifetime.

```javascript
class DatabaseConnection {
    constructor() {
        this.connection = createDbConnection();
    }

    query(sql) {
        return this.connection.query(sql);
    }
}

master.addSingleton('db', DatabaseConnection);
```

**Usage in controllers:**
```javascript
class UsersController {
    index(obj) {
        const users = this.db.query('SELECT * FROM users');
        this.render('index', { users });
    }
}
```

### `master.addScoped(name, Class)`
One instance per request (scoped to request lifetime).

```javascript
class RequestLogger {
    constructor() {
        this.logs = [];
    }

    log(message) {
        this.logs.push({ message, timestamp: Date.now() });
    }

    flush() {
        console.log('Request logs:', this.logs);
    }
}

master.addScoped('logger', RequestLogger);
```

**Usage:**
```javascript
class UsersController {
    index(obj) {
        this.logger.log('Fetching users');
        const users = getUsers();
        this.logger.log('Users fetched');
        this.logger.flush();
        this.render('index', { users });
    }
}
```

### `master.addTransient(name, Class)`
New instance every time it's accessed.

```javascript
class EmailService {
    constructor() {
        this.id = Math.random();
    }

    send(to, subject, body) {
        console.log(`Sending email from instance ${this.id}`);
        // Send email...
    }
}

master.addTransient('email', EmailService);
```

**Usage:**
```javascript
class UsersController {
    create(obj) {
        // New instance each access
        this.email.send(obj.params.formData.email, 'Welcome!', 'Thanks for joining');
    }
}
```

### Accessing Services

Services are automatically available on `this` in controllers:

```javascript
class UsersController {
    index(obj) {
        // Access singleton
        const users = this.db.query('SELECT * FROM users');

        // Access scoped
        this.logger.log('Query executed');

        // Access transient
        this.email.send(user.email, 'Subject', 'Body');

        this.render('index', { users });
    }
}
```

---

## CORS

### `master.cors.init(options)`

Initialize CORS (auto-registers with middleware pipeline).

```javascript
master.cors.init({
    origin: true,                           // Reflect request origin, or '*', or ['https://example.com']
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: true,                   // Reflect requested headers, or specify array
    exposeHeaders: ['X-Total-Count'],
    credentials: true,
    maxAge: 86400
});
```

**Options:**

- `origin`:
  - `true` - Reflect request origin (or `*` if no credentials)
  - `false` - Remove CORS headers
  - `'*'` - Allow all origins
  - `'https://example.com'` - Specific origin
  - `['https://example.com', 'https://app.com']` - Array of origins
  - `function(origin, req)` - Custom function returning `true`, `false`, or origin string

- `methods`: Array of allowed HTTP methods
- `allowedHeaders`: `true` (all), `false` (none), array, or string
- `exposeHeaders`: Array of headers to expose to browser
- `credentials`: `true` to allow credentials (cookies, auth headers)
- `maxAge`: Preflight cache duration in seconds

**CORS automatically:**
- Handles preflight OPTIONS requests
- Sets appropriate headers
- Varies by Origin for security

### Advanced CORS

```javascript
// Function-based origin validation
master.cors.init({
    origin: (origin, req) => {
        // Custom validation logic
        if (req.headers['x-api-key'] === 'secret') {
            return true; // Reflect origin
        }
        if (origin === 'https://trusted.com') {
            return origin;
        }
        return false; // Deny
    },
    credentials: true
});
```

---

## Sessions

MasterController provides **two session systems**:
- **`master.session`** (NEW) - Secure, Rails/Django-style sessions with automatic regeneration and protection (RECOMMENDED)
- **`master.sessions`** (LEGACY) - Original cookie-based session API (backward compatibility only)

### Secure Sessions (NEW - Recommended)

#### `master.session.init(options)`

Initialize secure sessions with Rails/Django-style `req.session` object (auto-registers with middleware pipeline).

```javascript
// Environment-specific configuration
const isProduction = master.environmentType === 'production';

master.session.init({
    cookieName: 'mc_session',
    maxAge: isProduction ? 3600000 : 86400000,  // Production: 1 hour, Dev: 24 hours
    httpOnly: true,                              // Prevent JavaScript access (XSS protection)
    secure: isProduction,                        // HTTPS only in production
    sameSite: isProduction ? 'strict' : 'lax',  // CSRF protection
    rolling: true,                               // Extend session on each request
    regenerateInterval: 900000,                  // Regenerate session ID every 15 minutes
    useFingerprint: false                        // Session hijacking detection (opt-in)
});
```

**Security Features:**
- ✅ 32-byte (256-bit) session IDs (cryptographically secure)
- ✅ Automatic session regeneration (prevents fixation attacks)
- ✅ HttpOnly cookies (prevents XSS cookie theft)
- ✅ Secure flag for HTTPS (prevents MITM attacks)
- ✅ SameSite CSRF protection
- ✅ Rolling sessions (extends expiry on activity)
- ✅ Automatic cleanup of expired sessions
- ✅ Optional fingerprinting (detects hijacking)

#### Using Sessions in Controllers

Sessions are accessed via `obj.request.session` object:

```javascript
class AuthController {
    login(obj) {
        const user = authenticateUser(obj.params.formData);

        // Set session data (Rails/Express style)
        obj.request.session.userId = user.id;
        obj.request.session.username = user.name;
        obj.request.session.loggedInAt = Date.now();

        this.redirect('/dashboard');
    }

    logout(obj) {
        // Destroy entire session
        master.session.destroy(obj.request, obj.response);
        this.redirect('/');
    }
}
```

```javascript
class DashboardController {
    index(obj) {
        // Read session data
        const userId = obj.request.session.userId;

        if (!userId) {
            this.redirect('/login');
            return;
        }

        this.render('dashboard', { userId });
    }
}
```

#### Session Management API

**`master.session.destroy(req, res)`** - Destroy session completely

```javascript
master.session.destroy(obj.request, obj.response);
```

**`master.session.touch(sessionId)`** - Extend session expiry

```javascript
master.session.touch(obj.request.sessionId);
```

**`master.session.getSessionCount()`** - Get active session count (monitoring)

```javascript
const count = master.session.getSessionCount();
console.log(`Active sessions: ${count}`);
```

**`master.session.clearAllSessions()`** - Clear all sessions (testing only)

```javascript
master.session.clearAllSessions();
```

#### Environment-Specific Best Practices

```javascript
// Get recommended settings
const settings = master.session.getBestPractices('production');
master.session.init(settings);
```

**Production Settings:**
- Secure: true (HTTPS only)
- SameSite: 'strict' (maximum CSRF protection)
- MaxAge: 1 hour (short-lived sessions)
- RegenerateInterval: 15 minutes

**Development Settings:**
- Secure: false (allow HTTP)
- SameSite: 'lax' (easier testing)
- MaxAge: 24 hours (convenient for development)
- RegenerateInterval: 1 hour

---

### Legacy Sessions (Backward Compatibility)

**⚠️ DEPRECATED: Use `master.session` (singular) for new projects.**

The original `master.sessions` (plural) API is maintained for backward compatibility but lacks modern security features.

#### `master.sessions.init(options)`

Initialize legacy sessions (auto-registers with middleware pipeline).

```javascript
master.sessions.init({
    secret: 'your-secret-key',
    maxAge: 900000,        // 15 minutes
    httpOnly: true,
    secure: true,          // HTTPS only
    sameSite: 'strict',    // Must be string: 'strict', 'lax', or 'none'
    path: '/'
});
```

#### Legacy Session API

**`master.sessions.set(name, data, response, secret, options)`** - Create a session

```javascript
master.sessions.set('user', userData, obj.response);
```

**`master.sessions.get(name, request, secret)`** - Retrieve session data

```javascript
const user = master.sessions.get('user', obj.request);
```

**`master.sessions.delete(name, response)`** - Delete a session

```javascript
master.sessions.delete('user', obj.response);
```

**`master.sessions.reset()`** - Clear all sessions

```javascript
master.sessions.reset();
```

#### Legacy Cookie Methods

**`master.sessions.setCookie(name, value, response, options)`**
```javascript
master.sessions.setCookie('theme', 'dark', obj.response);
```

**`master.sessions.getCookie(name, request, secret)`**
```javascript
const theme = master.sessions.getCookie('theme', obj.request);
```

**`master.sessions.deleteCookie(name, response, options)`**
```javascript
master.sessions.deleteCookie('theme', obj.response);
```

#### Migration Guide: Legacy → Secure Sessions

**Old (master.sessions):**
```javascript
// Set
master.sessions.set('user', userData, obj.response);

// Get
const user = master.sessions.get('user', obj.request);

// Delete
master.sessions.delete('user', obj.response);
```

**New (master.session):**
```javascript
// Set (Rails/Express style)
obj.request.session.user = userData;

// Get
const user = obj.request.session.user;

// Delete
master.session.destroy(obj.request, obj.response);
```

**Benefits of migration:**
- ✅ Automatic session regeneration (prevents fixation)
- ✅ 32-byte session IDs (stronger than 20-byte)
- ✅ Rolling sessions (better UX)
- ✅ Automatic cleanup (no memory leaks)
- ✅ Rails/Express-style API (more familiar)
- ✅ No broken encryption (legacy has crypto bugs)

---

## Security

MasterController includes built-in security middleware.

### Security Headers

```javascript
const { pipelineSecurityHeaders } = require('./security/SecurityMiddleware');

master.pipeline.use(pipelineSecurityHeaders());
```

**Applied headers:**
- `X-XSS-Protection: 1; mode=block`
- `X-Frame-Options: SAMEORIGIN`
- `X-Content-Type-Options: nosniff`
- `X-DNS-Prefetch-Control: off`
- `Permissions-Policy: geolocation=(), microphone=(), camera=()`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Strict-Transport-Security` (HTTPS production only)

### Rate Limiting

```javascript
const { pipelineRateLimit } = require('./security/SecurityMiddleware');

master.pipeline.use(pipelineRateLimit({
    rateLimitWindow: 60000,  // 1 minute
    rateLimitMax: 100        // 100 requests per window
}));
```

**Rate limit headers:**
- `X-RateLimit-Limit` - Maximum requests allowed
- `X-RateLimit-Remaining` - Requests remaining in window
- `X-RateLimit-Reset` - When the limit resets
- `Retry-After` - Seconds until retry (when blocked)

### CSRF Protection

```javascript
const { pipelineCsrf, generateCSRFToken } = require('./security/SecurityMiddleware');

// Apply to all routes
master.pipeline.use(pipelineCsrf());

// Or only to specific routes
master.pipeline.map('/admin/*', (admin) => {
    admin.use(pipelineCsrf());
});
```

**Generate token:**
```javascript
const token = generateCSRFToken(sessionId);

// In controller
class FormController {
    show(obj) {
        const csrfToken = generateCSRFToken();
        this.render('form', { csrfToken });
    }
}
```

**In forms:**
```html
<form method="post">
    <input type="hidden" name="_csrf" value="{{csrfToken}}">
    <!-- or -->
    <!-- Send as header: x-csrf-token -->
    <!-- or -->
    <!-- Send as query: ?_csrf=token -->
</form>
```

### Input Validation

```javascript
const { validator } = require('./security/MasterValidator');

class UsersController {
    create(obj) {
        const email = obj.params.formData.email;

        // Validate email
        const emailCheck = validator.isEmail(email);
        if (!emailCheck.valid) {
            this.json({ error: emailCheck.error });
            return;
        }

        // Continue with valid data
        // ...
    }
}
```

**Available validators:**
- `validator.isEmail(email)`
- `validator.isURL(url)`
- `validator.isAlphanumeric(str)`
- `validator.isLength(str, min, max)`
- `detectPathTraversal(path)` - Detect `../` attacks
- `detectSQLInjection(input)` - Detect SQL injection
- `detectCommandInjection(input)` - Detect command injection

---

## Components

Components are self-contained modules with their own routes, controllers, and views.

### Structure

```
components/
  user/
    config/
      initializers/
        config.js
      routes.js
    app/
      controllers/
        authController.js
      views/
        auth/
          login.html
      models/
        userContext.js
```

### Register Component

```javascript
// In config/initializers/config.js
master.component('components', 'user');
master.component('components', 'mail');
```

### Absolute Path Components

```javascript
// Load component from absolute path
master.component('/var/www/shared-components', 'analytics');
```

Components are isolated and can be reused across projects.

---

## Timeout System

MasterController v2.0 includes a professional timeout system with per-request tracking (Rails/Django style).

### Configuration

```javascript
// config/initializers/config.js
master.timeout.init({
    globalTimeout: 120000,  // 120 seconds (2 minutes) default
    enabled: true,
    onTimeout: (ctx, timeoutInfo) => {
        // Optional custom timeout handler
        console.log(`Request timeout: ${timeoutInfo.path}`);
    }
});

// Register timeout middleware
master.pipeline.use(master.timeout.middleware());
```

### Route-Specific Timeouts

```javascript
// Short timeout for API endpoints
master.timeout.setRouteTimeout('/api/*', 30000);  // 30 seconds

// Long timeout for reports
master.timeout.setRouteTimeout('/admin/reports', 300000);  // 5 minutes

// Very long timeout for batch operations
master.timeout.setRouteTimeout('/batch/process', 600000);  // 10 minutes
```

### Timeout Statistics

```javascript
const stats = master.timeout.getStats();

console.log(stats);
// {
//     enabled: true,
//     globalTimeout: 120000,
//     routeTimeouts: [
//         { pattern: '/api/*', timeout: 30000 }
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

### Disable/Enable Timeouts

```javascript
// Disable for debugging
master.timeout.disable();

// Re-enable
master.timeout.enable();
```

---

## Error Handling

MasterController v2.0 includes a professional error template system inspired by Rails and Django.

### Error Renderer Configuration

```javascript
// config/initializers/config.js
master.errorRenderer.init({
    templateDir: 'public/errors',  // Error templates directory
    environment: master.environmentType,
    showStackTrace: master.environmentType === 'development'  // Dev only
});
```

### Using Error Renderer

```javascript
// In middleware
master.pipeline.use(async (ctx, next) => {
    if (!isAuthenticated(ctx)) {
        master.errorRenderer.send(ctx, 401, {
            message: 'Please log in to access this resource',
            suggestions: [
                'Sign in with your credentials',
                'Request a password reset if forgotten'
            ]
        });
        return;
    }
    await next();
});

// In controllers
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

### Error Templates

Create templates in `public/errors/`:

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

**Template Variables:**

```html
<!DOCTYPE html>
<html>
<head>
    <title>{{title}} ({{statusCode}})</title>
</head>
<body>
    <h1>{{statusCode}} - {{title}}</h1>
    <p>{{message}}</p>

    <!-- Conditionals (dev only) -->
    {{#if showStackTrace}}
    <pre>{{stack}}</pre>
    {{/if}}

    <!-- Loops -->
    {{#each suggestions}}
        <li>{{this}}</li>
    {{/each}}
</body>
</html>
```

**Available Variables:**
- `{{statusCode}}` - HTTP status code (404, 500, etc.)
- `{{title}}` - Error title
- `{{message}}` - Error message
- `{{code}}` - Error code
- `{{stack}}` - Stack trace (development only)
- `{{suggestions}}` - Array of suggestions
- `{{environment}}` - Current environment

### Custom Error Handlers

```javascript
// Register custom handler for specific status code
master.errorRenderer.registerHandler(503, (ctx, errorData) => {
    return `
        <!DOCTYPE html>
        <html>
        <body>
            <h1>Maintenance Mode</h1>
            <p>We'll be back soon! Expected completion: 2:00 PM EST</p>
        </body>
        </html>
    `;
});
```

### Content Negotiation

The error renderer automatically detects API requests and returns JSON:

```javascript
// Browser request → HTML
GET /users/999
Accept: text/html
→ Returns beautiful HTML error page

// API request → JSON
GET /api/users/999
Accept: application/json
→ Returns JSON error response
{
    "error": "Page Not Found",
    "statusCode": 404,
    "code": "MC_HTTP_ERROR",
    "message": "The user you're looking for doesn't exist."
}
```

### Global Error Handler (Pipeline)

```javascript
master.pipeline.useError(async (error, ctx, next) => {
    console.error('Pipeline error:', error);

    // Use error renderer for HTTP errors
    master.errorRenderer.send(ctx, 500, {
        message: error.message,
        code: error.code,
        stack: error.stack
    });
});
```

### Controller Error Handling

```javascript
class UsersController {
    async index(obj) {
        try {
            const users = await this.db.query('SELECT * FROM users');
            this.render('index', { users });
        } catch (error) {
            console.error('Database error:', error);

            master.errorRenderer.send(obj, 500, {
                message: 'Failed to load users',
                code: 'DB_ERROR',
                stack: error.stack
            });
        }
    }
}
```

### Logging

```javascript
const { logger } = require('./error/MasterErrorLogger');

// In controllers or middleware
logger.info({
    code: 'USER_LOGIN',
    message: 'User logged in',
    userId: user.id
});

logger.warn({
    code: 'INVALID_INPUT',
    message: 'Invalid email format',
    email: input
});

logger.error({
    code: 'DB_ERROR',
    message: 'Database query failed',
    error: error.message,
    stack: error.stack
});
```

---

## HTTPS Setup

### Basic HTTPS

```javascript
const fs = require('fs');

const credentials = {
    key: fs.readFileSync('path/to/key.pem'),
    cert: fs.readFileSync('path/to/cert.pem')
};

const server = master.setupServer('https', credentials);
```

### Environment-based TLS

Configure TLS in `config/environments/env.production.json`:

```json
{
    "server": {
        "httpPort": 443,
        "tls": {
            "default": {
                "keyPath": "/path/to/default.key",
                "certPath": "/path/to/default.crt"
            },
            "sni": {
                "example.com": {
                    "keyPath": "/path/to/example.key",
                    "certPath": "/path/to/example.crt"
                },
                "app.example.com": {
                    "keyPath": "/path/to/app.key",
                    "certPath": "/path/to/app.crt"
                }
            }
        }
    }
}
```

```javascript
const server = master.setupServer('https');
master.serverSettings(master.env.server);
```

### HTTP to HTTPS Redirect

```javascript
// Start HTTPS server on 443
const httpsServer = master.setupServer('https');
master.start(httpsServer);
master.serverSettings({ httpPort: 443 });

// Start redirect server on 80
const redirectServer = master.startHttpToHttpsRedirect(80);
```

### HSTS (HTTP Strict Transport Security)

```javascript
master.enableHSTS(); // In production HTTPS
```

---

## API Reference

### Master Instance

- `master.root` - Project root directory
- `master.environmentType` - Environment ('development', 'production', etc.)
- `master.env` - Environment config from `config/environments/env.<env>.json`
- `master.serverProtocol` - 'http' or 'https'

### Setup Methods

- `master.setupServer(type, credentials)` - Create HTTP or HTTPS server
- `master.start(server)` - Start the server
- `master.serverSettings(options)` - Configure server (port, host, timeout)
- `master.startMVC(folder)` - Load routes from folder
- `master.component(folder, name)` - Load component
- `master.enableHSTS()` - Enable HSTS for HTTPS
- `master.startHttpToHttpsRedirect(port, host)` - Create redirect server

### Middleware Pipeline

- `master.pipeline.use(middleware)` - Add middleware
- `master.pipeline.run(middleware)` - Add terminal middleware
- `master.pipeline.map(path, configure)` - Conditional middleware
- `master.pipeline.useError(handler)` - Add error handler
- `master.pipeline.discoverMiddleware(options)` - Auto-discover middleware
- `master.pipeline.execute(context)` - Execute pipeline (internal)
- `master.pipeline.clear()` - Clear all middleware (testing)
- `master.pipeline.inspect()` - Inspect middleware stack (debugging)

### Dependency Injection

- `master.addSingleton(name, Class)` - Register singleton service
- `master.addScoped(name, Class)` - Register scoped service (per request)
- `master.addTransient(name, Class)` - Register transient service (per access)

### Extensions

- `master.extend(name, Class)` - Extend master with new functionality
- `master.extendController(Class)` - Extend all controllers
- `master.extendView(name, Class)` - Extend all views

### Router

- `master.router.start()` - Get router API
- `router.route(path, toPath, method, constraint)` - Register route
- `router.resources(name)` - Register RESTful routes
- `master.router.setup(options)` - Setup route namespace (internal)
- `master.router.load(requestObject)` - Load and match routes (internal)
- `master.router.currentRoute` - Current route info
- `master.router.findMimeType(ext)` - Get MIME type for extension
- `master.router.addMimeList(mimes)` - Add MIME type mappings

### CORS

- `master.cors.init(options)` - Initialize CORS
- `master.cors.load(params)` - Apply CORS headers (internal)
- `master.cors.middleware()` - Get pipeline middleware

### Sessions

- `master.sessions.init(options)` - Initialize sessions
- `master.sessions.set(name, data, response, secret, options)` - Create session
- `master.sessions.get(name, request, secret)` - Get session data
- `master.sessions.delete(name, response)` - Delete session
- `master.sessions.reset()` - Clear all sessions
- `master.sessions.setCookie(name, value, response, options)` - Set cookie
- `master.sessions.getCookie(name, request, secret)` - Get cookie
- `master.sessions.deleteCookie(name, response, options)` - Delete cookie
- `master.sessions.createSessionID()` - Generate random session ID
- `master.sessions.middleware()` - Get pipeline middleware

### Request

- `master.request.getRequestParam(request, response)` - Parse request body (internal)

### HTML/Template

- `master.html.init(path)` - Set views path
- `master.template.init(layout)` - Set layout template

### Tools

- `master.tools.encrypt(data, secret)` - Encrypt data
- `master.tools.decrypt(data, secret)` - Decrypt data
- `master.tools.combineObjects(target, source)` - Merge objects
- `master.tools.makeWordId(length)` - Generate random ID

---

## Production Tips

1. **Use a reverse proxy** (nginx, Apache) for TLS termination
2. **Run Node.js on a high port** (3000, 8080) behind the proxy
3. **Enable HSTS** for HTTPS: `master.enableHSTS()`
4. **Use environment variables** for secrets and config
5. **Enable rate limiting** for public APIs
6. **Enable CSRF protection** for forms
7. **Use security headers** middleware
8. **Monitor logs** with `logger` module
9. **Use process manager** (PM2, systemd) for restarts
10. **Keep dependencies updated**

---

## Documentation

Detailed guides:

- [HTTP Server Setup](docs/server-setup-http.md)
- [HTTPS with Credentials](docs/server-setup-https-credentials.md)
- [HTTPS with Environment TLS & SNI](docs/server-setup-https-env-tls-sni.md)
- [Hostname Binding](docs/server-setup-hostname-binding.md)
- [Nginx Reverse Proxy](docs/server-setup-nginx-reverse-proxy.md)
- [Environment TLS Reference](docs/environment-tls-reference.md)

---

## License

MIT

---

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

---

## Support

For issues and questions, please visit: [GitHub Issues](https://github.com/alexanderrich/MasterController/issues)
