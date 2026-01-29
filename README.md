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
- [File Conversion & Binary Data](#file-conversion--binary-data)
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
master.session.init({
    cookieName: 'mc_session',
    maxAge: 3600000,
    httpOnly: true,
    secure: true,
    sameSite: 'strict'
});

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

MasterController v1.3+ uses a **pluggable view architecture**, allowing you to choose any template engine (MasterView, EJS, Pug, React SSR, etc.) or build your own adapter.

### Quick Start with MasterView

MasterView is the official view engine with built-in SSR support:

```bash
npm install masterview
```

```javascript
// config/initializers/config.js
const master = require('mastercontroller');
const MasterView = require('masterview');

// Register view engine
master.useView(MasterView, {
    ssr: true,  // Enable server-side rendering
    layoutPath: 'app/views/layouts/master.html'
});

// Rest of your config...
master.startMVC('config');
```

### Controller Usage (Same for All View Engines)

```javascript
class HomeController {
    index(obj) {
        // Render view with layout
        this.returnView({
            title: 'Home',
            message: 'Welcome!'
        });
    }

    partial(obj) {
        // Render partial (no layout)
        this.returnPartialView('shared/header', { user: 'John' });
    }

    raw(obj) {
        // Render raw HTML file
        this.returnViewWithoutEngine('static/page.html');
    }

    api(obj) {
        // Return JSON (works with any view engine)
        this.returnJson({ status: 'ok', data: [] });
    }
}
```

### View Structure

```
app/
  views/
    layouts/
      master.html          # Main layout
    home/
      index.html           # Home index view
      about.html           # Home about view
    users/
      index.html           # Users index view
      show.html            # Users show view
```

### Alternative View Engines

#### Using EJS

```bash
npm install ejs
```

```javascript
const EJSView = {
    register(master) {
        master.controllerList.returnView = async function(data, location) {
            const html = await ejs.renderFile(viewPath, data);
            this.__response.end(html);
        };
    }
};

master.useView(EJSView);
```

See [MasterView Examples](https://github.com/yourorg/masterview/tree/master/examples) for EJS, Pug, and React SSR adapters.

#### Using Pug

```bash
npm install pug
```

```javascript
const PugView = {
    register(master) {
        master.controllerList.returnView = function(data, location) {
            const html = pug.renderFile(viewPath, data);
            this.__response.end(html);
        };
    }
};

master.useView(PugView);
```

#### Using React SSR

```bash
npm install react react-dom
```

```javascript
const ReactSSRView = {
    register(master) {
        master.controllerList.returnView = function(data, location) {
            const Component = require(componentPath);
            const html = ReactDOMServer.renderToString(
                React.createElement(Component, data)
            );
            this.__response.end(wrapInHTML(html, data));
        };
    }
};

master.useView(ReactSSRView);
```

### MasterView Template Syntax

MasterView uses `{{...}}` syntax similar to Handlebars:

```html
<!-- Variables -->
{{name}}
{{user.email}}

<!-- HTML escaping (automatic) -->
{{description}}

<!-- Raw HTML (use sparingly, XSS risk) -->
{{{htmlContent}}}

<!-- Partials -->
{{html.renderPartial('shared/header', {user: currentUser})}}
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

MasterController provides secure, Rails/Django-style sessions with automatic regeneration and protection.

### Secure Sessions

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

### File Upload Security

MasterController v1.3.1 includes built-in protection against file upload attacks and DoS.

#### Request Body Size Limits

**config/initializers/request.json:**
```json
{
    "disableFormidableMultipartFormData": false,
    "formidable": {
        "multiples": true,
        "keepExtensions": true,
        "maxFileSize": 10485760,      // 10MB per file
        "maxFieldsSize": 2097152,     // 2MB total form fields
        "maxFields": 1000,             // Max number of fields
        "allowEmptyFiles": false,      // Reject empty files
        "minFileSize": 1               // Reject 0-byte files
    },
    "maxBodySize": 10485760,           // 10MB for form-urlencoded
    "maxJsonSize": 1048576,            // 1MB for JSON payloads
    "maxTextSize": 1048576             // 1MB for text/plain
}
```

**DoS Protection:**
- All request bodies are size-limited (prevents memory exhaustion)
- Connections destroyed if limits exceeded
- Configurable per content-type

#### File Type Validation

**Always validate file types in your controllers:**

```javascript
class UploadController {
    uploadImage(obj) {
        const file = obj.params.formData.files.avatar[0];

        // 1. Validate MIME type
        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        if (!allowedTypes.includes(file.mimetype)) {
            this.json({ error: 'Only images allowed (JPEG, PNG, GIF, WebP)' });
            return;
        }

        // 2. Validate file extension
        const allowedExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
        if (!allowedExts.includes(file.extension.toLowerCase())) {
            this.json({ error: 'Invalid file extension' });
            return;
        }

        // 3. Validate file size (additional check)
        const maxSize = 5 * 1024 * 1024; // 5MB
        if (file.size > maxSize) {
            this.json({ error: 'File too large (max 5MB)' });
            return;
        }

        // 4. Generate safe filename (prevent path traversal)
        const crypto = require('crypto');
        const safeFilename = crypto.randomBytes(16).toString('hex') + file.extension;
        const uploadPath = path.join(master.root, 'uploads', safeFilename);

        // 5. Move file
        fs.renameSync(file.filepath, uploadPath);

        this.json({ success: true, filename: safeFilename });
    }

    uploadDocument(obj) {
        const file = obj.params.formData.files.document[0];

        // Allow PDF, DOC, DOCX only
        const allowedTypes = [
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ];

        if (!allowedTypes.includes(file.mimetype)) {
            this.json({ error: 'Only PDF and Word documents allowed' });
            return;
        }

        // Process upload...
    }
}
```

#### Formidable Custom Filter

**Add file filter in request.json (formidable v3+):**

```json
{
    "formidable": {
        "filter": "function({ name, originalFilename, mimetype }) { return mimetype && mimetype.startsWith('image/'); }"
    }
}
```

**Note:** JSON doesn't support functions, so filters must be configured in code:

```javascript
// config/initializers/config.js
const formidableOptions = master.env.request.formidable;

// Add runtime filter for images only
formidableOptions.filter = function({ name, originalFilename, mimetype }) {
    return mimetype && mimetype.startsWith('image/');
};

master.request.init({
    ...master.env.request,
    formidable: formidableOptions
});
```

#### Security Best Practices

1. **Always validate both MIME type AND file extension** (double check)
2. **Generate random filenames** (prevents overwriting and path traversal)
3. **Store uploads outside public directory** (prevent direct execution)
4. **Scan files for viruses** (use ClamAV or similar)
5. **Set proper file permissions** (chmod 644 for files, 755 for dirs)
6. **Never trust user-provided filenames** (can contain `../` or null bytes)
7. **Limit file sizes** (prevent disk space exhaustion)
8. **Delete temporary files** after processing

#### Delete Temporary Files

```javascript
class UploadController {
    upload(obj) {
        const file = obj.params.formData.files.upload[0];

        try {
            // Validate and process...

            // Delete temp file after processing
            master.request.deleteFileBuffer(file.filepath);

            this.json({ success: true });
        } catch (error) {
            // Always cleanup on error
            master.request.deleteFileBuffer(file.filepath);
            this.json({ error: error.message });
        }
    }
}
```

---

## File Conversion & Binary Data

MasterController v1.3.1 includes production-grade utilities for converting between files, base64, and binary data. These are essential for working with uploaded files, API responses, and data storage.

### Quick Start

```javascript
// Convert uploaded file to base64 for API response
class UploadController {
    uploadImage(obj) {
        const file = obj.params.formData.files.image[0];

        // Convert to base64 (with data URI for <img> src)
        const base64 = master.tools.fileToBase64(file, {
            includeDataURI: true,  // Adds "data:image/jpeg;base64," prefix
            maxSize: 5 * 1024 * 1024  // 5MB limit
        });

        this.json({
            success: true,
            imageData: base64  // Can be used directly in <img src="">
        });
    }
}
```

### File to Base64

#### `master.tools.fileToBase64(filePathOrFile, options)`

Convert a file to base64 string (binary-safe for all file types).

**Parameters:**
- `filePathOrFile`: File path string OR formidable file object
- `options`:
  - `includeDataURI` (boolean) - Prepend data URI (e.g., `data:image/jpeg;base64,`)
  - `maxSize` (number) - Maximum file size in bytes (default: 10MB)

**Returns:** Base64 string

**Examples:**

```javascript
// Convert file from file path
const base64 = master.tools.fileToBase64('/path/to/image.jpg');

// Convert uploaded file with data URI
const file = obj.params.formData.files.avatar[0];
const dataURI = master.tools.fileToBase64(file, {
    includeDataURI: true,
    maxSize: 5 * 1024 * 1024  // 5MB
});

// Use in HTML email or response
const html = `<img src="${dataURI}" alt="Avatar">`;

// Store in database
await db.query('UPDATE users SET avatar = ? WHERE id = ?', [base64, userId]);
```

**Error Handling:**

```javascript
try {
    const base64 = master.tools.fileToBase64(file);
} catch (error) {
    if (error.message.includes('not found')) {
        console.error('File does not exist');
    } else if (error.message.includes('exceeds maximum')) {
        console.error('File too large');
    } else if (error.message.includes('directory')) {
        console.error('Path is a directory, not a file');
    }
}
```

---

### Base64 to File

#### `master.tools.base64ToFile(base64String, outputPath, options)`

Convert base64 string to a file on disk (binary-safe).

**Parameters:**
- `base64String`: Base64 encoded string (with or without data URI prefix)
- `outputPath`: Destination file path
- `options`:
  - `overwrite` (boolean) - Allow overwriting existing files (default: false)
  - `createDir` (boolean) - Create parent directories if needed (default: true)

**Returns:** `{ success: true, filePath: outputPath, size: number }`

**Examples:**

```javascript
// Save base64 from API to file
class ApiController {
    async saveImage(obj) {
        const base64Data = obj.params.formData.imageData;

        // Save to disk
        const result = master.tools.base64ToFile(
            base64Data,
            './uploads/images/photo.jpg',
            { overwrite: false, createDir: true }
        );

        this.json({
            success: true,
            path: result.filePath,
            size: result.size
        });
    }
}

// Data URI with prefix (automatically handled)
const dataURI = 'data:image/png;base64,iVBORw0KGgoAAAANS...';
master.tools.base64ToFile(dataURI, './output.png');

// Pure base64 without prefix
const pureBase64 = 'iVBORw0KGgoAAAANS...';
master.tools.base64ToFile(pureBase64, './output.png');
```

---

### Buffer Operations

#### `master.tools.fileToBuffer(filePathOrFile, options)`

Convert file to Node.js Buffer (for in-memory processing).

**Parameters:**
- `filePathOrFile`: File path string OR formidable file object
- `options`:
  - `maxSize` (number) - Maximum file size (default: 10MB)

**Returns:** Node.js Buffer

**Examples:**

```javascript
// Read file into buffer
const buffer = master.tools.fileToBuffer('./image.jpg');

// Process image with sharp library
const sharp = require('sharp');
const resized = await sharp(buffer)
    .resize(800, 600)
    .toBuffer();

// Convert buffer back to base64
const base64 = master.tools.bytesToBase64(resized);
```

---

#### `master.tools.fileToBytes(filePathOrFile, options)`

Convert file to Uint8Array (for Web APIs and TypedArrays).

**Parameters:**
- `filePathOrFile`: File path string OR formidable file object
- `options`:
  - `maxSize` (number) - Maximum file size (default: 10MB)

**Returns:** Uint8Array

**Examples:**

```javascript
// Get raw bytes
const bytes = master.tools.fileToBytes('./document.pdf');

// Send over WebSocket as binary
websocket.send(bytes);

// Use with crypto
const crypto = require('crypto');
const hash = crypto.createHash('sha256').update(bytes).digest('hex');
```

---

#### `master.tools.bytesToBase64(bufferOrBytes, options)`

Convert Buffer or Uint8Array to base64 string.

**Parameters:**
- `bufferOrBytes`: Node.js Buffer OR Uint8Array
- `options`:
  - `includeDataURI` (boolean) - Prepend data URI
  - `mimetype` (string) - MIME type for data URI (required if includeDataURI=true)

**Returns:** Base64 string

**Examples:**

```javascript
const buffer = Buffer.from('Hello World');
const base64 = master.tools.bytesToBase64(buffer);
// → 'SGVsbG8gV29ybGQ='

// With data URI
const base64WithURI = master.tools.bytesToBase64(buffer, {
    includeDataURI: true,
    mimetype: 'text/plain'
});
// → 'data:text/plain;base64,SGVsbG8gV29ybGQ='
```

---

#### `master.tools.base64ToBytes(base64String)`

Convert base64 string to Node.js Buffer.

**Parameters:**
- `base64String`: Base64 string (with or without data URI prefix)

**Returns:** Node.js Buffer

**Examples:**

```javascript
const base64 = 'SGVsbG8gV29ybGQ=';
const buffer = master.tools.base64ToBytes(base64);
console.log(buffer.toString('utf8'));  // → 'Hello World'

// Handles data URIs automatically
const dataURI = 'data:text/plain;base64,SGVsbG8gV29ybGQ=';
const buffer2 = master.tools.base64ToBytes(dataURI);
```

---

### Streaming Large Files

#### `master.tools.streamFileToBase64(filePathOrFile, options)`

Stream large files to base64 without loading into memory (async).

**Parameters:**
- `filePathOrFile`: File path string OR formidable file object
- `options`:
  - `includeDataURI` (boolean) - Prepend data URI
  - `chunkSize` (number) - Read chunk size (default: 64KB)
  - `onProgress` (function) - Progress callback: `(bytesRead, totalBytes, percent) => {}`

**Returns:** Promise<base64 string>

**Examples:**

```javascript
// Stream large video file to base64
class VideoController {
    async processVideo(obj) {
        const file = obj.params.formData.files.video[0];

        // Stream with progress tracking
        const base64 = await master.tools.streamFileToBase64(file, {
            includeDataURI: true,
            chunkSize: 128 * 1024,  // 128KB chunks
            onProgress: (bytesRead, total, percent) => {
                console.log(`Processing: ${percent.toFixed(1)}% (${bytesRead}/${total} bytes)`);

                // Send progress to client via WebSocket
                master.socket.emit('upload-progress', { percent });
            }
        });

        this.json({ success: true, videoData: base64 });
    }
}

// Process 500MB file without memory issues
const largeFile = '/path/to/500mb-video.mp4';
const base64 = await master.tools.streamFileToBase64(largeFile, {
    onProgress: (read, total, percent) => {
        console.log(`${percent.toFixed(1)}% complete`);
    }
});
```

---

### Common Use Cases

#### Use Case 1: API Response with Embedded Image

```javascript
class ProductController {
    show(obj) {
        const product = db.getProduct(obj.params.id);
        const imagePath = `./uploads/products/${product.imageFilename}`;

        // Convert image to base64 for API
        const imageData = master.tools.fileToBase64(imagePath, {
            includeDataURI: true,
            maxSize: 2 * 1024 * 1024  // 2MB limit
        });

        this.json({
            id: product.id,
            name: product.name,
            image: imageData  // Client can use directly in <img src="">
        });
    }
}
```

#### Use Case 2: Store File in Database

```javascript
class DocumentController {
    async upload(obj) {
        const file = obj.params.formData.files.document[0];

        // Validate file type
        const allowedTypes = ['application/pdf', 'application/msword'];
        if (!allowedTypes.includes(file.mimetype)) {
            this.json({ error: 'Only PDF and Word documents allowed' });
            return;
        }

        // Convert to base64 for database storage
        const base64 = master.tools.fileToBase64(file, {
            maxSize: 10 * 1024 * 1024  // 10MB
        });

        // Store in database
        await this.db.query(
            'INSERT INTO documents (filename, mimetype, data) VALUES (?, ?, ?)',
            [file.originalFilename, file.mimetype, base64]
        );

        // Delete temp file
        master.request.deleteFileBuffer(file.filepath);

        this.json({ success: true });
    }
}
```

#### Use Case 3: Retrieve File from Database

```javascript
class DocumentController {
    async download(obj) {
        const docId = obj.params.id;

        // Get from database
        const doc = await this.db.query(
            'SELECT filename, mimetype, data FROM documents WHERE id = ?',
            [docId]
        );

        if (!doc) {
            master.errorRenderer.send(obj, 404, {
                message: 'Document not found'
            });
            return;
        }

        // Convert base64 back to file
        const tempPath = `./temp/${Date.now()}-${doc.filename}`;
        master.tools.base64ToFile(doc.data, tempPath);

        // Send file to client
        obj.response.setHeader('Content-Type', doc.mimetype);
        obj.response.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);

        const fs = require('fs');
        const fileStream = fs.createReadStream(tempPath);
        fileStream.pipe(obj.response);

        // Cleanup after sending
        fileStream.on('end', () => {
            fs.unlinkSync(tempPath);
        });
    }
}
```

#### Use Case 4: Image Processing Pipeline

```javascript
const sharp = require('sharp');

class ImageController {
    async processThumbnail(obj) {
        const file = obj.params.formData.files.image[0];

        // Read file to buffer
        const buffer = master.tools.fileToBuffer(file, {
            maxSize: 10 * 1024 * 1024
        });

        // Process with sharp
        const thumbnail = await sharp(buffer)
            .resize(200, 200, { fit: 'cover' })
            .jpeg({ quality: 80 })
            .toBuffer();

        // Convert thumbnail to base64
        const base64 = master.tools.bytesToBase64(thumbnail, {
            includeDataURI: true,
            mimetype: 'image/jpeg'
        });

        // Cleanup temp file
        master.request.deleteFileBuffer(file.filepath);

        this.json({
            success: true,
            thumbnail: base64
        });
    }
}
```

#### Use Case 5: Email with Embedded Images

```javascript
const nodemailer = require('nodemailer');

class EmailController {
    async sendWithImage(obj) {
        const file = obj.params.formData.files.logo[0];

        // Convert to base64 data URI
        const logoData = master.tools.fileToBase64(file, {
            includeDataURI: true
        });

        // Send email with embedded image
        const transporter = nodemailer.createTransport({/* config */});
        await transporter.sendMail({
            to: 'user@example.com',
            subject: 'Welcome!',
            html: `
                <h1>Welcome to our platform!</h1>
                <img src="${logoData}" alt="Logo">
                <p>Thanks for joining.</p>
            `
        });

        // Cleanup
        master.request.deleteFileBuffer(file.filepath);

        this.json({ success: true });
    }
}
```

---

### Security Best Practices

1. **Always set size limits:**
```javascript
const base64 = master.tools.fileToBase64(file, {
    maxSize: 5 * 1024 * 1024  // Prevent DoS
});
```

2. **Validate file types before conversion:**
```javascript
const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
if (!allowedTypes.includes(file.mimetype)) {
    throw new Error('Invalid file type');
}
const base64 = master.tools.fileToBase64(file);
```

3. **Delete temporary files after processing:**
```javascript
try {
    const base64 = master.tools.fileToBase64(file);
    // ... process ...
} finally {
    master.request.deleteFileBuffer(file.filepath);
}
```

4. **Use streaming for large files:**
```javascript
// ❌ Bad: Loads entire 500MB file into memory
const base64 = master.tools.fileToBase64(largeFile);

// ✅ Good: Streams in chunks
const base64 = await master.tools.streamFileToBase64(largeFile, {
    chunkSize: 128 * 1024
});
```

5. **Validate base64 before decoding:**
```javascript
try {
    const buffer = master.tools.base64ToBytes(untrustedBase64);
} catch (error) {
    console.error('Invalid base64 data');
}
```

---

### Deprecated Methods

#### `master.tools.base64()` - DEPRECATED

**⚠️ WARNING:** The original `base64()` method is **BROKEN for binary files** and should not be used. It uses `charCodeAt()` which only works correctly for text files (UTF-8). Binary files like images, PDFs, and videos will be corrupted.

**Do NOT use:**
```javascript
// ❌ BROKEN - Corrupts binary files
const broken = master.tools.base64(file.filepath);
```

**Use instead:**
```javascript
// ✅ CORRECT - Binary-safe
const correct = master.tools.fileToBase64(file);
```

The old method is kept for backward compatibility with text-only use cases, but all new code should use the production-grade methods documented above.

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

MasterController includes a production-ready timeout system with per-request tracking (Rails/Django style).

### Quick Start

```javascript
// config/initializers/config.js
const master = require('mastercontroller');

// Initialize timeout system
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

Configure different timeouts for different routes:

```javascript
// Short timeout for API endpoints (30 seconds)
master.timeout.setRouteTimeout('/api/*', 30000);

// Long timeout for reports (5 minutes)
master.timeout.setRouteTimeout('/admin/reports', 300000);

// Very long timeout for batch operations (10 minutes)
master.timeout.setRouteTimeout('/batch/process', 600000);

// Critical operations (1 minute)
master.timeout.setRouteTimeout('/checkout/*', 60000);
```

### Environment-Specific Configuration

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

### Monitoring Active Requests

```javascript
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

// Check for slow requests
stats.requests.forEach(req => {
    if (req.elapsed > req.timeout * 0.8) {
        console.warn(`Request close to timeout: ${req.path} (${req.elapsed}ms/${req.timeout}ms)`);
    }
});
```

### Disable/Enable Timeouts

```javascript
// Disable for debugging
master.timeout.disable();

// Re-enable
master.timeout.enable();

// Check status
console.log(master.timeout.getStats().enabled); // true/false
```

### Complete Setup Example

```javascript
// config/initializers/config.js
const master = require('mastercontroller');

// Initialize timeout system
master.timeout.init({
    globalTimeout: master.env.server.requestTimeout || 120000,
    enabled: true,
    onTimeout: (ctx, timeoutInfo) => {
        // Log timeout
        console.error(`Request timeout: ${timeoutInfo.path} (${timeoutInfo.duration}ms)`);

        // Send to monitoring service
        sendToMonitoring('timeout', timeoutInfo);
    }
});

// Configure route-specific timeouts
master.timeout.setRouteTimeout('/api/*', 30000);          // API: 30s
master.timeout.setRouteTimeout('/admin/reports', 300000); // Reports: 5m
master.timeout.setRouteTimeout('/batch/*', 600000);       // Batch: 10m

// Register middleware
master.pipeline.use(master.timeout.middleware());

// Monitor timeouts periodically
setInterval(() => {
    const stats = master.timeout.getStats();

    if (stats.activeRequests > 100) {
        console.warn(`High number of active requests: ${stats.activeRequests}`);
    }
}, 60000); // Every minute
```

### Best Practices

1. **Set appropriate global timeout**: 120 seconds (2 minutes) is a good default
2. **Use route-specific timeouts**: APIs should have shorter timeouts (30s)
3. **Long operations**: Use background jobs instead of long timeouts
4. **Disable in development**: For debugging, temporarily disable timeouts
5. **Monitor statistics**: Regularly check active requests and slow requests

---

## Error Handling

MasterController includes a professional error template system inspired by Rails and Django.

### Quick Start

```javascript
// config/initializers/config.js
const master = require('mastercontroller');

// Initialize error renderer
master.errorRenderer.init({
    templateDir: 'public/errors',  // Error templates directory
    environment: master.environmentType,
    showStackTrace: master.environmentType === 'development'  // Dev only
});
```

### Using Error Renderer

**In Middleware:**
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

**In Controllers:**
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

    async update(obj) {
        try {
            const userId = obj.params.id;
            const updates = obj.params.formData;

            await this.db.query('UPDATE users SET ? WHERE id = ?', [updates, userId]);
            this.redirect(`/users/${userId}`);
        } catch (error) {
            console.error('Update failed:', error);

            master.errorRenderer.send(obj, 500, {
                message: 'Failed to update user',
                code: 'DB_ERROR',
                stack: error.stack
            });
        }
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

Register custom error handlers for specific status codes:

```javascript
// Custom 404 handler
master.errorRenderer.registerHandler(404, (ctx, errorData) => {
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Page Not Found</title>
            <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                .icon { font-size: 100px; }
                h1 { color: #333; }
            </style>
        </head>
        <body>
            <div class="icon">🔍</div>
            <h1>Page Not Found</h1>
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
        <!DOCTYPE html>
        <html>
        <body>
            <h1>Oops! Something went wrong</h1>
            <p>Our team has been notified.</p>
            <p>Reference: ${errorData.code}</p>
        </body>
        </html>
    `;
});

