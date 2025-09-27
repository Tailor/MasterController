## Server setup: HTTP

This example starts a plain HTTP server. Useful for local development, or when you run behind a reverse proxy that terminates TLS.

### server.js (HTTP)
```js
const master = require('./MasterControl');

// Point master to your project root and environment
master.root = __dirname;
master.environmentType = process.env.NODE_ENV || 'development';

// Create HTTP server and bind it
const server = master.setupServer('http');
master.start(server);

// Use either explicit settings or your environment JSON
// Option A: explicit
// master.serverSettings({ httpPort: 3000, hostname: '127.0.0.1', requestTimeout: 60000 });

// Option B: from env config at config/environments/env.<env>.json
master.serverSettings(master.env.server);

// Load your routes and controllers
// If your routes are under <root>/app/**/routes.js
master.startMVC('app');
```

### Notes
- `master.serverSettings` now honors `hostname` (or `host`/`http`) if provided; otherwise it listens on all interfaces.
- For production, prefer running behind a reverse proxy and keep the app on a high port (e.g., 3000).

