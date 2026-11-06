// A repeated object is written in full; only a value inside itself becomes the marker.
//
// Through 2.12.0 both writers remembered every object they had written, so an object that
// appeared twice in a response arrived once as itself and once as "[Circular Reference]".

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import masterSingleton from '../MasterControl.js';
import MasterAction from '../MasterAction.js';
import { stringifyResponse, CIRCULAR_MARKER } from '../MasterJson.js';

const write = (value) => JSON.parse(stringifyResponse(value));

/** A value with everything the old writer got wrong, and a real cycle beside it. */
function payload() {
    const tag = { name: 'urgent' }, list = [{ number: 7 }];
    const loop = { name: 'loop' };
    loop.self = loop;
    return { first: { tag, list }, second: { tag, list }, loop };
}
const WANT = {
    first: { tag: { name: 'urgent' }, list: [{ number: 7 }] },
    second: { tag: { name: 'urgent' }, list: [{ number: 7 }] },
    loop: { name: 'loop', self: CIRCULAR_MARKER },
};

test('one object in many places is written in full each time', () => {
    const tag = { name: 'urgent' };
    assert.deepEqual(write({ a: tag, b: [tag, tag], c: { d: tag } }), { a: tag, b: [tag, tag], c: { d: tag } });
    const list = [{ number: 7 }];
    assert.deepEqual(write([{ prs: list }, { prs: list }]), [{ prs: list }, { prs: list }]);
    const parent = { record: { rate: 1 } };
    assert.deepEqual(write({ parent, rate: parent.record }), { parent: { record: { rate: 1 } }, rate: { rate: 1 } });
});

test('a value inside itself becomes the marker, at any depth', () => {
    const self = { name: 's' };
    self.me = self;
    assert.deepEqual(write(self), { name: 's', me: CIRCULAR_MARKER });

    const deep = { a: { b: { c: {} } } };
    deep.a.b.c.back = deep.a;
    assert.deepEqual(write(deep), { a: { b: { c: { back: CIRCULAR_MARKER } } } });

    const array = [1];
    array.push({ array });
    assert.deepEqual(write(array), [1, { array: CIRCULAR_MARKER }]);
});

test('objects that hold each other are written once from each side, then stop', () => {
    const a = { name: 'a' }, b = { name: 'b', a };
    a.b = b;
    assert.deepEqual(write({ first: a, second: b }), {
        first: { name: 'a', b: { name: 'b', a: CIRCULAR_MARKER } },
        second: { name: 'b', a: { name: 'a', b: CIRCULAR_MARKER } },
    });
});

test('toJSON, dates and values with no JSON behave as JSON.stringify does', () => {
    class Row { toJSON() { return { kind: 'row', nested: { n: 1 } }; } }
    const row = new Row(), at = new Date(0);
    assert.deepEqual(write({ x: row, y: row, at, again: at }), { x: { kind: 'row', nested: { n: 1 } }, y: { kind: 'row', nested: { n: 1 } }, at: at.toISOString(), again: at.toISOString() });
    assert.equal(stringifyResponse({ a: null, b: undefined, c: 'x', d: 0 }), '{"a":null,"c":"x","d":0}');
    assert.equal(stringifyResponse(undefined), undefined);
    assert.equal(stringifyResponse('text'), '"text"');
});

test('a value with no repeats is byte for byte what JSON.stringify writes', () => {
    const value = { a: [1, { b: 'x' }, [2, [3]]], c: { d: null, e: true }, f: 'y' };
    assert.equal(stringifyResponse(value), JSON.stringify(value));
});

test('returnJson and returnJsonStatus send the repeats, and a cycle, as a 200 and a chosen status', () => {
    const fake = () => ({ statusCode: 200, _headerSent: false, headersSent: false, writeHead(code) { this.code = code; }, end(body) { this.body = body; } });
    const controller = Object.create(MasterAction.prototype);
    controller.__response = fake();
    controller.returnJson(payload());
    assert.equal(controller.__response.code, 200);
    assert.deepEqual(JSON.parse(controller.__response.body), WANT);

    controller.__response = fake();
    controller.returnJsonStatus(202, payload());
    assert.equal(controller.__response.code, 202);
    assert.deepEqual(JSON.parse(controller.__response.body), WANT);
});

let client;
after(() => client && client.close());

test('through the router: a returnJson action and a returned value', async () => {
    process.env.MC_DISABLE_DEFAULT_LOG_PROVIDER = '1';
    masterSingleton.environmentType = 'development';
    client = await masterSingleton.createTestClient({
        app: false,
        configure: (m) => {
            m.map.get('/written', function () { this.returnJson(payload()); }, { allowAnonymous: true });
            m.map.get('/returned', function () { return payload(); }, { allowAnonymous: true });
        },
    });
    for (const route of ['/written', '/returned']) {
        const response = await client.get(route);
        assert.equal(response.status, 200, route);
        assert.deepEqual(response.json(), WANT, route);
    }
});
