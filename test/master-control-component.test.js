/**
 * Tests for MasterControl.component() and MasterControl._discoverComponent().
 *
 * These cover the v2.0.8 refactor that replaced the "log error on every
 * missing optional file" behavior with proper layout discovery. The previous
 * implementation fired MC_ERR_CONFIG_NOT_FOUND and MC_ERR_ROUTES_NOT_FOUND at
 * error severity for components that legitimately have neither — services-
 * only, models-only, sockets-only, etc.
 *
 * What we lock down here:
 *   - Discovery flags accurately reflect filesystem state
 *   - A real component (any recognized piece) loads with one INFO summary
 *   - A genuinely empty folder produces ONE warn and returns early
 *   - A non-existent folder throws (real config bug, not optional)
 *   - opts.silent suppresses the INFO summary line
 *   - Both absolute and relative `folderLocation` work
 *   - The returned discovery shape is stable (per-piece flags + paths)
 *
 * Style: scratch a fresh temp directory tree for each test so they're
 * order-independent and parallel-safe. No mocking of fs — we exercise the
 * real path the framework takes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import master, { MasterControl } from '../MasterControl.js';
import { logger } from '../error/MasterErrorLogger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a temp project root containing zero or more component folders with
 * arbitrary layout pieces. Returns the root path. Each test gets its own
 * isolated root.
 *
 * Layout descriptor example:
 *   {
 *     components: {
 *       full: { init: true, routes: true, controllers: ['widget'] },
 *       svconly: { services: ['notifier'] },
 *       empty: {}   // creates an empty dir
 *     }
 *   }
 */
function makeProject(layout = {}) {
    const id = crypto.randomBytes(6).toString('hex');
    const root = path.join(os.tmpdir(), `mc-component-test-${id}`);
    fs.mkdirSync(root, { recursive: true });

    for (const [parentName, components] of Object.entries(layout)) {
        const parentDir = path.join(root, parentName);
        fs.mkdirSync(parentDir, { recursive: true });

        for (const [compName, pieces] of Object.entries(components)) {
            const compDir = path.join(parentDir, compName);
            fs.mkdirSync(compDir, { recursive: true });

            if (pieces.init) {
                const initDir = path.join(compDir, 'config', 'initializers');
                fs.mkdirSync(initDir, { recursive: true });
                fs.writeFileSync(path.join(initDir, 'config.js'),
                    '// init stub\nexport default {};\n');
            }
            if (pieces.routes) {
                const cfgDir = path.join(compDir, 'config');
                fs.mkdirSync(cfgDir, { recursive: true });
                fs.writeFileSync(path.join(cfgDir, 'routes.js'),
                    '// routes stub\nexport default {};\n');
            }
            if (Array.isArray(pieces.controllers)) {
                const ctrlDir = path.join(compDir, 'app', 'controllers');
                fs.mkdirSync(ctrlDir, { recursive: true });
                for (const name of pieces.controllers) {
                    fs.writeFileSync(path.join(ctrlDir, `${name}Controller.js`),
                        `export default class ${name}Controller { constructor(c) { this._c = c; } }\n`);
                }
            }
            if (Array.isArray(pieces.services)) {
                const svcDir = path.join(compDir, 'app', 'services');
                fs.mkdirSync(svcDir, { recursive: true });
                for (const name of pieces.services) {
                    fs.writeFileSync(path.join(svcDir, `${name}.js`),
                        `export default class ${name} {}\n`);
                }
            }
            if (Array.isArray(pieces.models)) {
                const mdlDir = path.join(compDir, 'app', 'models');
                fs.mkdirSync(mdlDir, { recursive: true });
                for (const name of pieces.models) {
                    fs.writeFileSync(path.join(mdlDir, `${name}.js`),
                        `export default class ${name} {}\n`);
                }
            }
            if (Array.isArray(pieces.sockets)) {
                const sockDir = path.join(compDir, 'app', 'sockets');
                fs.mkdirSync(sockDir, { recursive: true });
                for (const name of pieces.sockets) {
                    fs.writeFileSync(path.join(sockDir, `${name}Socket.js`),
                        `export default class ${name}Socket {}\n`);
                }
            }
            // pieces.{} with no flags set → empty component directory
        }
    }

    return root;
}

/** Recursively remove a temp project root. */
function cleanup(root) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}

/**
 * Capture logger output during a test. Replaces the backends array, restores
 * it on cleanup. Returns the array of entries that were dispatched.
 */
