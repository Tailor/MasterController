## Environment TLS/SNI reference

Place environment files at `config/environments/env.<environment>.json`.

### server section
```json
{
  "server": {
    "httpPort": 3000,
    "hostname": "127.0.0.1",
    "requestTimeout": 60000,
    "tls": { /* optional, for HTTPS when using setupServer('https') without credentials */ }
  }
}
```

### tls section
```json
"tls": {
  "hsts": true,                 // add HSTS header on HTTPS responses
  "hstsMaxAge": 15552000,       // HSTS max-age in seconds (default 180 days)
  "minVersion": "TLSv1.2",     // minimum TLS version ('TLSv1.2' or 'TLSv1.3')
  "honorCipherOrder": true,     // prefer server cipher order
  "alpnProtocols": ["h2", "http/1.1"], // enable HTTP/2 and HTTP/1.1
  "default": {                  // fallback certificate if SNI host doesn't match
    "keyPath": "/path/to/key.pem",
    "certPath": "/path/to/cert.pem",
    "caPath": "/path/to/chain.pem",
    "pfxPath": null,            // optional if using PFX
    "passphrase": null          // optional if key is encrypted
  },
  "sni": {                      // per-domain certificates
    "example.com": {
      "keyPath": "/path/to/example.key",
      "certPath": "/path/to/example.crt",
      "caPath": "/path/to/chain.pem"
    },
    "api.example.com": {
      "keyPath": "/path/to/api.key",
      "certPath": "/path/to/api.crt",
      "caPath": "/path/to/chain.pem"
    }
  }
}
```

### Terminology
- tls: Transport Layer Security. Encrypts traffic between client and server.
- SNI: Server Name Indication. Lets the server present different certificates based on the requested hostname during TLS handshake.
- default: The certificate used when no SNI match is found.

### Behavior
- If you call `setupServer('https')` without credentials, MasterControl reads `server.tls` and builds secure contexts (default + SNI) and watches the key/cert files for changes. Updates apply in-memory without restart.
- If you pass credentials directly to `setupServer('https', credentials)`, those are used instead and env `tls` is ignored.

### Tips
- Keep private keys readable only by the process user.
- Prefer `TLSv1.2`+ and enable HTTP/2 via ALPN.
- If binding to 443 without a proxy, consider using a high port (8443) or grant `CAP_NET_BIND_SERVICE` to avoid running as root.

