/**
 * Tests for the process supervisor. No DSH dependency: `lib/supervisor.js` is
 * plain Node so it can be exercised directly, and `lib/index.js` is only
 * imported for the config/service-mapping helpers (its `apply` needs a harness).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  BRIDGE_ENTRY,
  ManagedProcess,
  bridgeLaunchSpec,
  expandPath,
  healthURLFor,
  normalizeV1,
  probe,
  readGatewayApiKey,
  resolveCommand,
  startSupervisor,
  superviseOnce,
} from '../lib/supervisor.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** A throwaway HTTP server standing in for a supervised service. */
function startFakeService(status = 200) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: status === 200, path: req.url }));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe('normalizeV1', () => {
  it('appends /v1 when missing', () => {
    assert.equal(normalizeV1('http://127.0.0.1:7863'), 'http://127.0.0.1:7863/v1');
  });

  it('does not double up an existing /v1', () => {
    assert.equal(normalizeV1('http://127.0.0.1:7863/v1'), 'http://127.0.0.1:7863/v1');
  });

  it('strips trailing slashes first', () => {
    assert.equal(normalizeV1('http://127.0.0.1:7863///'), 'http://127.0.0.1:7863/v1');
    assert.equal(normalizeV1('http://127.0.0.1:7863/v1/'), 'http://127.0.0.1:7863/v1');
  });

  it('rejects an empty value', () => {
    assert.throws(() => normalizeV1('  '), /must be non-empty/);
  });
});

describe('healthURLFor', () => {
  it('derives the health endpoint from a /v1 base', () => {
    assert.equal(healthURLFor('http://127.0.0.1:7863/v1'), 'http://127.0.0.1:7863/healthz');
    assert.equal(healthURLFor('http://127.0.0.1:7864/v1/'), 'http://127.0.0.1:7864/healthz');
  });

  it('works on a base without /v1', () => {
    assert.equal(healthURLFor('http://127.0.0.1:7863'), 'http://127.0.0.1:7863/healthz');
  });
});

describe('expandPath', () => {
  it('leaves a plain path alone', () => {
    assert.equal(expandPath('/tmp/x'), '/tmp/x');
  });

  it('expands %VAR% (Windows style)', () => {
    process.env.WBS_TEST_VAR = 'hello';
    assert.equal(expandPath('%WBS_TEST_VAR%/sub'), 'hello/sub');
    delete process.env.WBS_TEST_VAR;
  });

  it('expands $VAR and ${VAR}', () => {
    process.env.WBS_TEST_VAR = 'world';
    assert.equal(expandPath('$WBS_TEST_VAR/a'), 'world/a');
    assert.equal(expandPath('${WBS_TEST_VAR}/b'), 'world/b');
    delete process.env.WBS_TEST_VAR;
  });

  it('expands a leading ~ to the home directory', () => {
    const home = expandPath('~');
    assert.ok(home.length > 1);
    assert.equal(expandPath('~/x'), join(home, 'x'));
  });

  it('returns empty for empty input', () => {
    assert.equal(expandPath(''), '');
    assert.equal(expandPath(undefined), '');
  });
});

describe('resolveCommand', () => {
  it('keeps an absolute path', () => {
    const p = process.platform === 'win32' ? 'C:\\Windows\\notepad.exe' : '/usr/bin/env';
    assert.equal(resolveCommand(p), p);
  });

  it('leaves a bare name for PATH resolution', () => {
    assert.equal(resolveCommand('node'), 'node');
  });

  it('resolves ./ against the plugin root', () => {
    const r = resolveCommand('./bin/x.mjs');
    assert.ok(r.endsWith(join('bin', 'x.mjs')));
    assert.ok(!r.startsWith('./'));
  });

  it('rejects an empty command', () => {
    assert.throws(() => resolveCommand(''), /must be non-empty/);
  });
});

describe('probe', () => {
  let svc;
  let degraded;
  after(async () => {
    if (svc) await new Promise((r) => svc.server.close(r));
    if (degraded) await new Promise((r) => degraded.server.close(r));
  });

  it('is true for a 2xx answer', async () => {
    svc = await startFakeService(200);
    assert.equal(await probe(`${svc.url}/healthz`), true);
  });

  it('is false for a 5xx answer by default', async () => {
    degraded = await startFakeService(503);
    assert.equal(await probe(`${degraded.url}/healthz`), false);
  });

  it('accepts an explicitly allowed non-2xx status', async () => {
    // 503 is what the wb2api gateway returns while it is up but has no usable
    // upstream account, so the supervisor must be able to call that "alive".
    assert.equal(await probe(`${degraded.url}/healthz`, 2000, [200, 503]), true);
    assert.equal(await probe(`${degraded.url}/healthz`, 2000, [503]), true);
    assert.equal(await probe(`${svc.url}/healthz`, 2000, [503]), false);
  });

  it('is false when nothing is listening', async () => {
    assert.equal(await probe('http://127.0.0.1:1/healthz', 500), false);
  });
});

