# Configuration & Options (v2.5.0)

ASP.NET Core's `IConfiguration` / `IOptions<T>` / `IHostEnvironment` for MasterController. Built automatically in `master.setupServer()` from `master.root` + `master.environmentType`, rebuilt at `master.start()` if either changed.

## Sources and precedence (later wins)

| # | ASP.NET Core | MasterController |
|---|---|---|
| 1 | `appsettings.json` | `config/appsettings.json` |
| 2 | `appsettings.{Environment}.json` | `config/appsettings.{env}.json` |
| 3 | — | `config/environments/env.{env}.json` (existing MasterRecord/context config, unchanged) |
| 4 | user secrets (`dotnet user-secrets`, outside the repo) | `~/.master/usersecrets/<id>/secrets.json` — `master.userSecretsId = 'my-app'` or `MASTER_USER_SECRETS_ID`; base dir overridable with `MASTER_USER_SECRETS_PATH` |
| 5 | environment variables `Section__Key` | same (`__` → `:`); `master.configurationEnvPrefix = 'MYAPP_'` to read only prefixed vars |
| 6 | command line `--Section:Key=value` | same (`--a:b=1`, `--a:b 1`, `--flag`) |
| 7 | in-memory | `master.configuration.set('Section:Key', value)` |

Keys are **case-insensitive** and `:`-separated. Values from env/argv are coerced (`"true"` → `true`, `"42"` → `42`).

```js
master.root = __dirname; master.environmentType = process.env.NODE_ENV || 'development';
master.userSecretsId = 'my-app';                    // optional
const server = master.setupServer('http');

master.configuration.get('Smtp:host');              // IConfiguration["Smtp:Host"]
master.configuration.get('Smtp:port', 25);          // with default
master.configuration.getSection('Smtp');            // { host, port, ... }
master.configuration.getConnectionString('Default');// ConnectionStrings:Default
master.configuration.bind('Smtp', { tls: true });   // defaults + section
master.configuration.sources;                       // [{ name, kind, path }]
master.configuration.onChange((cfg, key) => …);     // reloads (fs.watch with master.configurationReloadOnChange = true) and set()
```

Replace the default layering: `master.buildConfiguration({ sources: (cfg) => cfg.addJsonFile('settings.json', { optional: false }).addEnvironmentVariables('MYAPP_').addCommandLine() })`. Other builders: `addUserSecrets(id)`, `addInMemory(obj)`.

## Options pattern (`IOptions<T>`, validated on start)

```js
master.options.configure('Smtp', {
  section: 'Smtp',                                  // defaults to the name
  defaults: { port: 25, tls: true },
  schema: { host: 'string!', port: { type: 'integer', min: 1, max: 65535 }, from: { type: 'email' } },   // same rules as model binding
  validate: (v) => (v.tls && v.port === 25 ? 'use port 587 with TLS' : null),                            // custom rule(s)
  postConfigure: (v) => ({ ...v, url: `smtp://${v.host}:${v.port}` }),
});

await master.start(server);      // ValidateOnStart: every configured options type is validated here — invalid config fails the boot

master.options.get('Smtp');      // frozen, validated value (sync after start)
await master.options.getAsync('Smtp');
master.options.onChange('Smtp', (value) => …);      // IOptionsMonitor.OnChange (after configuration reload / set)
```

Controllers receive `this.options` (all validated values), `this.configuration` and `this.environment` on every request:

```js
export default class MailController {
  async send() { const { host, port } = this.options.Smtp; /* … */ }
}
```

## Host environment

`master.environment` → `{ name, isDevelopment, isStaging, isProduction, isTest, is(name) }` (ASP.NET `IHostEnvironment`).

## Secrets workflow

Keep secrets out of the repo: `~/.master/usersecrets/<id>/secrets.json` in development (the Master CLI's `master secrets set Smtp:password …` writes it), real environment variables in production (`Smtp__password=…`). Both land on the same keys, so code only ever reads `master.configuration.get('Smtp:password')` / `this.options.Smtp.password`.
