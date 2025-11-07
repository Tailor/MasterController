## MasterController Framework

MasterController is a lightweight MVC-style server framework for Node.js with routing, controllers, views, dependency injection, CORS, sessions, sockets, and more.

### Install
```
npm install mastercontroller
```

### Quickstart
```js
// server.js
const master = require('./MasterControl');

master.root = __dirname;                    // your project root
master.environmentType = 'development';     // or process.env.NODE_ENV

const server = master.setupServer('http');  // or 'https'
master.start(server);
master.serverSettings({ httpPort: 3000, hostname: '127.0.0.1', requestTimeout: 60000 });

// Or load from config/environments/env.<env>.json
// master.serverSettings(master.env.server);

// Load your routes
master.startMVC('app');
```

### Routes
Create `app/config/routes.js` and define routes with `master.router.start()` API.

### Controllers
Place controllers under `app/controllers/*.js` and export methods matching your routes.

### Views and Templates
Views live under `app/views/<controller>/<action>.html` with a layout at `app/views/layouts/master.html`.

### CORS and Preflight
`MasterCors` configures CORS headers. Preflight `OPTIONS` requests are short-circuited with 204.

### HTTPS
Use `setupServer('https', credentials)` or configure via environment TLS; see docs in `docs/` for multiple setups.

### Docs
- `docs/server-setup-http.md`
- `docs/server-setup-https-credentials.md`
- `docs/server-setup-https-env-tls-sni.md`
- `docs/server-setup-hostname-binding.md`
- `docs/server-setup-nginx-reverse-proxy.md`
- `docs/environment-tls-reference.md`

### Production tips
- Prefer a reverse proxy for TLS and serve Node on a high port.
- If keeping TLS in Node, harden TLS and manage cert rotation.

### License
MIT

