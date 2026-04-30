/**
 * Regression test: MasterActionFilters methods must work when mixed onto a
 * user controller via MasterControl.extendController() — which copies the
 * prototype methods but NOT the constructor's instance fields.
 *
 * Bug it guards against:
 *   user-controller calls this.beforeAction(...) →
 *   "TypeError: Cannot read properties of undefined (reading 'push')"
 *   because this._beforeActionFilters was never initialized on the user's
 *   controller instance.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import MasterActionFilters from '../MasterActionFilters.js';

// Bind a stub master so the static __masterCache check passes.
MasterActionFilters.bindMaster({ /* stub */ });

/**
 * Simulate what MasterControl.extendController does: copy prototype methods
 * (NOT instance fields) onto a fresh user controller object.
 */
function mixFiltersInto(target) {
    const tmp = new MasterActionFilters();
    for (const propName of Object.getOwnPropertyNames(Object.getPrototypeOf(tmp))) {
        if (propName === 'constructor') continue;
        target[propName] = tmp[propName];
    }
    return target;
}

test('beforeAction works on a controller created without calling MasterActionFilters constructor', () => {
    const userController = mixFiltersInto({ __namespace: 'users' });
    // Pre-fix: this would throw "Cannot read properties of undefined (reading 'push')".
    assert.doesNotThrow(() => {
        userController.beforeAction('index', function () {});
    });
    // And the filter must actually be registered on the right instance.
    assert.equal(userController._getFilterCount('before'), 1, 'filter registered on userController');
});

test('afterAction works on a controller without constructor init', () => {
    const userController = mixFiltersInto({ __namespace: 'users' });
    assert.doesNotThrow(() => {
        userController.afterAction('show', function () {});
    });
    assert.equal(userController._getFilterCount('after'), 1);
});

test('Two user controllers do not share filter arrays', () => {
    const a = mixFiltersInto({ __namespace: 'a' });
    const b = mixFiltersInto({ __namespace: 'b' });
    a.beforeAction('index', function () {});
    assert.equal(a._getFilterCount('before'), 1);
    assert.equal(b._getFilterCount('before'), 0, 'b must not see a filter registered on a');
});

test('clearFilters works without prior init', () => {
    const c = mixFiltersInto({ __namespace: 'c' });
    assert.doesNotThrow(() => c.clearFilters());
});

test('hasFilter works without prior init', () => {
    const c = mixFiltersInto({ __namespace: 'c' });
    assert.doesNotThrow(() => c.hasFilter('before', 'index'));
    assert.equal(c.hasFilter('before', 'index'), false);
});

test('removeBeforeAction works without prior init', () => {
    const c = mixFiltersInto({ __namespace: 'c' });
    assert.doesNotThrow(() => c.removeBeforeAction('index', () => {}));
});

test('getRegisteredFilters works without prior init', () => {
    const c = mixFiltersInto({ __namespace: 'c' });
    let result;
    assert.doesNotThrow(() => { result = c.getRegisteredFilters(); });
    assert.deepEqual(result.before, []);
    assert.deepEqual(result.after, []);
});

test('Filter arrays survive subsequent registrations', () => {
    const c = mixFiltersInto({ __namespace: 'c' });
    c.beforeAction('a', function () {}, { name: 'first' });
    c.beforeAction('b', function () {}, { name: 'second' });
    assert.equal(c._getFilterCount('before'), 2);
});

test('Constructor-instantiated controllers still work (no regression)', () => {
    class FullController extends MasterActionFilters {
        constructor() {
            super();
            this.__namespace = 'full';
        }
    }
    const f = new FullController();
    f.beforeAction('idx', function () {});
    assert.equal(f._getFilterCount('before'), 1);
});
