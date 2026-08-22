# Logging (v2.7.0)

ASP.NET Core's `ILogger<T>` model for application code: category loggers, minimum levels per category from configuration, structured message templates, scopes that flow through `await`, request correlation and pluggable providers. (The framework's own diagnostics keep using the internal error logger; this is the API for *your* code.)

| ASP.NET Core | MasterController |
|---|---|
| `ILoggerFactory.CreateLogger("Orders.Service")` / `ILogger<T>` | `master.createLogger('Orders.Service')`; controllers get **`this.logger`** (category = controller class) |
| `LogLevel` Trace/Debug/Information/Warning/Error/Critical | `trace/debug/info/warn/error/critical` (`fatal` = critical); `log(level, …)`, `isEnabled(level)` |
| `"Logging": { "LogLevel": { "Default": "Information", "Orders": "Debug" } }` | same keys in `config/appsettings.json` (longest category prefix wins; `Logging:MinimumLevel` also honored); re-applied on configuration reload |
| message templates `"User {Id} logged in"` | `logger.info('user {id} logged in', { id })` — rendered message + `properties` kept for sinks |
| `logger.LogError(ex, "…")` | `logger.error('import failed', err)` / `logger.error('import failed', { file }, err)` |
| `BeginScope(state)` | `logger.beginScope({ orderId })` → disposer, or `await logger.scope({ orderId }, async () => …)` (async-safe) |
| `HttpContext.TraceIdentifier`, `X-Request-Id` | every request runs in a scope `{ requestId, method, path }`; incoming `X-Request-Id` honored, otherwise a UUID; echoed on the response; access-log line per request (`Request` category, info) |
| Console / JSON / custom providers | `consoleProvider({ json })` (default; JSON lines when `NODE_ENV=production` or `Logging:Console:Json=true`), `memoryProvider()`, `master.logging.addProvider(fn | { write, minimumLevel })` |
| Enrichment | `master.logging.enrich({ service: 'api', version })` |
| Sensitive data | property keys `password, secret, token, authorization, cookie, apiKey…` are redacted (`master.logging.redact`) |

```js
// config/appsettings.json
{ "Logging": { "LogLevel": { "Default": "info", "Orders": "debug", "Request": "warn" }, "Console": { "Json": false } } }

// a service
const log = master.createLogger('Orders.Service');
log.info('order {id} placed for {amount}', { id: order.id, amount: order.total });
await log.scope({ orderId: order.id }, async () => { /* every log here carries orderId */ });

// a controller
export default class OrdersController {
  async create() { this.logger.info('creating'); /* scope: { requestId, method, path } automatically */ }
}

// sinks
master.logging.addProvider((entry) => shipToDatadog(entry));            // { timestamp, level, category, message, properties?, error?, scope? }
master.logging.addProvider({ name: 'alerts', minimumLevel: 'critical', write: pageSomeone });
master.requestLogging = 'scopeOnly';   // keep correlation, drop the per-request access line; false disables both
```

Entries are plain objects: `{ timestamp, level, category, message, properties?, error? { name, message, stack, code }, scope? }` plus enrichment. A throwing provider never breaks a request.
