## Server setup: HTTPS via environment TLS (with SNI and live reload)

This uses `config/environments/env.<env>.json` to configure TLS, SNI (multi-domain), HSTS, and watches cert files for live reload.

### Example env.production.json
```json
{
  "server": {
    "httpPort": 8443,
    "hostname": "0.0.0.0",
    "requestTimeout": 60000,
    "tls": {
      "hsts": true,
      "hstsMaxAge": 15552000,
      "minVersion": "TLSv1.2",
      "honorCipherOrder": true,
      "alpnProtocols": ["h2", "http/1.1"],
      "default": {
        "keyPath": "/etc/ssl/private/site.key",
        "certPath": "/etc/ssl/certs/site.crt",
        "caPath": "/etc/ssl/certs/chain.pem"
      },
      "sni": {
        "example.com": {
          "keyPath": "/etc/ssl/private/example.key",
          "certPath": "/etc/ssl/certs/example.crt",
          "caPath": "/etc/ssl/certs/chain.pem"
        },
        "api.example.com": {
          "keyPath": "/etc/ssl/private/api.key",
          "certPath": "/etc/ssl/certs/api.crt",
          "caPath": "/etc/ssl/certs/chain.pem"
        }
      }
    }
  }
}
```

### server.js (HTTPS from env)
```js
const master = require('./MasterControl');

master.root = __dirname;
master.environmentType = process.env.NODE_ENV || 'production';

// No credentials passed; MasterControl will auto-load TLS from env
const server = master.setupServer('https');
master.start(server);
master.serverSettings(master.env.server);
master.startMVC('app');

// Optional: HTTP->HTTPS redirect (listen on 80)
// master.startHttpToHttpsRedirect(80, '0.0.0.0');
```

### How it works
- `default`: certs used when SNI domain does not match any entry.
- `sni`: per-domain certificates; the server chooses the right cert via `SNICallback`.
- Live reload: when any `keyPath`/`certPath`/`caPath` changes, the secure context is rebuilt in-memory (no restart needed).
- HSTS: when enabled, responses over HTTPS include `strict-transport-security` with the configured max-age.

