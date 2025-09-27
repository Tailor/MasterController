## Server setup: Hostname binding

Bind the listener to a specific interface using `hostname` (or `host`/`http`).

### server.js
```js
const master = require('./MasterControl');

master.root = __dirname;
master.environmentType = process.env.NODE_ENV || 'development';

const server = master.setupServer('http');
master.start(server);

// Bind to localhost only
master.serverSettings({ httpPort: 3000, hostname: '127.0.0.1', requestTimeout: 60000 });

master.startMVC('app');
```

### Notes
- Use `0.0.0.0` to accept connections on all interfaces.
- In production with a reverse proxy, bind to `127.0.0.1` so only the proxy can reach the app.