// Custom 503 handler (maintenance mode)
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

### Common Use Cases

**Rate Limiting with Custom 429 Page:**
```javascript
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

**Protected Admin Section:**
```javascript
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

**Maintenance Mode:**
```javascript
const maintenanceMode = process.env.MAINTENANCE === 'true';

if (maintenanceMode) {
    master.pipeline.use(async (ctx, next) => {
        master.errorRenderer.send(ctx, 503, {
            message: 'Service temporarily unavailable'
        });
    });
}
```

### Complete Setup Example

```javascript
// config/initializers/config.js
const master = require('mastercontroller');

// Initialize error renderer
master.errorRenderer.init({
    templateDir: 'public/errors',
    environment: master.environmentType,
    showStackTrace: master.environmentType === 'development'
});

// Register custom handlers
master.errorRenderer.registerHandler(404, (ctx, errorData) => {
    return `
        <!DOCTYPE html>
        <html>
        <body>
            <h1>404 - Page Not Found</h1>
            <p>${errorData.message}</p>
            <a href="/">Go Home</a>
        </body>
        </html>
    `;
});

// Global error handler
master.pipeline.useError(async (error, ctx, next) => {
    console.error('Pipeline error:', error);

    master.errorRenderer.send(ctx, 500, {
        message: error.message,
        code: error.code,
        stack: error.stack
    });
});
```