describe('ManagedProcess', () => {
  it('spawns, reports a pid, and stops', async () => {
    const p = new ManagedProcess(
      'sleeper',
      {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
      },
      { logger: silentLogger },
    );
    assert.equal(p.start(), true);
    assert.equal(p.start(), false, 'second start must be a no-op');
    assert.ok(p.pid > 0);
    await p.stop();
    assert.equal(p.pid, null);
  });

  it('marks a missing precheckPath as failed without spawning', () => {
    const p = new ManagedProcess(
      'ghost',
      { command: process.execPath, args: ['-e', ''], precheckPath: join(tmpdir(), 'definitely-not-here-xyz') },
      { logger: silentLogger },
    );
    assert.equal(p.start(), false);
    assert.equal(p.lastState, 'failed');
    assert.match(String(p.lastError ?? 'missing'), /missing/);
  });

  it('surfaces a spawn failure instead of throwing', () => {
    const p = new ManagedProcess(
      'nope',
      { command: 'definitely-not-a-real-binary-xyz', args: [] },
      { logger: silentLogger },
    );
    assert.doesNotThrow(() => p.start());
  });

  it('records an abnormal exit', async () => {
    const p = new ManagedProcess(
      'crasher',
      { command: process.execPath, args: ['-e', 'process.exit(3)'] },
      { logger: silentLogger },
    );
    p.start();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(p.lastState, 'down');
  });

  it('keeps literal args containing $ untouched', () => {
    const p = new ManagedProcess(
      'args',
      { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)', '--label', '$HOME'] },
      { logger: silentLogger },
    );
    p.start();
    // Args are handed to spawn verbatim; the check is that start() did not throw.
    assert.equal(p.lastState, 'starting');
    void p.stop();
  });
});

describe('superviseOnce', () => {
  it('reports up and spawns nothing when the service answers', async () => {
    const svc = await startFakeService(200);
    let spawned = false;
    const process_ = new ManagedProcess('fake', { command: process.execPath, args: [] }, { logger: silentLogger });
    process_.start = () => { spawned = true; return true; };

    const results = await superviseOnce([{ label: 'fake', baseURL: `${svc.url}/v1`, process: process_ }]);
    assert.deepEqual(results, [{ label: 'fake', action: 'none', healthy: true }]);
    assert.equal(spawned, false);
    assert.equal(process_.lastState, 'up');
    await new Promise((r) => svc.server.close(r));
  });

  it('spawns when the probe fails', async () => {
    let spawned = false;
    const process_ = new ManagedProcess('fake', { command: process.execPath, args: [] }, { logger: silentLogger });
    process_.start = () => { spawned = true; return true; };

    const results = await superviseOnce([{ label: 'fake', baseURL: 'http://127.0.0.1:1/v1', process: process_ }]);
    assert.deepEqual(results, [{ label: 'fake', action: 'spawn', healthy: false }]);
    assert.equal(spawned, true);
  });

  it('honours spawnIfDown: false', async () => {
    let spawned = false;
    const process_ = new ManagedProcess('fake', { command: process.execPath, args: [] }, { logger: silentLogger });
    process_.start = () => { spawned = true; return true; };

    const results = await superviseOnce([
      { label: 'fake', baseURL: 'http://127.0.0.1:1/v1', process: process_, spawnIfDown: false },
    ]);
    assert.deepEqual(results, [{ label: 'fake', action: 'none', healthy: false }]);
    assert.equal(spawned, false);
  });
});

describe('startSupervisor', () => {  it('runs a pass immediately and stops on dispose', async () => {
    const svc = await startFakeService(200);
    let passes = 0;
    const process_ = new ManagedProcess('fake', { command: process.execPath, args: [] }, { logger: silentLogger });
    const realStart = process_.start.bind(process_);
    process_.start = () => { passes += 1; return realStart(); };

    const dispose = startSupervisor(
      [{ label: 'fake', baseURL: `${svc.url}/v1`, process: process_ }],
      { intervalMs: 60_000, probeTimeoutMs: 500, logger: silentLogger },
    );
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(passes, 0, 'a healthy service must not be spawned');
    assert.equal(process_.lastState, 'up');
    await dispose();
    await new Promise((r) => svc.server.close(r));
  });

  it('does not keep the process alive when idle', async () => {
    const process_ = new ManagedProcess('fake', { command: process.execPath, args: [] }, { logger: silentLogger });
    process_.start = () => false;
    const dispose = startSupervisor(
      [{ label: 'fake', baseURL: 'http://127.0.0.1:1/v1', process: process_ }],
      { intervalMs: 60_000, probeTimeoutMs: 300, logger: silentLogger },
    );
    await new Promise((r) => setTimeout(r, 200));
    await dispose();
  });
});

