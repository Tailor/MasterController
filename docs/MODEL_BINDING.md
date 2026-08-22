# Model binding, validation & ProblemDetails (v2.4.0)

ASP.NET Core's `[ApiController]` behaviors for MasterController: declarative per-action schemas bind `this.model`, invalid input answers **400 `ValidationProblemDetails`** automatically, errors are **RFC 7807 `application/problem+json`**, controllers get **typed results**, and routes get **typed constraints**.

| ASP.NET Core | MasterController |
|---|---|
| `[FromBody] CreateDto dto`, `[FromQuery]`, `[FromRoute]`, `[FromForm]` | `static schemas = { create: { body: {…}, query: {…}, route: {…}, form: {…}, files: {…}, headers: {…} } }` → `this.model` (merged, coerced), `this.modelState` |
| DataAnnotations `[Required] [Range] [StringLength] [EmailAddress] [RegularExpression]` | rule `{ type, required, default, min, max, minLength, maxLength, pattern, enum, items, properties, custom, nullable, trim, coerce, message }` |
| `ModelState.IsValid`, automatic 400 | `this.modelState.isValid`; automatic **400 ValidationProblemDetails** (`static autoValidate = false` to handle it yourself) |
| `ProblemDetails` / `ValidationProblemDetails` | `this.problem({ status, title, detail, type, instance, …extensions })` / `this.validationProblem(errors)` |
| `Ok / Created / Accepted / NoContent / NotFound / Conflict / BadRequest / File / StatusCode` | `this.ok(data)`, `this.created(location, data)`, `this.accepted()`, `this.noContent()`, `this.notFound(detail)`, `this.conflict()`, `this.badRequest()`, `this.unprocessable(errors)`, `this.file(pathOrBuffer, { contentType, fileName, inline })`, `this.statusCode(code, body)` |
| Route constraints `{id:int}`, `{slug:regex(...)}` | `'/items/:id(int)'`, `'/items/:slug(slug)'`, `'/codes/:code(regex:^[A-Z]{3}$)'` — int, number, bool, uuid, alpha, alphanum, slug, length(n), minlength(n), maxlength(n), min(n), max(n), regex:… |
| Unhandled exception → ProblemDetails for API clients | thrown errors answer `application/problem+json` when the client accepts JSON (HTML error pages for browsers) |

## Declarative binding

```js
export default class ItemsController {
  static schemas = {
    create: { body: { name: { type: 'string', required: true, minLength: 2 }, price: { type: 'number', min: 0 }, tags: { type: 'array', items: 'string' } } },
    index:  { query: { page: { type: 'integer', default: 1, min: 1 }, q: 'string' } },
    update: { route: { id: 'integer!' }, body: { name: 'string', price: { type: 'number', min: 0 } } },
    '*':    { query: { tenant: 'string' } },   // fallback for other actions
  };

  async create() {
    // this.model = { name, price, tags } — validated, coerced, unknown fields stripped
    const item = await this.db.Item.add(this.model);
    await this.db.saveChanges();
    this.created(`/items/${item.id}`, item);
  }
}
```

A bare schema (no `body`/`query`/… keys) binds the body for POST/PUT/PATCH and the query for other methods. Binding runs after authorization and before your `beforeAction` filters. Validation errors are keyed like ASP.NET `ModelState` (`"address.city"`, `"tags[1]"`):

```json
{ "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1", "title": "One or more validation errors occurred.", "status": 400,
  "instance": "/items", "errors": { "name": ["name must be at least 2 characters"], "price": ["price must be at least 0"] } }
```

## Rules

`type`: `string` (default) | `number` | `integer` | `boolean` | `email` | `url` | `uuid` | `date` | `datetime` | `array` | `object` | `any`. Shorthands: `'integer!'` (required), a function (`custom`). Coercion from query/route/form strings is on by default (`coerce: false` to disable); strings are trimmed (`trim: false`). `enum`, `min`/`max` (numbers, dates), `minLength`/`maxLength` (strings, arrays), `pattern`, `items` (array element rule), `properties` (nested object schema), `default` (value or function), `nullable`, `custom(value, model, field) → string | false | null | Promise`. JSON-Schema-like `{ type: 'object', properties, required: [], additionalProperties }` is accepted too.

## Manual control

```js
static autoValidate = false;                     // bind but do not auto-400
async create() {
  if (!this.modelState.isValid) return this.unprocessable(this.modelState.errors);   // 422
}
async other() {
  const m = await this.bind({ body: { n: 'integer!' } });  // explicit; null when invalid (400 already written)
  if (!m) return;
  const { valid, value, errors } = await this.validateModel(anything, schema);       // no response written
}
```

`master.validation.validate(data, schema)` and `master.validation.bind(requestObject, spec)` expose the same engine outside controllers.
