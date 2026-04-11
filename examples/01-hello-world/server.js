// MasterController v2.0+ — ESM-only.
// Smallest possible "it works" example: one route, one controller, one response.
//
// Run with:  node server.js
// Then visit: http://localhost:3000/

import master from 'mastercontroller';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// Resolve __dirname in ESM (this is the standard pattern)
const __dirname = dirname(fileURLToPath(import.meta.url));

// Set the application root and environment
master.root = __dirname;
master.environmentType = process.env.NODE_ENV || 'development';

// Create the HTTP server (master.setupServer wires up the framework pipeline)
const server = master.setupServer('http');

// startMVC() loads ./app/routes.js (which calls master.router.start().route(...))
// AND pre-loads every controller in ./app/controllers/. Both happen via dynamic
// ESM import, so this call is async.
await master.startMVC('app');
await master.start(server);

const PORT = parseInt(process.env.PORT, 10) || 3456;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Hello-world example listening on http://127.0.0.1:${PORT}/`);
});