### Best Practices

1. **Keep error messages user-friendly**: Don't expose technical details in production
2. **Show stack traces in development only**: Use `showStackTrace` conditional
3. **Provide actionable suggestions**: Help users resolve the issue
4. **Consistent design**: Match your application's design
5. **Test all error codes**: Ensure templates render correctly
6. **Log errors**: Use `logger` for error tracking
7. **Monitor errors**: Track error rates and patterns

---

## HTTPS Setup

MasterController v1.3.2 includes **production-grade HTTPS/TLS security** with automatic secure defaults.

### 🔒 Security Features (Automatic)

When you setup HTTPS, MasterController automatically configures:
- ✅ **TLS 1.3** by default (2026 security standard)
- ✅ **Secure cipher suites** (Mozilla Intermediate configuration)
- ✅ **Path traversal protection** for static files
- ✅ **Open redirect protection** for HTTP→HTTPS redirects
- ✅ **SNI support** for multiple domains
- ✅ **Certificate live reload** (zero-downtime updates)
- ✅ **HSTS support** with preload option

---

## Quick Start: HTTPS in 5 Minutes

### Development (Self-Signed Certificate)

**Step 1: Generate Self-Signed Certificate**
```bash
# Create certificates directory
mkdir -p certs
cd certs

# Generate self-signed certificate (valid for 365 days)
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem \
  -days 365 -nodes -subj "/CN=localhost"

# Combine for convenience
cat key.pem > localhost.pem
cat cert.pem >> localhost.pem

cd ..
```

