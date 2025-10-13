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

### How File Uploads Work

MasterController handles file uploads through the `formidable` library (v3.5.4+) integrated into the request parsing pipeline in `MasterRequest.js`.

**Processing Flow:**

1. **Content-Type Detection** - When a request arrives, the framework parses the `Content-Type` header to determine how to handle the request body (`MasterRequest.js:34-36`)

2. **Multipart Form Data** - For `multipart/form-data` requests (file uploads), the framework uses formidable's `IncomingForm` to parse the request (`MasterRequest.js:43-78`)

3. **Event-Based Parsing** - Formidable emits events during parsing:
   - `field` event: Captures regular form fields and adds them to `parsedURL.formData.fields`
   - `file` event: Captures uploaded files and stores them in `parsedURL.formData.files` as arrays (supporting multiple file uploads per field)
   - `end` event: Signals completion and resolves the promise with parsed data

4. **File Metadata** - Each uploaded file object includes:
   - `name` or `originalFilename`: The original filename
   - `extension`: Extracted file extension (e.g., `.jpg`, `.pdf`)
   - `filepath`: Temporary location where formidable stored the file
   - Other formidable metadata (size, mimetype, etc.)

5. **Accessing Uploads in Controllers** - In your controller actions, access uploaded files via:
   ```js
   this.params.formData.files['fieldName'][0]  // First file for 'fieldName'
   this.params.formData.fields['textField']     // Regular form fields
   ```

6. **Multiple Files** - Files are always stored as arrays in `parsedURL.formData.files[field]`, allowing multiple files to be uploaded with the same field name (`MasterRequest.js:59-65`)

7. **Cleanup** - Use `this.request.deleteFileBuffer(filePath)` to remove temporary files after processing (`MasterRequest.js:162-169`)

**Configuration Options:**

You can configure file upload behavior via `master.request.init()`:
- `disableFormidableMultipartFormData`: Set to `true` to skip file upload parsing
- `formidable`: Pass options directly to formidable (upload directory, max file size, etc.)

**Supported Content Types:**
- `multipart/form-data` - File uploads
- `application/x-www-form-urlencoded` - Standard forms
- `application/json` - JSON payloads
- `text/plain` - Plain text (1MB limit)
- `text/html` - HTML content

### Production tips
- Prefer a reverse proxy for TLS and serve Node on a high port.
- If keeping TLS in Node, harden TLS and manage cert rotation.

### License
MIT

