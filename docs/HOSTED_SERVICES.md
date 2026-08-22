# Hosted services, background work & host lifetime (v2.6.0)

ASP.NET Core's generic host for MasterController: hosted services start with the app and stop in reverse on shutdown, `BackgroundService` for long-running loops, a `PeriodicTimer`-style service with a DI scope per run, a background task queue, `IHostApplicationLifetime` events and graceful SIGTERM/SIGINT handling.

| ASP.NET Core | MasterController |
|---|---|
| `services.AddHostedService<T>()` | `master.addHostedService(Class \| instance, { name })` |
| `IHostedService.StartAsync/StopAsync` | `start(signal)` / `stop()` — started in registration order at `master.start()`, stopped in **reverse** |
| `BackgroundService.ExecuteAsync(token)` | `class Worker extends BackgroundService { async executeAsync(signal) {…} }` |
| `BackgroundServiceExceptionBehavior.StopHost` | default — an unhandled exception stops the host; `this.exceptionBehavior = 'ignore'` to opt out |
| `PeriodicTimer` loop + `CreateScope()` per run | `master.addPeriodicService('cleanup', 60_000, async (scope, signal) => { await scope.db.… })` |
| `IBackgroundTaskQueue` + queued hosted service | `await master.backgroundQueue.enqueue(async (scope, signal) => …)` (`master.backgroundQueueConcurrency`) |
| `IHostApplicationLifetime` | `master.lifetime.onStarted / onStopping / onStopped`, `lifetime.stoppingSignal`, `lifetime.isStopping` |
| `HostOptions.ShutdownTimeout` (30 s) | `master.shutdownTimeoutMs` |
| `IHost.StopAsync` / SIGTERM | `await master.stop()`; `master.useGracefulShutdown()` installs SIGTERM/SIGINT → stop → exit |

```js
import master, { BackgroundService } from 'mastercontroller';

class OutboxDispatcher extends BackgroundService {
  async executeAsync(signal) {
    while (!signal.aborted) {
      await this.useScope(async (scope) => {                 // scoped MasterRecord context per batch (like EF's DbContext)
        const batch = await scope.db.Outbox.where('o => o.sentAt == $$', null).take(50).toList();
        for (const msg of batch) { await send(msg); msg.sentAt = new Date().toISOString(); }
        await scope.db.saveChanges();
      });
      await this.delay(2000, signal);                          // wakes immediately on shutdown
    }
  }
}

const server = master.setupServer('http');
master.addScoped('db', AppContext);
master.addHostedService(OutboxDispatcher);
master.addPeriodicService('session-cleanup', 15 * 60_000, async (scope) => { await scope.db.Session.where('s => s.expiresAt < $$', Date.now()).executeDelete(); }, { runOnStart: true });
master.lifetime.onStopping(() => console.log('draining…'));
master.useGracefulShutdown();                                  // SIGTERM/SIGINT -> master.stop() -> exit 0

await master.start(server);                                    // options validated, hosted services started (a failing start aborts the boot)
server.listen(3001);                                           // ApplicationStarted fires when listening

// anywhere in a request:
await master.backgroundQueue.enqueue(async (scope) => { await scope.mailer.sendWelcome(userId); });
```

## Shutdown sequence

`master.stop()` (or SIGTERM with `useGracefulShutdown()`): `onStopping` handlers → `lifetime.stoppingSignal` aborts → `server.close()` (stop accepting; idle keep-alives closed) → hosted services `stop()` in reverse order, each bounded by the remaining `shutdownTimeoutMs` → `onStopped`. `stop()` is idempotent.

## Semantics worth knowing

- `start()` of a `BackgroundService` **does not await** `executeAsync` (ASP.NET behavior): the host keeps booting; honor `signal` to stop promptly.
- `PeriodicTimerService` logs a failing tick and keeps ticking (`exceptionBehavior: 'stopHost'` to fail the host instead); `runOnStart`, `jitterMs`.
- Queue jobs get their own DI scope; `enqueue()` resolves with the job's result / rejects with its error; a failing job never stops the host.
- A hosted service added after `start()` is started immediately.
