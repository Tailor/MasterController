// A controller in v2.0+ MasterController.
//
// Controllers are pre-loaded into the registry at framework startup, so:
//   - Errors here surface immediately, not on the first request
//   - Request-time dispatch is a Map.get(), no fs/import overhead
//
// Controllers are plain ESM classes with `export default`.

export default class HelloController {
  // The constructor receives the request context object.
  // Each request gets its own controller instance.
  constructor(req) {
    this._req = req;
  }

  // Action methods are called with the same request context object.
  // Use ctx.response for the raw Node response, ctx.request for the raw request,
  // ctx.params for parsed params, etc.
  root(ctx) {
    ctx.response.writeHead(200, { 'Content-Type': 'application/json' });
    ctx.response.end(JSON.stringify({ message: 'Hello from MasterController v2.0 (ESM)!' }));
  }
}
