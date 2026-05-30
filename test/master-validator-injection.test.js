/**
 * Regression tests for MasterValidator injection detection.
 *
 * These lock in three fixes:
 *  1. `_safeRegexTest` was INVERTED — it returned `true` on a pattern match
 *     (malicious), but its contract / every caller treat `true` as "safe".
 *     Result: detectors failed OPEN (malicious input reported `{safe:true}`)
 *     and false-positived on benign input. Fixed to `return !result`.
 *  2. The shared patterns use the /g flag, so `.test()` was stateful across
 *     calls (lastIndex). Fixed by resetting lastIndex before each test, so a
 *     malicious input is detected deterministically on repeated calls.
 *  3. `_safeRegexTest` ran the regex twice (a dead Promise block + the
 *     synchronous path); the dead block was removed.
 *
 * Before the fix every "malicious → safe:false" assertion below failed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    detectSQLInjection,
    detectPathTraversal,
    detectCommandInjection,
} from '../security/MasterValidator.js';

test('detectSQLInjection flags malicious input and clears benign', () => {
    for (const bad of ["' OR 1=1--", 'SELECT * FROM users', '1; DROP TABLE x']) {
        assert.equal(detectSQLInjection(bad).safe, false, `should flag: ${bad}`);
    }
    for (const ok of ['alice', 'product-123', 'hello world']) {
        assert.equal(detectSQLInjection(ok).safe, true, `should pass: ${ok}`);
    }
});

test('detectPathTraversal flags traversal and clears benign', () => {
    for (const bad of ['../../etc/passwd', '..%2f..%2fboot', 'a/../../b']) {
        assert.equal(detectPathTraversal(bad).safe, false, `should flag: ${bad}`);
    }
    for (const ok of ['index.html', 'images/logo.png', 'docs_v2']) {
        assert.equal(detectPathTraversal(ok).safe, true, `should pass: ${ok}`);
    }
});

test('detectCommandInjection flags shell metacharacters and clears benign', () => {
    for (const bad of ['a; rm -rf /', 'x && whoami', 'foo | cat', '`id`', '$(whoami)']) {
        assert.equal(detectCommandInjection(bad).safe, false, `should flag: ${bad}`);
    }
    for (const ok of ['filename.txt', 'some-value', 'hello world']) {
        assert.equal(detectCommandInjection(ok).safe, true, `should pass: ${ok}`);
    }
});

test('detection is deterministic across repeated calls (no /g lastIndex drift)', () => {
    // Same malicious input must be flagged every time — the bug made the
    // second call miss because the shared /g regex kept a stale lastIndex.
    for (let i = 0; i < 5; i++) {
        assert.equal(detectPathTraversal('../secret').safe, false, `iteration ${i}`);
        assert.equal(detectCommandInjection('a;b').safe, false, `iteration ${i}`);
    }
});