**Step 2: Update `server.js`**
```javascript
const fs = require('fs');
const master = require('mastercontroller');

master.environmentType = process.env.NODE_ENV || 'development';
master.root = __dirname;

// Setup HTTPS for development
const server = master.setupServer('https', {
    key: fs.readFileSync('./certs/key.pem'),
    cert: fs.readFileSync('./certs/cert.pem')
});

require('./config/initializers/config');

master.start(server);
master.serverSettings({ httpPort: 3000 }); // Use 3000 for development

console.log('✅ HTTPS server running on https://localhost:3000');
console.log('⚠️  Self-signed certificate - browser will show warning (this is normal)');
```

**Step 3: Visit `https://localhost:3000`**
- Browser will show "Not Secure" warning
- Click "Advanced" → "Proceed to localhost" (safe for development)

---

### Production (Let's Encrypt - FREE)

**Step 1: Install Certbot**
```bash
# Ubuntu/Debian
sudo apt update
sudo apt install certbot

# CentOS/RHEL
sudo yum install certbot

# macOS
brew install certbot
```

**Step 2: Get FREE SSL Certificate**
```bash
# Stop any web server on port 80
sudo systemctl stop nginx

# Get certificate (replace with your domain)
sudo certbot certonly --standalone -d yourapp.com -d www.yourapp.com

# Certificates will be saved to:
# /etc/letsencrypt/live/yourapp.com/privkey.pem
# /etc/letsencrypt/live/yourapp.com/fullchain.pem
```

