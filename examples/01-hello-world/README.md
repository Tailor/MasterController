# Example: Hello World (ESM)

The smallest possible MasterController v2.0+ application: one route, one controller, one JSON response.

## Run it

```bash
npm install
node server.js
```

Then visit http://127.0.0.1:3000/ — you should see:

```json
{ "message": "Hello from MasterController v2.0 (ESM)!" }
```

## What this demonstrates

- **ESM-only**: `package.json` has `"type": "module"`, every file uses `import`/`export`.
- **Default singleton import**: `import master from 'mastercontroller'` gives you the framework instance.
- **Async startup**: `await master.startMVC(...)` and `await master.start(...)` — these are async in v2.0 because the framework dynamically imports your controllers and config files.
- **Controller registry**: `master.startMVC('app')` scans `app/controllers/` and pre-loads everything before the server accepts requests. Errors in your controllers surface at startup, not on the first request.
- **No `__dirname` magic**: ESM doesn't define `__dirname`. The `fileURLToPath(import.meta.url)` pattern is the standard replacement.

## Files

- `server.js` — entry point
- `app/routes.js` — route definitions (loaded by `startMVC`)
- `app/controllers/api/helloController.js` — controller class
- `config/environments/env.development.json` — environment config (loaded eagerly at startup)
- `package.json` — `"type": "module"`, links the local framework via `file:`
