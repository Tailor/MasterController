// 2.11.1 — scoped services stay lazy across the request pipeline: a request that
// never touches `this.db` must not construct it (ASP.NET Core scoped-DI semantics),
// and a request that does gets exactly one instance per scope.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import master from '../MasterControl.js';

process.env.MC_DISABLE_DEFAULT_LOG_PROVIDER = '1';

let client;
after(() => client && client.close());

test('scoped services are constructed on first use only (not during request-context merging)', async () => {
  let constructed = 0;
  class FakeDb { constructor() { constructed++; this.id = constructed; } }

  client = await master.createTestClient({
    app: 'app',
    environment: 'test',
    configure: (m) => {
      m.addScoped('db', FakeDb);
      m.map.get('/ping', function () { this.ok({ pong: true }); });
      m.map.get('/use', function () { const a = this.db; const b = this.db; this.ok({ same: a === b, id: a.id }); });
    },
  });

  const r1 = await client.get('/ping');
  assert.equal(r1.status, 200);
  assert.equal(constructed, 0, 'a request that never touches this.db must not build it');

  const r2 = await client.get('/use');
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.json(), { same: true, id: 1 });
  assert.equal(constructed, 1, 'one instance per request scope');

  await client.get('/use');
  assert.equal(constructed, 2, 'a new request gets a new instance');
});