**Step 3: Update `server.js` for Production**
```javascript
const fs = require('fs');
const master = require('mastercontroller');

master.environmentType = process.env.NODE_ENV || 'production';
master.root = __dirname;

// Setup HTTPS with Let's Encrypt certificates
const server = master.setupServer('https', {
    key: fs.readFileSync('/etc/letsencrypt/live/yourapp.com/privkey.pem'),
    cert: fs.readFileSync('/etc/letsencrypt/live/yourapp.com/fullchain.pem')
});

// Enable HSTS (strongly recommended)
master.enableHSTS({
    maxAge: 31536000,        // 1 year
    includeSubDomains: true,
    preload: true
});

require('./config/initializers/config');

// Start HTTPS on port 443
master.start(server);
master.serverSettings({ httpPort: 443 });

// Redirect HTTP to HTTPS (port 80 → 443)
const redirectServer = master.startHttpToHttpsRedirect(80, '0.0.0.0', [
    'yourapp.com',
    'www.yourapp.com'
]);

console.log('========================================');
console.log('🚀 Production Server Started');
console.log('========================================');
console.log('✅ HTTPS: https://yourapp.com (port 443)');
console.log('✅ HTTP redirect: http://yourapp.com → https://yourapp.com');
console.log('✅ TLS 1.3 enabled');
console.log('✅ HSTS enabled (1 year)');
console.log('✅ Secure ciphers configured');
console.log('========================================');
```

**Step 4: Set Permissions (if needed)**
```bash
# Option 1: Allow Node.js to bind to ports 80/443 (Linux)
sudo setcap 'cap_net_bind_service=+ep' $(which node)

# Option 2: Run with sudo (not recommended)
sudo node server.js

# Option 3: Use reverse proxy (recommended - see below)
```

**Step 5: Auto-Renew Certificates**
```bash
# Certbot automatically renews certificates
# Test renewal process:
sudo certbot renew --dry-run

# Add to crontab for auto-renewal (runs daily)
sudo crontab -e
# Add this line:
0 0 * * * certbot renew --quiet --post-hook "systemctl restart myapp"
```

---

### Production (Custom Certificate)

If you have a certificate from a commercial CA (GoDaddy, Namecheap, etc.):

```javascript
const fs = require('fs');
const master = require('mastercontroller');

master.environmentType = 'production';
master.root = __dirname;

const server = master.setupServer('https', {
    key: fs.readFileSync('/path/to/your-domain.key'),
    cert: fs.readFileSync('/path/to/your-domain.crt'),
    ca: fs.readFileSync('/path/to/ca-bundle.crt') // Intermediate certificates
});

master.enableHSTS({
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
});

require('./config/initializers/config');
master.start(server);
master.serverSettings({ httpPort: 443 });

const redirectServer = master.startHttpToHttpsRedirect(80, '0.0.0.0', [
    'yourapp.com',
    'www.yourapp.com'
]);
```

---

---

## Production Deployment Options

### Option 1: Direct HTTPS (Simple, Good for Small Apps)

Run MasterController directly on ports 80/443:

```javascript
const fs = require('fs');
const master = require('mastercontroller');

master.environmentType = 'production';
master.root = __dirname;

const server = master.setupServer('https', {
    key: fs.readFileSync('/etc/letsencrypt/live/yourapp.com/privkey.pem'),
    cert: fs.readFileSync('/etc/letsencrypt/live/yourapp.com/fullchain.pem')
});

master.enableHSTS({
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
});

require('./config/initializers/config');
master.start(server);
master.serverSettings({ httpPort: 443 });

// HTTP redirect
const redirectServer = master.startHttpToHttpsRedirect(80, '0.0.0.0', [
    'yourapp.com',
    'www.yourapp.com'
]);
```

**Pros:**
- ✅ Simple setup
- ✅ No extra software needed
- ✅ Full control over TLS

**Cons:**
- ❌ Requires root/sudo for ports 80/443
- ❌ No load balancing
- ❌ No static file caching

---

### Option 2: Nginx Reverse Proxy (Recommended for Production)

Run MasterController on high port (3000) behind Nginx on ports 80/443:

**Step 1: Install Nginx**
```bash
# Ubuntu/Debian
sudo apt update
sudo apt install nginx

# CentOS/RHEL
sudo yum install nginx

# macOS
brew install nginx
```

**Step 2: Configure MasterController (High Port)**
```javascript
// server.js - Run on port 3000
const master = require('mastercontroller');

master.environmentType = 'production';
master.root = __dirname;

// HTTP only (Nginx handles HTTPS)
const server = master.setupServer('http');

require('./config/initializers/config');
master.start(server);
master.serverSettings({
    httpPort: 3000,
    hostname: '127.0.0.1'  // Only accept local connections
});

console.log('✅ Server running on http://127.0.0.1:3000');
console.log('⚠️  Behind Nginx reverse proxy');
```

**Step 3: Configure Nginx**
```nginx
# /etc/nginx/sites-available/yourapp.com

# HTTP redirect to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name yourapp.com www.yourapp.com;

    return 301 https://$server_name$request_uri;
}

# HTTPS server
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name yourapp.com www.yourapp.com;

    # SSL Configuration (Let's Encrypt)
    ssl_certificate /etc/letsencrypt/live/yourapp.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourapp.com/privkey.pem;
    ssl_trusted_certificate /etc/letsencrypt/live/yourapp.com/chain.pem;

    # Modern TLS configuration (matches MasterController defaults)
    ssl_protocols TLSv1.3 TLSv1.2;
    ssl_ciphers 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-RSA-AES256-GCM-SHA384';
    ssl_prefer_server_ciphers on;

    # HSTS
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Proxy to MasterController
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';

        # Forward real client IP
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;

        proxy_cache_bypass $http_upgrade;
    }

    # Static file caching (optional)
    location ~* \.(jpg|jpeg|png|gif|ico|css|js|svg|woff|woff2|ttf|eot)$ {
        proxy_pass http://127.0.0.1:3000;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_types text/plain text/css text/xml text/javascript application/json application/javascript application/xml+rss;
}
```