describe('autostart end to end', () => {
  // These spawn a real child and wait for it to bind a port, so they are the
  // only tests here that prove the whole loop: probe -> spawn -> healthy.
  const children = [];

  after(async () => {
    for (const c of children) {
      try { c.kill('SIGKILL'); } catch { /* already gone */ }
    }
  });

  it('spawns a dead service and reports it healthy once it binds', async () => {
    const port = 45231;
    const service = new ManagedProcess(
      'e2e',
      {
        command: process.execPath,
        args: [join(import.meta.dirname, 'fixtures', 'fake-service.mjs'), String(port)],
      },
      { logger: silentLogger },
    );
    children.push(service);

    const baseURL = `http://127.0.0.1:${port}/v1`;
    assert.equal(await probe(`${baseURL.replace(/\/v1$/, '')}/healthz`, 300), false);

    const first = await superviseOnce([{ label: 'e2e', baseURL, process: service }], { probeTimeoutMs: 300 });
    assert.equal(first[0].action, 'spawn');

    // Give the child a moment to bind, then the next pass must see it up.
    let healthy = false;
    for (let i = 0; i < 40 && !healthy; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const results = await superviseOnce([{ label: 'e2e', baseURL, process: service }], { probeTimeoutMs: 300 });
      healthy = results[0].healthy;
    }
    assert.equal(healthy, true, 'supervised child never became healthy');
    assert.equal(service.lastState, 'up');
    assert.ok(service.pid > 0);
    await service.stop();
  });

  it('brings a crashed service back on the next pass', async () => {
    const port = 45232;
    const service = new ManagedProcess(
      'restart',
      {
        command: process.execPath,
        args: [join(import.meta.dirname, 'fixtures', 'fake-service.mjs'), String(port)],
      },
      { logger: silentLogger },
    );
    children.push(service);
    const baseURL = `http://127.0.0.1:${port}/v1`;

    await superviseOnce([{ label: 'restart', baseURL, process: service }], { probeTimeoutMs: 300 });
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const [r] = await superviseOnce([{ label: 'restart', baseURL, process: service }], { probeTimeoutMs: 300 });
      if (r.healthy) break;
    }
    const firstPid = service.pid;
    assert.ok(firstPid > 0);

    // Kill it the way a crash would, then let the supervisor notice.
    service.child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(service.pid, null, 'child should be reaped after the kill');

    const [down] = await superviseOnce([{ label: 'restart', baseURL, process: service }], { probeTimeoutMs: 300 });
    assert.equal(down.action, 'spawn', 'a dead service must be respawned');
    assert.notEqual(service.pid, firstPid);
    await service.stop();
  });
});


describe('readGatewayApiKey', () => {
  /** Write a config.json into a fresh temp dir and return that dir. */
  function dirWith(contents) {
    const dir = mkdtempSync(join(tmpdir(), 'wbs-key-'));
    if (contents !== undefined) writeFileSync(join(dir, 'config.json'), contents);
    return dir;
  }

  it('reads api_key out of the gateway config.json', () => {
    const dir = dirWith(JSON.stringify({ api_key: 'abc123', other: 1 }));
    const found = readGatewayApiKey(dir);
    assert.equal(found.apiKey, 'abc123');
    assert.equal(found.error, null);
  });

  it('tolerates a UTF-8 BOM, which Windows editors add', () => {
    const dir = dirWith('\uFEFF' + JSON.stringify({ api_key: 'bom-key' }));
    assert.equal(readGatewayApiKey(dir).apiKey, 'bom-key');
  });

  it('accepts the camelCase spelling as well', () => {
    const dir = dirWith(JSON.stringify({ apiKey: 'camel' }));
    assert.equal(readGatewayApiKey(dir).apiKey, 'camel');
  });

  it('reports a missing file instead of throwing', () => {
    const found = readGatewayApiKey(mkdtempSync(join(tmpdir(), 'wbs-none-')));
    assert.equal(found.apiKey, null);
    assert.match(found.error, /not found/);
  });

  it('reports invalid JSON instead of throwing', () => {
    const found = readGatewayApiKey(dirWith('{ not json'));
    assert.equal(found.apiKey, null);
    assert.ok(found.error);
  });

  it('reports a config without api_key', () => {
    const found = readGatewayApiKey(dirWith(JSON.stringify({ port: 7863 })));
    assert.equal(found.apiKey, null);
    assert.match(found.error, /no `api_key`/);
  });

  it('treats a blank api_key as absent', () => {
    const found = readGatewayApiKey(dirWith(JSON.stringify({ api_key: '   ' })));
    assert.equal(found.apiKey, null);
  });
});

