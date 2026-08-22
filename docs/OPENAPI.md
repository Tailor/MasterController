# OpenAPI (v2.9.0)

ASP.NET Core's built-in OpenAPI (`AddOpenApi()` / `MapOpenApi()`) plus a Swagger-UI page. The document is **generated from what the app already declares** — routes, typed constraints, `static schemas`, `authorize`, auth schemes, output-cache policies — so there is nothing to keep in sync by hand.

```js
const server = master.setupServer('http');
master.useOpenApi({
  path: '/openapi.json',                 // default
  ui: '/docs',                           // Swagger UI page (true = '/docs', false = none); CDN-loaded in the browser
  title: 'Items API', version: '2.0.0', description: '…',
  servers: [{ url: 'https://api.example.com' }],
  filter: ({ controller }) => controller !== 'internal',   // hide routes
  transform: (doc) => doc,                                // last-chance edits
});
await master.start(server);
master.openApi.document();               // the object, e.g. for tests or a build step
```

What is derived:

| Source | OpenAPI |
|---|---|
| `router.route('/items/:id(int)', 'items#show', 'get')` | `paths['/items/{id}'].get`, path parameter `id: integer`; `operationId: items_show`, `tags: ['items']` |
| `router.resources('tags', { only })` | the REST operations |
| `static schemas = { create: { body, query, headers, route } }` | `requestBody` (JSON Schema from the validation rules), `query`/`header`/`path` parameters, `400 ValidationProblemDetails` |
| route `{ authorize }` / `static authorize` / `{ allowAnonymous }` | `security: [{ bearer: ['role:admin', 'policy:Senior'] }]`, `401`/`403` ProblemDetails; anonymous → `security: []` |
| `master.auth.addJwtBearer / addCookie / custom` | `components.securitySchemes` (`http bearer JWT`, `apiKey cookie`, `apiKey header`) |
| `static openapi = { action: { summary, description, tags, responses, deprecated, operationId } }` | operation metadata (`responses` values: a string description or a full response object) |
| `{ outputCache }` | `x-output-cache` extension |

Rules → JSON Schema: `string` (minLength/maxLength/pattern), `email`/`url`/`uuid`/`date`/`datetime` (formats), `number`/`integer` (minimum/maximum), `boolean`, `array` (items/minItems/maxItems), `object` (properties/required), `enum`, `default`, `nullable`.