**Step 4: Enable Nginx Configuration**
```bash
# Create symlink to enable site
sudo ln -s /etc/nginx/sites-available/yourapp.com /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx

# Enable Nginx on boot
sudo systemctl enable nginx
```

**Step 5: Configure MasterController to Trust Proxy**
```javascript
// config/initializers/config.js
const master = require('mastercontroller');

// Trust X-Forwarded-* headers from Nginx
master.pipeline.use(async (ctx, next) => {
    // Get real client IP from X-Forwarded-For
    const forwardedFor = ctx.request.headers['x-forwarded-for'];
    if (forwardedFor) {
        ctx.request.clientIp = forwardedFor.split(',')[0].trim();
    }

    // Trust X-Forwarded-Proto for HTTPS detection
    if (ctx.request.headers['x-forwarded-proto'] === 'https') {
        ctx.request.isHttps = true;
    }

    await next();
});

// ... rest of config
```

**Pros:**
- ✅ No root/sudo needed for Node.js
- ✅ Static file caching
- ✅ Load balancing support
- ✅ Better performance
- ✅ Easier certificate management
- ✅ Industry standard

**Cons:**
- ❌ Extra complexity
- ❌ Another service to maintain

---

### Option 3: PM2 with Nginx (Best for Production)

Combine PM2 process manager with Nginx:

**Step 1: Install PM2**
```bash
npm install -g pm2
```

**Step 2: Create PM2 Ecosystem File**
```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'myapp',
    script: './server.js',
    instances: 'max',              // Use all CPU cores
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production'
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true
  }]
};
```

**Step 3: Start with PM2**
```bash
# Start application
pm2 start ecosystem.config.js

# Save PM2 configuration
pm2 save

# Setup PM2 to start on system boot
pm2 startup

# Monitor application
pm2 monit

# View logs
pm2 logs

# Restart application
pm2 restart myapp

# Reload with zero downtime
pm2 reload myapp
```

**Step 4: Configure Nginx** (same as Option 2)

**Pros:**
- ✅ Auto-restart on crash
- ✅ Zero-downtime deployments
- ✅ Cluster mode (use all CPU cores)
- ✅ Log management
- ✅ Monitoring
- ✅ Auto-start on boot

---

---

## Advanced HTTPS Configuration

### Multiple Domains (SNI - Server Name Indication)

MasterController supports serving multiple domains with different certificates:

**Method 1: Using Environment Configuration**
```json
// config/environments/env.production.json
{
    "server": {
        "httpPort": 443,
        "tls": {
            "default": {
                "keyPath": "/etc/letsencrypt/live/example.com/privkey.pem",
                "certPath": "/etc/letsencrypt/live/example.com/fullchain.pem"
            },
            "sni": {
                "api.example.com": {
                    "keyPath": "/etc/letsencrypt/live/api.example.com/privkey.pem",
                    "certPath": "/etc/letsencrypt/live/api.example.com/fullchain.pem"
                },
                "admin.example.com": {
                    "keyPath": "/etc/letsencrypt/live/admin.example.com/privkey.pem",
                    "certPath": "/etc/letsencrypt/live/admin.example.com/fullchain.pem"
                }
            },
            "hsts": true,
            "hstsMaxAge": 31536000
        }
    }
}
```

```javascript
// server.js
const master = require('mastercontroller');

master.environmentType = 'production';
master.root = __dirname;

// Loads TLS config from environment file (including SNI)
const server = master.setupServer('https');

require('./config/initializers/config');
master.start(server);
master.serverSettings(master.env.server);

console.log('✅ HTTPS with SNI enabled');
console.log('  • example.com');
console.log('  • api.example.com');
console.log('  • admin.example.com');
```

**Method 2: Programmatic SNI**
```javascript
const fs = require('fs');
const tls = require('tls');
const master = require('mastercontroller');

master.environmentType = 'production';
master.root = __dirname;

// Default certificate
const server = master.setupServer('https', {
    key: fs.readFileSync('/etc/letsencrypt/live/example.com/privkey.pem'),
    cert: fs.readFileSync('/etc/letsencrypt/live/example.com/fullchain.pem'),

    // SNI callback for different domains
    SNICallback: (servername, cb) => {
        let ctx;

        switch(servername) {
            case 'api.example.com':
                ctx = tls.createSecureContext({
                    key: fs.readFileSync('/etc/letsencrypt/live/api.example.com/privkey.pem'),
                    cert: fs.readFileSync('/etc/letsencrypt/live/api.example.com/fullchain.pem')
                });
                break;

            case 'admin.example.com':
                ctx = tls.createSecureContext({
                    key: fs.readFileSync('/etc/letsencrypt/live/admin.example.com/privkey.pem'),
                    cert: fs.readFileSync('/etc/letsencrypt/live/admin.example.com/fullchain.pem')
                });
                break;

            default:
                // Use default certificate
                ctx = null;
        }

        cb(null, ctx);
    }
});

require('./config/initializers/config');
master.start(server);
master.serverSettings({ httpPort: 443 });
```

---

### HTTP to HTTPS Redirect (Secure)

**⚠️ SECURITY:** Always specify allowed hosts to prevent open redirect attacks!

```javascript
// SECURE: Validate host header against whitelist
const redirectServer = master.startHttpToHttpsRedirect(80, '0.0.0.0', [
    'example.com',
    'www.example.com',
    'api.example.com'
]);

console.log('✅ HTTP redirect server running on port 80');
```

**Why host validation?** Without it, attackers can redirect users to malicious domains:
```bash
# Attack without validation:
curl -H "Host: evil.com" http://example.com
# Redirects to: https://evil.com (phishing!)

# With validation: Returns 400 Bad Request ✅
```

**For Multiple Domains:**
```javascript
// Redirect all domains
const redirectServer = master.startHttpToHttpsRedirect(80, '0.0.0.0', [
    'example.com',
    'www.example.com',
    'api.example.com',
    'admin.example.com',
    'blog.example.com'
]);
```

---

### Certificate Renewal (Let's Encrypt)

**Automatic Renewal (Recommended)**

Let's Encrypt certificates expire after 90 days. Setup automatic renewal:

```bash
# Method 1: Systemd timer (Ubuntu/Debian - already configured)
sudo systemctl status certbot.timer

# Method 2: Crontab (manual setup)
sudo crontab -e
# Add this line (runs twice daily):
0 0,12 * * * certbot renew --quiet --post-hook "systemctl restart myapp"

# Method 3: PM2 with reload hook
sudo crontab -e
# Add this line:
0 0 * * * certbot renew --quiet --post-hook "pm2 reload myapp"
```

**Manual Renewal**
```bash
# Test renewal (dry run)
sudo certbot renew --dry-run

# Actually renew certificates
sudo certbot renew

# Restart your application
pm2 restart myapp
# or
sudo systemctl restart myapp
```

