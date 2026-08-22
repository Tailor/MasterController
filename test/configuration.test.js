/**
 * 2.5.0 — Configuration (IConfiguration layering, user secrets, env vars, command
 * line), Options pattern (IOptions<T>, ValidateOnStart, OnChange) and IHostEnvironment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigurationRoot, OptionsManager, hostEnvironment } from '../MasterConfiguration.js';
import { validate } from '../security/MasterModelBinding.js';
import { MasterControl } from '../MasterControl.js';

function makeRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-config-'));
    fs.mkdirSync(path.join(root, 'config', 'environments'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'appsettings.json'), JSON.stringify({ Smtp: { host: 'base', port: 25, from: 'noreply@x' }, ConnectionStrings: { Default: 'sqlite://base' }, Feature: { flags: ['a'] } }));
    fs.writeFileSync(path.join(root, 'config', 'appsettings.staging.json'), JSON.stringify({ Smtp: { port: 2525 } }));
    fs.writeFileSync(path.join(root, 'config', 'environments', 'env.staging.json'), JSON.stringify({ AppContext: { type: 'sqlite', connection: 'db/' } }));
    const secretsBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-secrets-'));
    process.env.MASTER_USER_SECRETS_PATH = secretsBase;
    fs.mkdirSync(path.join(secretsBase, 'my-app'), { recursive: true });
    fs.writeFileSync(path.join(secretsBase, 'my-app', 'secrets.json'), JSON.stringify({ Smtp: { password: 's3cret' } }));
    return root;
}

test('layering: appsettings < appsettings.{env} < env.{env} < user secrets < env vars < argv < set(); case-insensitive keys; sections; connection strings', () => {
    const root = makeRoot();
    process.env.Smtp__host = 'envhost';
    process.env.MYAPP_Smtp__from = 'prefixed@x';
    try {
        const cfg = new ConfigurationRoot({ root, environment: 'staging', userSecretsId: 'my-app', argv: ['--Smtp:port=99', '--Logging:Level', 'debug', '--Flag'] }).addDefaults().build();
        assert.equal(cfg.get('Smtp:port'), 99, 'command line wins');
        assert.equal(cfg.get('smtp:HOST'), 'envhost', 'env var (A__B) beats files; keys are case-insensitive');
        assert.equal(cfg.get('Smtp:password'), 's3cret', 'user secrets loaded from MASTER_USER_SECRETS_PATH/<id>/secrets.json');
        assert.equal(cfg.get('Smtp:from'), 'noreply@x', 'unprefixed reader ignores MYAPP_ vars');
        assert.equal(cfg.get('AppContext:type'), 'sqlite', 'env.{env}.json still participates');
        assert.equal(cfg.get('Logging:Level'), 'debug'); assert.equal(cfg.get('Flag'), true);
        assert.equal(cfg.getConnectionString('Default'), 'sqlite://base');
        assert.deepEqual(cfg.getSection('Smtp'), { host: 'envhost', port: 99, from: 'noreply@x', password: 's3cret' });
        assert.deepEqual(cfg.bind('Smtp', { port: 1, tls: true }), { port: 99, tls: true, host: 'envhost', from: 'noreply@x', password: 's3cret' });
        assert.equal(cfg.get('Nope:x', 'dflt'), 'dflt'); assert.equal(cfg.has('Feature:flags'), true);
        let changed = 0; cfg.onChange(() => changed++);
        cfg.set('Smtp:port', 1);
        assert.equal(cfg.get('Smtp:port'), 1, 'set() override wins over everything'); assert.equal(changed, 1);
        assert.ok(cfg.sources.some(s => s.kind === 'secrets') && cfg.sources.some(s => s.kind === 'env'));

        // env prefix filter strips the prefix and ignores other vars
        const pref = new ConfigurationRoot({ root, environment: 'staging' }).addEnvironmentVariables('MYAPP_').build();
        assert.equal(pref.get('Smtp:from'), 'prefixed@x'); assert.equal(pref.get('Smtp:host'), undefined);
        // custom sources + required file
        assert.throws(() => new ConfigurationRoot({ root }).addJsonFile('config/missing.json', { optional: false }).build(), /not found/);
        fs.writeFileSync(path.join(root, 'config', 'bad.json'), '{ nope');
        assert.throws(() => new ConfigurationRoot({ root }).addJsonFile('config/bad.json', { optional: false }).build(), /not valid JSON/);
        // reload picks up file edits
        fs.writeFileSync(path.join(root, 'config', 'appsettings.json'), JSON.stringify({ Smtp: { host: 'edited', port: 25 } }));
        const r = new ConfigurationRoot({ root, environment: 'production' }).addDefaults().build();
        assert.equal(r.get('Smtp:host'), 'envhost'); delete process.env.Smtp__host; r.reload(); assert.equal(r.get('Smtp:host'), 'edited');
    } finally { delete process.env.Smtp__host; delete process.env.MYAPP_Smtp__from; }
});

test('fromEnvironment / fromArgv shapes and coercion', () => {
    assert.deepEqual(ConfigurationRoot.fromEnvironment({ A__B__C: '1', PLAIN: 'x', F__G: 'true', H__I: 'hello' }), { A: { B: { C: 1 } }, F: { G: true }, H: { I: 'hello' } });
    assert.deepEqual(ConfigurationRoot.fromArgv(['--a:b=1', '--c__d', 'two', '--e', '--f=x=y']), { a: { b: 1 }, c: { d: 'two' }, e: true, f: 'x=y' });
});

test('Options pattern: configure/getAsync with schema + custom validate, frozen values, aggregate validateAll, onChange after set()', async () => {
    const root = makeRoot();
    const cfg = new ConfigurationRoot({ root, environment: 'staging', userSecretsId: 'my-app' }).addDefaults().build();
    const options = new OptionsManager(cfg, validate);
    options.configure('Smtp', { schema: { host: 'string!', port: { type: 'integer', min: 1, max: 65535 }, password: 'string' }, defaults: { tls: true } });
    const smtp = await options.getAsync('Smtp');
    assert.deepEqual(smtp, { host: 'base', port: 2525, from: 'noreply@x', password: 's3cret', tls: true });
    assert.ok(Object.isFrozen(smtp)); assert.equal(options.get('Smtp'), smtp, 'sync get after validation');
    assert.throws(() => options.get('Other'), /not configured/);

    options.configure('Broken', { section: 'Smtp', schema: { port: { type: 'integer', max: 100 } }, validate: (v) => (v.host === 'base' ? 'host must not be base' : null) });
    await assert.rejects(() => options.getAsync('Broken'), (e) => e.code === 'MC_OPTIONS_INVALID' && /port: port must be at most 100/.test(e.message) && /host must not be base/.test(e.message));
    await assert.rejects(() => options.validateAll(), /Options validation failed at startup/);
    options.configure('Broken', { section: 'Smtp', schema: { port: 'integer' } });
    const all = await options.validateAll(); assert.deepEqual(Object.keys(all).sort(), ['Broken', 'Smtp']);

    let seen = null; options.onChange('Smtp', (v) => { seen = v; });
    cfg.set('Smtp:port', 4000);
    await new Promise(r => setTimeout(r, 10));
    assert.equal(seen && seen.port, 4000, 'IOptionsMonitor.OnChange after configuration change');
    assert.equal(options.get('Smtp').port, 4000);
});

test('hostEnvironment + MasterControl integration: master.configuration / master.options / this.options; start() validates options (fail fast)', async () => {
    assert.equal(hostEnvironment('production').isProduction, true); assert.equal(hostEnvironment('development').isDevelopment, true); assert.equal(hostEnvironment('qa').is('qa'), true);
    const root = makeRoot();
    const m = new MasterControl();
    m.root = root; m.environmentType = 'staging'; m.userSecretsId = 'my-app';
    const server = m.setupServer('http');
    assert.equal(m.configuration.get('Smtp:port'), 2525); assert.equal(m.environment.name, 'staging'); assert.equal(m.configuration.get('Smtp:password'), 's3cret');
    m.options.configure('Smtp', { schema: { port: { type: 'integer', max: 10 } } });
    await assert.rejects(() => m.start(server), /Options validation failed at startup/);
    m.options.configure('Smtp', { schema: { port: 'integer' } });
    await m.start(server);
    assert.equal(m.options.get('Smtp').port, 2525);
    // late environment change is honored by start()
    const m2 = new MasterControl(); m2.root = root; const s2 = m2.setupServer('http'); m2.environmentType = 'staging';
    assert.equal(m2.configuration.get('Smtp:port'), 25, 'built for the default environment first');
    await m2.start(s2); assert.equal(m2.configuration.get('Smtp:port'), 2525, 'rebuilt for staging at start()');
    // custom sources replace the defaults
    m2.buildConfiguration({ sources: (c) => c.addInMemory({ Only: { me: 1 } }) });
    assert.equal(m2.configuration.get('Only:me'), 1); assert.equal(m2.configuration.get('Smtp:port'), undefined);
});
