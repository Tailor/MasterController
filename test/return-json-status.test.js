// Tests for returnJson() HTTP-status resolution.
//
// Prior behavior (through 2.1.1) silently promoted a numeric `data.status`
// in the payload between 400-599 to the HTTP status code, AND silently
// discarded `response.statusCode` set by the controller. That's a design
// footgun — an app whose payload has a legitimate `status` field
// (workflow state, health report, etc.) that happens to fall in the
// 400-599 range would silently corrupt its own HTTP responses.

import test from 'node:test';
import assert from 'node:assert/strict';
import MasterAction from '../MasterAction.js';

function fakeResponse() {
    return {
        statusCode: 200,
        _headerSent: false,
        headersSent: false,
        writtenHead: null,
        endBody: null,
        writeHead(code, headers) {
            this.writtenHead = { code, headers };
            this.statusCode = code;
        },
        end(body) {
            this.endBody = body;
            this._ended = true;
        }
    };
}

// Helper: create a bare instance with a synthetic response wired up.
function inst() {
    const controller = Object.create(MasterAction.prototype);
    controller.__response = fakeResponse();
    return controller;
}

test('returnJson defaults to 200 for normal payloads', () => {
    const c = inst();
    c.returnJson({ ok: true, data: [] });
    assert.equal(c.__response.writtenHead.code, 200);
});

test('returnJson does NOT treat a benign `status` string as HTTP status', () => {
    const c = inst();
    c.returnJson({ status: 'ok', message: 'hello' });
    assert.equal(c.__response.writtenHead.code, 200,
        'a non-numeric status field must not be misread as an HTTP code');
});

test('returnJson honors this.__response.statusCode when set to non-200', () => {
    const c = inst();
    c.__response.statusCode = 404;
    c.returnJson({ error: 'not found' });
    assert.equal(c.__response.writtenHead.code, 404,
        'controller-set statusCode must win over the default 200');
});

test('returnJson opts.status overrides everything else', () => {
    const c = inst();
    c.__response.statusCode = 500;
    c.returnJson({ hint: 'ignored' }, { status: 401 });
    assert.equal(c.__response.writtenHead.code, 401,
        'explicit opts.status is highest priority');
});

test('returnJsonStatus() sets an explicit HTTP status', () => {
    const c = inst();
    c.returnJsonStatus(401, { error: 'Invalid credentials' });
    assert.equal(c.__response.writtenHead.code, 401);
    // Payload was preserved as-is.
    const parsed = JSON.parse(c.__response.endBody);
    assert.deepEqual(parsed, { error: 'Invalid credentials' });
});

test('returnJsonStatus rejects out-of-range status codes', () => {
    const c = inst();
    assert.throws(() => c.returnJsonStatus(999, {}), /100..599/);
    assert.throws(() => c.returnJsonStatus('401', {}), /number/);
});

test('legacy data.status magic still works but is deprecated', () => {
    const c = inst();
    // Clear the one-shot warn gate so this test can observe the WARN fires.
    MasterAction._statusMagicWarned.clear();
    c.returnJson({ status: 500, message: 'boom' });
    // Backward-compat: the magic still promotes to HTTP 500.
    assert.equal(c.__response.writtenHead.code, 500,
        'deprecated data.status magic still honored for backward compat');
});

test('a numeric business-domain `status` (e.g. 500 as a job state) does NOT corrupt HTTP', () => {
    // The failure mode the design critique flagged: a resource whose
    // payload carries `status: 500` as a domain code (job status,
    // workflow state, enum value) currently returns HTTP 500 by mistake.
    //
    // The recommended fix is to migrate such consumers to returnJsonStatus
    // or opts.status. We assert that once the caller has explicitly opted
    // to 200 via opts.status, a numeric domain status in the body doesn't
    // sneak the HTTP code back to 500.
    const c = inst();
    c.returnJson({ status: 500, jobName: 'nightly-etl' }, { status: 200 });
    assert.equal(c.__response.writtenHead.code, 200,
        'opts.status:200 must override the deprecated payload-status magic');
});