**Certificate Live Reload (Zero Downtime)**

MasterController supports certificate live reload with `fs.watchFile()`:

```javascript
const fs = require('fs');
const master = require('mastercontroller');

const certPath = '/etc/letsencrypt/live/example.com/fullchain.pem';
const keyPath = '/etc/letsencrypt/live/example.com/privkey.pem';

let server = master.setupServer('https', {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
});

// Watch for certificate changes
fs.watchFile(certPath, (curr, prev) => {
    console.log('📝 Certificate changed, reloading...');

    try {
        // Reload certificates without restarting server
        const newCert = fs.readFileSync(certPath);
        const newKey = fs.readFileSync(keyPath);

        // Update server context
        server.setSecureContext({
            key: newKey,
            cert: newCert
        });

        console.log('✅ Certificate reloaded successfully (zero downtime)');
    } catch (error) {
        console.error('❌ Failed to reload certificate:', error);
    }
});

require('./config/initializers/config');
master.start(server);
master.serverSettings({ httpPort: 443 });
```

---

### Common Errors and Solutions

#### Error: "EACCES: permission denied, bind 80" or "bind 443"

**Problem:** Node.js doesn't have permission to bind to ports 80/443.

**Solutions:**

**Option 1: Use setcap (Linux - Recommended)**
```bash
# Give Node.js permission to bind to privileged ports
sudo setcap 'cap_net_bind_service=+ep' $(which node)

# Verify
getcap $(which node)
# Output: /usr/bin/node = cap_net_bind_service+ep
```

**Option 2: Run as root (Not Recommended)**
```bash
sudo node server.js
```

**Option 3: Use reverse proxy (Best)**
```bash
# Run Node.js on port 3000 (no permissions needed)
# Use Nginx on ports 80/443
```

**Option 4: Use authbind (Linux)**
```bash
sudo apt install authbind
sudo touch /etc/authbind/byport/80
sudo touch /etc/authbind/byport/443
sudo chmod 500 /etc/authbind/byport/80
sudo chmod 500 /etc/authbind/byport/443
sudo chown $USER /etc/authbind/byport/80
sudo chown $USER /etc/authbind/byport/443

# Run with authbind
authbind --deep node server.js
```

---

#### Error: "ENOENT: no such file or directory, open '/path/to/cert.pem'"

**Problem:** Certificate files don't exist or path is wrong.

**Solutions:**

```bash
# Check if files exist
ls -l /etc/letsencrypt/live/yourapp.com/

# Check permissions
sudo ls -l /etc/letsencrypt/live/yourapp.com/
# If you see permission denied, you need to run as root or copy certs

# Copy certificates to accessible location (if needed)
sudo cp /etc/letsencrypt/live/yourapp.com/privkey.pem ~/certs/
sudo cp /etc/letsencrypt/live/yourapp.com/fullchain.pem ~/certs/
sudo chown $USER:$USER ~/certs/*.pem
```

---

#### Error: "unable to verify the first certificate"

**Problem:** Missing intermediate certificates (chain).

**Solution:**

```javascript
// Use fullchain.pem instead of cert.pem
const server = master.setupServer('https', {
    key: fs.readFileSync('/path/to/privkey.pem'),
    cert: fs.readFileSync('/path/to/fullchain.pem'),  // NOT cert.pem!
    ca: fs.readFileSync('/path/to/chain.pem')         // Optional: explicit chain
});
```

---

#### Error: "cert has expired"

**Problem:** SSL certificate has expired.

**Solutions:**

```bash
# Check expiration date
openssl x509 -in /etc/letsencrypt/live/yourapp.com/fullchain.pem -noout -dates

# Renew certificate
sudo certbot renew

# Restart application
pm2 restart myapp
```

---

#### Error: Browser shows "Not Secure" or "NET::ERR_CERT_AUTHORITY_INVALID"

**Problem:** Self-signed certificate (development) or certificate not trusted.

**Solutions:**

**For Development (Self-Signed):**
1. Click "Advanced" in browser
2. Click "Proceed to localhost" (safe for development)
3. Or add certificate to system trust store

**For Production:**
1. Use Let's Encrypt or commercial CA certificate
2. Ensure fullchain.pem includes intermediate certificates
3. Check certificate matches domain name

---

#### Browser keeps redirecting between HTTP and HTTPS (Loop)

**Problem:** Redirect loop, usually caused by incorrect proxy configuration.

**Solution:**

```javascript
// config/initializers/config.js
// Configure hostname in environment file
master.env = {
    server: {
        hostname: 'yourapp.com',  // Set this!
        httpsPort: 443
    }
};

// For Nginx proxy, make sure X-Forwarded-Proto is set correctly
```

---

### HSTS (HTTP Strict Transport Security)

HSTS tells browsers to always use HTTPS for your domain (prevents downgrade attacks).

```javascript
// Basic usage (1 year, includeSubDomains)
master.enableHSTS();

// Custom configuration
master.enableHSTS({
    maxAge: 15552000,        // 180 days
    includeSubDomains: true, // Cover *.example.com
    preload: false           // Don't submit to preload list yet
});
```

**HSTS Preload List:**
After running HSTS for 30+ days, submit to [hstspreload.org](https://hstspreload.org/) for browser built-in enforcement.

### Environment-based TLS Configuration

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
            },
            "hsts": true,
            "hstsMaxAge": 31536000
        }
    }
}
```

```javascript
// Loads TLS config from environment file
const server = master.setupServer('https');
master.serverSettings(master.env.server);
```

**Features:**
- ✅ **SNI Support** - Different certificates for different domains
- ✅ **Live Reload** - Update certificates without restarting server
- ✅ **HSTS Configuration** - Automatic HSTS from config

### Advanced TLS Configuration

#### Custom TLS Version
```javascript
const server = master.setupServer('https', {
    key: fs.readFileSync('/path/to/key.pem'),
    cert: fs.readFileSync('/path/to/cert.pem'),
    minVersion: 'TLSv1.2',  // Override default TLS 1.3 (for compatibility)
    maxVersion: 'TLSv1.3'
});
```

#### Custom Cipher Suites
```javascript
const server = master.setupServer('https', {
    key: fs.readFileSync('/path/to/key.pem'),
    cert: fs.readFileSync('/path/to/cert.pem'),
    ciphers: [
        'TLS_AES_256_GCM_SHA384',
        'TLS_CHACHA20_POLY1305_SHA256',
        'ECDHE-RSA-AES256-GCM-SHA384'
    ].join(':')
});
```

**Note:** MasterController uses secure defaults. Only customize if you have specific requirements.

### Let's Encrypt Example

```javascript
// Let's Encrypt certificates (auto-renewed by certbot)
const server = master.setupServer('https', {
    key: fs.readFileSync('/etc/letsencrypt/live/example.com/privkey.pem'),
    cert: fs.readFileSync('/etc/letsencrypt/live/example.com/fullchain.pem')
});

master.enableHSTS({
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
});

master.start(server);
master.serverSettings({ httpPort: 443 });