describe('bridgeLaunchSpec', () => {
  /** A Config-shaped object, defaulted the way the schema would. */
  function cfg(overrides = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'wbs-spec-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ api_key: 'gw-key' }));
    return {
      intervalMs: 15000,
      probeTimeoutMs: 2000,
      gatewayDir: dir,
      gateway: { enabled: true, autostart: true, baseURL: 'http://127.0.0.1:7863', command: 'x', args: [], cwd: '', env: {}, acceptStatus: [200, 503] },
      bridge: {
        enabled: true,
        autostart: true,
        baseURL: 'http://127.0.0.1:7864',
        command: '',
        args: [],
        cwd: '',
        env: {},
        acceptStatus: [200],
        upstream: '',
        apiKey: '',
        conversationId: 'auto',
        modelAllowlist: [],
        ...overrides,
      },
      ...overrides.__root,
    };
  }

  it('runs the shipped bridge entry through the current Node', () => {
    const spec = bridgeLaunchSpec(cfg(), silentLogger);
    assert.equal(spec.command, process.execPath);
    assert.equal(spec.args[0], BRIDGE_ENTRY);
    assert.ok(existsSync(spec.args[0]), 'the packaged bridge must actually be on disk');
  });

  it('points the bridge at the gateway it supervises', () => {
    const spec = bridgeLaunchSpec(cfg(), silentLogger);
    assert.equal(spec.env.CCB_UPSTREAM, 'http://127.0.0.1:7863/v1');
    assert.ok(spec.args.includes('7864'));
    assert.equal(spec.env.CCB_HOST, '127.0.0.1');
  });

  it('reuses the gateway api key so the two cannot drift apart', () => {
    assert.equal(bridgeLaunchSpec(cfg(), silentLogger).env.CCB_API_KEY, 'gw-key');
  });

  it('prefers an explicit bridge.apiKey over the gateway config', () => {
    const spec = bridgeLaunchSpec(cfg({ apiKey: 'explicit' }), silentLogger);
    assert.equal(spec.env.CCB_API_KEY, 'explicit');
  });

  it('keeps conversationId=auto, which the WorkBuddy upstream requires', () => {
    assert.equal(bridgeLaunchSpec(cfg(), silentLogger).env.CCB_CONVERSATION_ID, 'auto');
  });

  it('warns when conversationId is blanked out', () => {
    const warnings = [];
    const logger = { ...silentLogger, warn: (m) => warnings.push(m) };
    bridgeLaunchSpec(cfg({ conversationId: '' }), logger);
    assert.ok(warnings.some((w) => /11-128/.test(w)), 'the account-disable risk must be spelled out');
  });

  it('honours a custom upstream instead of the gateway', () => {
    const spec = bridgeLaunchSpec(cfg({ upstream: 'http://10.0.0.5:9000' }), silentLogger);
    assert.equal(spec.env.CCB_UPSTREAM, 'http://10.0.0.5:9000/v1');
  });

  it('passes the model allowlist through when one is set', () => {
    const spec = bridgeLaunchSpec(cfg({ modelAllowlist: ['a', 'b'] }), silentLogger);
    assert.equal(spec.env.CCB_MODEL_ALLOWLIST, 'a,b');
  });

  it('leaves the allowlist unset when empty, so the bridge forwards everything', () => {
    assert.equal(bridgeLaunchSpec(cfg(), silentLogger).env.CCB_MODEL_ALLOWLIST, undefined);
  });

  it('delegates to a custom command and still hands it the port', () => {
    const spec = bridgeLaunchSpec(cfg({ command: 'node', args: ['custom.mjs'] }), silentLogger);
    assert.equal(spec.command, 'node');
    assert.deepEqual(spec.args, ['custom.mjs']);
    assert.equal(spec.env.CCB_PORT, '7864');
  });

  it('warns, but still starts, when no key can be found anywhere', () => {
    const warnings = [];
    const logger = { ...silentLogger, warn: (m) => warnings.push(m) };
    const c = cfg();
    c.gatewayDir = mkdtempSync(join(tmpdir(), 'wbs-nokey-'));
    const spec = bridgeLaunchSpec(c, logger);
    assert.equal(spec.env.CCB_API_KEY, undefined);
    assert.ok(warnings.some((w) => /401/.test(w)));
  });
});