function captureLogger() {
    const captured = [];
    const originalBackends = logger.backends.slice();
    logger.backends = [(entry) => { captured.push(entry); }];
    return {
        entries: captured,
        restore: () => { logger.backends = originalBackends; },
        byCode: (code) => captured.filter(e => e.code === code),
        byLevel: (lvl) => captured.filter(e => e.level === lvl)
    };
}

/**
 * Build a fresh MasterControl instance configured to load components from
 * the given root. We construct our own instead of using the singleton so
 * tests don't pollute each other's router state or trigger the global
 * setupServer side-effects.
 *
 * Note: we still need the router/pipeline/etc. attached, which only happens
 * inside setupServer(). For component() we only need router.setup() and
 * router.discoverControllers() to be defined — we substitute lightweight
 * stubs to avoid the full HTTP server lifecycle.
 */
function makeIsolatedMaster(root) {
    const m = new MasterControl();
    m.root = root;
    m.environmentType = 'development';
    // Stub the parts of router that component() touches. We aren't testing
    // the router here; we're testing that component() calls these correctly
    // and only when the relevant pieces are present.
    m.router = {
        setupCalls: [],
        discoverCalls: [],
        setup(scope) { this.setupCalls.push(scope); },
        async discoverControllers(p) { this.discoverCalls.push(p); }
    };
    return m;
}

// ---------------------------------------------------------------------------
// _discoverComponent — flag accuracy
// ---------------------------------------------------------------------------

test('_discoverComponent: full layout reports all pieces present', () => {
    const root = makeProject({
        components: {
            full: {
                init: true,
                routes: true,
                controllers: ['widget'],
                services: ['notifier'],
                models: ['Widget'],
                sockets: ['chat']
            }
        }
    });
    try {
        const m = makeIsolatedMaster(root);
        const d = m._discoverComponent(path.join(root, 'components', 'full'));
        assert.equal(d.isEmpty, false);
        assert.deepEqual(d.has, {
            init: true, routes: true, controllers: true,
            services: true, models: true, sockets: true
        });
        assert.equal(d.hasInit, true);
        assert.equal(d.hasRoutes, true);
        assert.equal(d.hasControllers, true);
        assert.equal(d.hasServices, true);
        assert.equal(d.hasModels, true);
        assert.equal(d.hasSockets, true);
        // Paths are absolute and reachable.
        assert.equal(fs.existsSync(d.initPath), true);
        assert.equal(fs.existsSync(d.routesPath), true);
        assert.equal(fs.existsSync(d.controllersPath), true);
    } finally { cleanup(root); }
});

test('_discoverComponent: services-only component is NOT empty (regression for 2.0.7)', () => {
    // This is the case the user hit: ~10 components with only services, no
    // init or routes. The pre-fix code logged MC_ERR_CONFIG_NOT_FOUND for
    // each. With the new discovery shape, services alone should be enough
    // to mark the component as non-empty.
    const root = makeProject({
        components: { svconly: { services: ['notifier', 'mailer'] } }
    });
    try {
        const m = makeIsolatedMaster(root);
        const d = m._discoverComponent(path.join(root, 'components', 'svconly'));
        assert.equal(d.isEmpty, false);
        assert.equal(d.hasServices, true);
        assert.equal(d.hasInit, false);
        assert.equal(d.hasRoutes, false);
        assert.equal(d.hasControllers, false);
    } finally { cleanup(root); }
});

test('_discoverComponent: controllers-only component is NOT empty', () => {
    const root = makeProject({
        components: { ctrlonly: { controllers: ['user'] } }
    });
    try {
        const m = makeIsolatedMaster(root);
        const d = m._discoverComponent(path.join(root, 'components', 'ctrlonly'));
        assert.equal(d.isEmpty, false);
        assert.equal(d.hasControllers, true);
    } finally { cleanup(root); }
});

test('_discoverComponent: completely empty folder reports isEmpty=true', () => {
    const root = makeProject({ components: { empty: {} } });
    try {
        const m = makeIsolatedMaster(root);
        const d = m._discoverComponent(path.join(root, 'components', 'empty'));
        assert.equal(d.isEmpty, true);
        // All flags should be false.
        for (const v of Object.values(d.has)) assert.equal(v, false);
    } finally { cleanup(root); }
});