// Secure HTTP redirect
const redirectServer = master.startHttpToHttpsRedirect(80, '0.0.0.0', [
    'example.com',
    'www.example.com'
]);
```

### Testing Your HTTPS Setup

#### 1. SSL Labs Test
```bash
# Test your HTTPS configuration (should get A or A+)
https://www.ssllabs.com/ssltest/analyze.html?d=yourdomain.com
```

#### 2. Local Testing
```bash
# Test TLS 1.3
curl -v --tlsv1.3 https://localhost

# Test HSTS header
curl -I https://localhost | grep Strict-Transport-Security

# Test HTTP redirect
curl -I http://localhost

# Test path traversal protection (should return 403)
curl http://localhost/../../../etc/passwd
```

#### 3. Cipher Suite Testing
```bash
# Use testssl.sh for comprehensive testing
./testssl.sh --full https://yourdomain.com

# Or nmap
nmap --script ssl-enum-ciphers -p 443 yourdomain.com
```

### Security Comparison

MasterController's HTTPS implementation **exceeds industry standards**:

| Feature | MasterController v1.3.1 | Express | ASP.NET Core | Rails |
|---------|-------------------------|---------|--------------|-------|
| **TLS 1.3 Default** | ✅ | ❌ | ❌ | ❌ |
| **Secure Ciphers** | ✅ Auto | ❌ Manual | ⚠️ Partial | ❌ Manual |
| **Path Traversal Protection** | ✅ | ✅ | ✅ | ✅ |
| **Open Redirect Protection** | ✅ | ✅ | ✅ | ✅ |
| **SNI Support** | ✅ Built-in | ❌ Manual | ✅ | ❌ Manual |
| **Certificate Live Reload** | ✅ **Unique!** | ❌ | ❌ | ❌ |
| **HSTS Built-in** | ✅ | Via helmet | ✅ | ✅ |

### Complete Production Example

```javascript
// server.js - Production HTTPS setup
const master = require('mastercontroller');
const fs = require('fs');

// Set environment
master.environmentType = process.env.NODE_ENV || 'production';
master.root = __dirname;

// Setup HTTPS with Let's Encrypt certificates
const server = master.setupServer('https', {
    key: fs.readFileSync('/etc/letsencrypt/live/example.com/privkey.pem'),
    cert: fs.readFileSync('/etc/letsencrypt/live/example.com/fullchain.pem')
});

// Enable HSTS with preload
master.enableHSTS({
    maxAge: 31536000,        // 1 year
    includeSubDomains: true,
    preload: true            // Submit to hstspreload.org after 30 days
});

// Load application configuration
require('./config/initializers/config');

// Start HTTPS server on port 443
master.start(server);
master.serverSettings({ httpPort: 443 });

// Start HTTP to HTTPS redirect with host validation
const redirectServer = master.startHttpToHttpsRedirect(80, '0.0.0.0', [
    'example.com',
    'www.example.com',
    'api.example.com',
    'admin.example.com'
]);

console.log('========================================');
console.log('🚀 MasterController Production Server');
console.log('========================================');
console.log('✅ HTTPS on port 443');
console.log('✅ HTTP redirect on port 80');
console.log('✅ TLS 1.3 enabled');
console.log('✅ Secure cipher suites');
console.log('✅ HSTS enabled (max-age: 1 year)');
console.log('✅ Path traversal protection');
console.log('✅ Open redirect protection');
console.log('========================================');
```

### Troubleshooting

**Certificate Errors:**
```bash
# Check certificate expiration
openssl x509 -in /path/to/cert.pem -noout -dates

# Verify certificate chain
openssl verify -CAfile /path/to/ca.pem /path/to/cert.pem
```

**Port Permission Errors (ports 80/443):**
```bash
# Option 1: Use setcap (Linux)
sudo setcap 'cap_net_bind_service=+ep' $(which node)

# Option 2: Run as root (not recommended)
sudo node server.js

# Option 3: Use reverse proxy (recommended)
# Run Node.js on high port (3000) behind nginx/Apache
```

**HSTS Testing:**
```bash
# Check if HSTS header is present
curl -I https://yourdomain.com | grep -i strict

# Check HSTS status in browser
# Chrome: chrome://net-internals/#hsts
# Firefox: about:networking#hsts
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

- `master.session.init(options)` - Initialize secure sessions
- `master.session.destroy(req, res)` - Destroy session completely
- `master.session.touch(sessionId)` - Extend session expiry
- `master.session.getSessionCount()` - Get active session count
- `master.session.clearAllSessions()` - Clear all sessions (testing only)
- `master.session.getBestPractices(environment)` - Get recommended settings
- `master.session.middleware()` - Get pipeline middleware

**Session Data Access:** Use `obj.request.session` object directly (Rails/Express style)

### Request

- `master.request.getRequestParam(request, response)` - Parse request body (internal)

### HTML/Template

- `master.html.init(path)` - Set views path
- `master.template.init(layout)` - Set layout template

### Tools

**Encryption:**
- `master.tools.encrypt(data, secret)` - Encrypt data with AES-256-CBC
- `master.tools.decrypt(data, secret)` - Decrypt data with AES-256-CBC

**File Conversion (NEW in v1.3.1):**
- `master.tools.fileToBase64(filePathOrFile, options)` - Convert file to base64 (binary-safe)
- `master.tools.base64ToFile(base64String, outputPath, options)` - Convert base64 to file
- `master.tools.fileToBuffer(filePathOrFile, options)` - Convert file to Node.js Buffer
- `master.tools.fileToBytes(filePathOrFile, options)` - Convert file to Uint8Array
- `master.tools.bytesToBase64(bufferOrBytes, options)` - Convert Buffer/Uint8Array to base64
- `master.tools.base64ToBytes(base64String)` - Convert base64 to Buffer
- `master.tools.streamFileToBase64(filePathOrFile, options)` - Stream large files to base64 (async)

**Utilities:**
- `master.tools.combineObjects(target, source)` - Merge objects
- `master.tools.makeWordId(length)` - Generate random ID

**Deprecated:**
- `master.tools.base64(path)` - ⚠️ DEPRECATED - Broken for binary files, use `fileToBase64()` instead

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

### Security Documentation

- [Security Fixes v1.3.2](SECURITY-FIXES-v1.3.2.md) - All security fixes and migration guide
- [Security Quick Start](docs/SECURITY-QUICKSTART.md) - 5-minute security setup guide
- [Security Audit - Action System](docs/SECURITY-AUDIT-ACTION-SYSTEM.md) - Complete security audit of controllers and filters
- [Security Audit - HTTPS](docs/SECURITY-AUDIT-HTTPS.md) - HTTPS/TLS security audit

### Feature Documentation

- [Timeout and Error Handling](docs/timeout-and-error-handling.md) - Professional timeout tracking and error rendering
- [Environment TLS Reference](docs/environment-tls-reference.md) - TLS/SNI configuration reference

---

## License

MIT

---

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

---

## Support

For issues and questions, please visit: [GitHub Issues](https://github.com/alexanderrich/MasterController/issues)
