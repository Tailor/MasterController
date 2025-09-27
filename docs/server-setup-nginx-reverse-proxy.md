## Server setup: Nginx reverse proxy with HTTP→HTTPS redirect

Recommended production pattern: Node app on a high port (HTTP), Nginx on 80/443 handling TLS and redirects.

### server.js (app on HTTP localhost:3000)
```js
const master = require('./MasterControl');

master.root = __dirname;
master.environmentType = process.env.NODE_ENV || 'production';

const server = master.setupServer('http');
master.start(server);
master.serverSettings({ httpPort: 3000, hostname: '127.0.0.1', requestTimeout: 60000 });
master.startMVC('app');
```

### Nginx config
```nginx
server {
  listen 80;
  server_name yourdomain.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  server_name yourdomain.com;

  ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

### Notes
- Use certbot or another ACME client to manage certificates and renewals automatically.
- This keeps Node unprivileged (no need to bind to 443) and simplifies TLS.

