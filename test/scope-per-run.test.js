/**
 * createScope() / useScope() — the framework equivalent of ASP.NET Core's
 * IServiceScopeFactory.CreateScope(), for using scoped services/contexts outside
 * the request pipeline (background timers, jobs, CLI). A job builds a scope per
 * run and disposes it after, so a scoped context is never shared across runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MasterControl } from '../MasterControl.js';

test('createScope: lazy, scope-injected, cached, and disposes what it built', async () => {
    const m = new MasterControl();

    let built = 0;
    const closed = [];
    class Ctx {
        constructor(scope) { built++; this.scope = scope; this.__id = built; }
        async close() { closed.push(this.__id); }
    }
    m.addScoped('db', Ctx);

    // A singleton must NOT be disposed by scope.dispose().
    let singletonClosed = false;
    m.requestList.appCache = { close() { singletonClosed = true; } };

    const scope = m.createScope();
    assert.equal(built, 0, 'lazy: nothing constructed until accessed');

    const db1 = scope.db;                       // first access constructs
    assert.equal(built, 1);
    assert.equal(db1.scope, scope, 'scope injected into the constructor');
    const db2 = scope.db;                        // cached within the scope
    assert.equal(db2, db1, 'scoped singleton — same instance within the scope');
    assert.equal(built, 1);

    assert.equal(scope.appCache, m.requestList.appCache, 'app singletons are visible via the scope');

    await scope.dispose();
    assert.deepEqual(closed, [1], 'dispose() closed the scoped context it built');
    assert.equal(singletonClosed, false, 'dispose() left the app singleton alone');
});

test('useScope disposes the scope even when the body throws', async () => {
    const m = new MasterControl();
    let closed = 0;
    class Ctx { async close() { closed++; } }
    m.addScoped('db', Ctx);

    await assert.rejects(() => m.useScope(async (scope) => {
        void scope.db;                          // construct it
        throw new Error('boom');
    }), /boom/);
    assert.equal(closed, 1, 'the scoped context was closed despite the error');

    // Happy path returns the body's value and disposes.
    let closed2 = 0;
    class Ctx2 { async close() { closed2++; } get val() { return 42; } }
    m.addScoped('db2', Ctx2);
    const result = await m.useScope(async (scope) => scope.db2.val);
    assert.equal(result, 42, 'useScope returns the body result');
    assert.equal(closed2, 1, 'and disposes after');
});

test('an untouched scoped service is never constructed', async () => {
    const m = new MasterControl();
    class Boom { constructor() { throw new Error('should not construct'); } }
    m.addScoped('never', Boom);
    const scope = m.createScope();
    await assert.doesNotReject(() => scope.dispose());   // never touched -> never built
});
