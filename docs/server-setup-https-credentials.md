## Server setup: HTTPS with direct credentials

Pass key/cert (and optional chain/ca) directly to `setupServer('https', credentials)`.

### server.js (HTTPS credentials)
```js
const fs = require('fs');
const master = require('./MasterControl');

master.root = __dirname;
master.environmentType = process.env.NODE_ENV || 'production';

const credentials = {
  key: fs.readFileSync('/etc/ssl/private/site.key'),
  cert: fs.readFileSync('/etc/ssl/certs/site.crt'),
  ca: fs.readFileSync('/etc/ssl/certs/chain.pem'),
  minVersion: 'TLSv1.2',
  honorCipherOrder: true,
  ALPNProtocols: ['h2', 'http/1.1']
};

const server = master.setupServer('https', credentials);
master.start(server);
master.serverSettings({ httpPort: 8443, hostname: '0.0.0.0', requestTimeout: 60000 });
master.startMVC('app');
```

### Notes
- Use a high port (e.g., 8443) to avoid running as root, or grant `CAP_NET_BIND_SERVICE` if binding to 443.
- Strong defaults are ensured if you omit them, but explicitly setting them is recommended.
- For multiple domains, see the TLS/SNI guide.