test('_discoverComponent: folder with only random subdirs is empty (no framework pieces)', () => {
    // Sanity check: a folder containing irrelevant files/dirs but none of
    // the recognized framework layouts is still "empty" from the framework
    // POV. This guards against accidentally treating any subdirectory as
    // a framework piece.
    const root = makeProject({ components: { noise: {} } });
    fs.mkdirSync(path.join(root, 'components', 'noise', 'docs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'components', 'noise', 'misc'), { recursive: true });
    fs.writeFileSync(path.join(root, 'components', 'noise', 'README.md'), '# noise\n');
    try {
        const m = makeIsolatedMaster(root);
        const d = m._discoverComponent(path.join(root, 'components', 'noise'));
        assert.equal(d.isEmpty, true);
    } finally { cleanup(root); }
});

// ---------------------------------------------------------------------------
// component() — behavioral contracts
// ---------------------------------------------------------------------------

test('component(): services-only emits zero MC_ERR_* (regression for the user-reported bug)', async () => {
    const root = makeProject({
        components: { svconly: { services: ['notifier'] } }
    });
    const cap = captureLogger();
    try {
        const m = makeIsolatedMaster(root);
        const d = await m.component('components', 'svconly');

        assert.equal(d.isEmpty, false);
        assert.equal(d.hasServices, true);

        // The bug being fixed: previously fired
        // MC_ERR_CONFIG_NOT_FOUND and MC_ERR_ROUTES_NOT_FOUND. Now silent.
        assert.equal(cap.byCode('MC_ERR_CONFIG_NOT_FOUND').length, 0);
        assert.equal(cap.byCode('MC_ERR_ROUTES_NOT_FOUND').length, 0);
        // And no DEBUG-level pseudo-errors either.
        assert.equal(cap.byCode('MC_DEBUG_COMPONENT_CONFIG_NONE').length, 0);
        assert.equal(cap.byCode('MC_DEBUG_COMPONENT_ROUTES_NONE').length, 0);
        // Should produce exactly one summary INFO line.
        const summary = cap.byCode('MC_INFO_COMPONENT_LOADED');
        assert.equal(summary.length, 1);
        assert.equal(summary[0].level, 'INFO');
        // Structured data is nested in context (logger only serializes a fixed
        // set of top-level fields; arbitrary fields would be silently dropped).
        assert.equal(summary[0].context.has.services, true);
        assert.equal(summary[0].context.has.init, false);
        assert.equal(summary[0].context.has.routes, false);
    } finally {
        cap.restore();
        cleanup(root);
    }
});

test('component(): full layout calls router.setup AND discoverControllers', async () => {
    const root = makeProject({
        components: { full: { init: true, routes: true, controllers: ['a'] } }
    });
    const cap = captureLogger();
    try {
        const m = makeIsolatedMaster(root);
        await m.component('components', 'full');
        assert.equal(m.router.setupCalls.length, 1);
        assert.equal(m.router.setupCalls[0].isComponent, true);
        assert.match(m.router.setupCalls[0].root, /components\/full$/);
        assert.equal(m.router.discoverCalls.length, 1);
    } finally {
        cap.restore();
        cleanup(root);
    }
});

test('component(): controllers-only DOES call discoverControllers, services-only does NOT', async () => {
    const root = makeProject({
        components: {
            ctrlonly: { controllers: ['x'] },
            svconly:  { services: ['y'] }
        }
    });
    const cap = captureLogger();
    try {
        const m = makeIsolatedMaster(root);
        await m.component('components', 'ctrlonly');
        await m.component('components', 'svconly');

        // discoverControllers should fire exactly once — for ctrlonly.
        assert.equal(m.router.discoverCalls.length, 1);
        assert.match(m.router.discoverCalls[0], /ctrlonly$/);
    } finally {
        cap.restore();
        cleanup(root);
    }
});

test('component(): empty folder emits MC_WARN_COMPONENT_EMPTY and skips router.setup', async () => {
    const root = makeProject({ components: { empty: {} } });
    const cap = captureLogger();
    try {
        const m = makeIsolatedMaster(root);
        const d = await m.component('components', 'empty');
        assert.equal(d.isEmpty, true);

        const warns = cap.byCode('MC_WARN_COMPONENT_EMPTY');
        assert.equal(warns.length, 1);
        assert.equal(warns[0].level, 'WARN');
        assert.equal(warns[0].component, 'empty');

        // Should NOT set up route scope for an empty component.
        assert.equal(m.router.setupCalls.length, 0);
        assert.equal(m.router.discoverCalls.length, 0);
        // Should NOT emit a misleading INFO_LOADED for something that
        // didn't actually load anything.
        assert.equal(cap.byCode('MC_INFO_COMPONENT_LOADED').length, 0);
    } finally {
        cap.restore();
        cleanup(root);
    }
});

test('component(): missing folder throws MC_ERR_COMPONENT_FOLDER_MISSING', async () => {
    const root = makeProject({ components: {} }); // 'components' parent exists but no children
    const cap = captureLogger();
    try {
        const m = makeIsolatedMaster(root);
        await assert.rejects(
            () => m.component('components', 'doesnotexist'),
            (err) => {
                assert.equal(err.code, 'MC_ERR_COMPONENT_FOLDER_MISSING');
                assert.match(err.message, /doesnotexist/);
                return true;
            }
        );
        // Error is also logged for ops visibility.
        const errors = cap.byCode('MC_ERR_COMPONENT_FOLDER_MISSING');
        assert.equal(errors.length, 1);
        assert.equal(errors[0].component, 'doesnotexist');
    } finally {
        cap.restore();
        cleanup(root);
    }
});

test('component(): opts.silent suppresses the INFO summary line', async () => {
    const root = makeProject({
        components: { svconly: { services: ['notifier'] } }
    });
    const cap = captureLogger();
    try {
        const m = makeIsolatedMaster(root);
        await m.component('components', 'svconly', { silent: true });
        assert.equal(cap.byCode('MC_INFO_COMPONENT_LOADED').length, 0);
    } finally {
        cap.restore();
        cleanup(root);
    }
});

test('component(): absolute folderLocation is honored (not joined with master.root)', async () => {
    const externalRoot = makeProject({
        external: { mything: { services: ['x'] } }
    });
    const projectRoot = makeProject({}); // empty project root
    const cap = captureLogger();
    try {
        const m = makeIsolatedMaster(projectRoot);
        const d = await m.component(path.join(externalRoot, 'external'), 'mything');
        assert.equal(d.isEmpty, false);
        assert.equal(d.hasServices, true);
        // The resolved root should be under externalRoot, NOT projectRoot.
        assert.ok(d.root.startsWith(externalRoot), `expected ${d.root} to start with ${externalRoot}`);
    } finally {
        cap.restore();
        cleanup(externalRoot);
        cleanup(projectRoot);
    }
});

test('component(): the summary INFO entry contains the per-piece `has` map for tooling', async () => {
    const root = makeProject({
        components: { mix: { routes: true, services: ['a'], models: ['B'] } }
    });
    const cap = captureLogger();
    try {
        const m = makeIsolatedMaster(root);
        await m.component('components', 'mix');
        const summary = cap.byCode('MC_INFO_COMPONENT_LOADED');
        assert.equal(summary.length, 1);
        // Tooling can rely on this shape to introspect what got loaded.
        // Nested in context per the logger's serialization contract.
        assert.equal(summary[0].context.has.init, false);
        assert.equal(summary[0].context.has.routes, true);
        assert.equal(summary[0].context.has.controllers, false);
        assert.equal(summary[0].context.has.services, true);
        assert.equal(summary[0].context.has.models, true);
        assert.equal(summary[0].context.has.sockets, false);
    } finally {
        cap.restore();
        cleanup(root);
    }
});

test('component(): repeated calls on different components are independent (no shared state)', async () => {
    const root = makeProject({
        components: {
            a: { services: ['x'] },
            b: { controllers: ['y'] },
            c: {} // empty
        }
    });
    const cap = captureLogger();
    try {
        const m = makeIsolatedMaster(root);
        const da = await m.component('components', 'a');
        const db = await m.component('components', 'b');
        const dc = await m.component('components', 'c');

        assert.equal(da.hasServices, true);
        assert.equal(db.hasControllers, true);
        assert.equal(dc.isEmpty, true);

        // Two INFOs (a and b loaded), one WARN (c is empty), zero ERRORs.
        assert.equal(cap.byCode('MC_INFO_COMPONENT_LOADED').length, 2);
        assert.equal(cap.byCode('MC_WARN_COMPONENT_EMPTY').length, 1);
        assert.equal(cap.byLevel('ERROR').length, 0);
    } finally {
        cap.restore();
        cleanup(root);
    }
});
