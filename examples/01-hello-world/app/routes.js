// MasterController loads this file via `master.startMVC('app')`.
// It runs once at startup to register routes.
//
// In v2.0 routes.js is an ESM module — even if it has no imports, the file
// is interpreted as ESM because the package.json sets "type": "module".

import master from 'mastercontroller';

const router = master.router.start();
router.route('/', 'api/hello#root', 'get');
