/**
 * Unit tests for the provider delegation.
 *
 * Nothing here needs the harness, a network, or `dsh-llm-workbuddy`: the upstream
 * import is injected, and `ctx` is a two-field stand-in for the two services the
 * mount actually touches (`llm` for the route check, `plugin` for the mount).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  PROVIDER,
  UPSTREAM_PACKAGE,
  mountProvider,
  providerAlreadyServed,
  resolveProviderConfig,
} from '../lib/provider.js';

const quiet = { info() {}, warn() {} };
const scratch = [];

function tempGateway(config) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-provider-'));
  scratch.push(dir);
  if (config !== undefined) {
    writeFileSync(join(dir, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  return dir;
}

/** Minimal cordis stand-in: `get('llm')` plus a `plugin()` that records its call. */
function fakeContext({ providers = [], plugin } = {}) {
  const calls = [];
  const llm = { listProviders: () => providers };
  const ctx = {
    get: (name) => (name === 'llm' ? llm : undefined),
    plugin(mod, config) {
      calls.push({ mod, config });
      if (plugin) return plugin(mod, config);
      return Promise.resolve();
    },
  };
  return { ctx, calls };
}

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('resolveProviderConfig', () => {
  it('follows the gateway base URL when provider.baseURL is empty', () => {
    const gatewayDir = tempGateway({ api_key: 'k' });
    const resolved = resolveProviderConfig({ baseURL: '', gatewayBaseURL: 'http://127.0.0.1:7863', gatewayDir });
    assert.equal(resolved.baseURL, 'http://127.0.0.1:7863/v1');
  });

  it('does not double the /v1 suffix', () => {
    const gatewayDir = tempGateway({ api_key: 'k' });
    const resolved = resolveProviderConfig({
      baseURL: '',
      gatewayBaseURL: 'http://127.0.0.1:7863/v1/',
      gatewayDir,
    });
    assert.equal(resolved.baseURL, 'http://127.0.0.1:7863/v1');
  });

  it('prefers an explicit provider.baseURL over the gateway', () => {
    const gatewayDir = tempGateway({ api_key: 'k' });
    const resolved = resolveProviderConfig({
      baseURL: 'http://10.0.0.2:9999',
      gatewayBaseURL: 'http://127.0.0.1:7863',
      gatewayDir,
    });
    assert.equal(resolved.baseURL, 'http://10.0.0.2:9999/v1');
  });

  it('reads the key out of the gateway config.json', () => {
    const gatewayDir = tempGateway({ api_key: '  from-file  ' });
    const resolved = resolveProviderConfig({ baseURL: '', gatewayBaseURL: 'http://127.0.0.1:7863', gatewayDir });
    assert.equal(resolved.apiKey, 'from-file');
    assert.match(resolved.keySource, /config\.json$/);
    assert.equal(resolved.keyError, null);
  });

  it('prefers an explicit provider.apiKey and does not touch the file', () => {
    const gatewayDir = tempGateway({ api_key: 'from-file' });
    const resolved = resolveProviderConfig({
      baseURL: '',
      gatewayBaseURL: 'http://127.0.0.1:7863',
      gatewayDir,
      apiKey: 'explicit',
    });
    assert.equal(resolved.apiKey, 'explicit');
    assert.equal(resolved.keySource, 'provider.apiKey');
  });

  it('reports why no key was found instead of throwing', () => {
    const gatewayDir = tempGateway(undefined); // no config.json at all
    const resolved = resolveProviderConfig({ baseURL: '', gatewayBaseURL: 'http://127.0.0.1:7863', gatewayDir });
    assert.equal(resolved.apiKey, '');
    assert.match(resolved.keyError, /config\.json/);
  });

  it('defaults the checkin knobs the way the upstream plugin does', () => {
    const gatewayDir = tempGateway({ api_key: 'k' });
    const resolved = resolveProviderConfig({ baseURL: '', gatewayBaseURL: 'http://127.0.0.1:7863', gatewayDir });
    assert.equal(resolved.discovery, true);
    assert.equal(resolved.autoCheckin, true);
    assert.equal(resolved.checkinAfterHour, 10);
  });

  it('throws when neither provider.baseURL nor the gateway has one', () => {
    const gatewayDir = tempGateway({ api_key: 'k' });
    assert.throws(() => resolveProviderConfig({ baseURL: '', gatewayBaseURL: '', gatewayDir }));
  });
});

describe('providerAlreadyServed', () => {
  it('is false on an empty registry', () => {
    const { ctx } = fakeContext({ providers: [] });
    assert.equal(providerAlreadyServed(ctx), false);
  });

  it('is true once the workbuddy route exists', () => {
    const { ctx } = fakeContext({ providers: [{ id: PROVIDER, name: 'WorkBuddy' }] });
    assert.equal(providerAlreadyServed(ctx), true);
  });

  it('does not mistake another provider for ours', () => {
    const { ctx } = fakeContext({ providers: [{ id: 'deepseek-account', name: 'DeepSeek' }] });
    assert.equal(providerAlreadyServed(ctx), false);
  });

  it('is false when there is no llm service at all', () => {
    assert.equal(providerAlreadyServed({ get: () => undefined }), false);
  });

  it('is false when the registry throws', () => {
    const ctx = {
      get: () => ({
        listProviders() {
          throw new Error('boom');
        },
      }),
    };
    assert.equal(providerAlreadyServed(ctx), false);
  });
});

describe('mountProvider', () => {
  const base = () => ({
    enabled: true,
    baseURL: '',
    apiKey: 'k',
    gatewayBaseURL: 'http://127.0.0.1:7863',
    gatewayDir: '.',
  });

  it('does nothing when disabled', async () => {
    const { ctx, calls } = fakeContext();
    const result = await mountProvider(ctx, { ...base(), enabled: false }, quiet);
    assert.deepEqual(result, { mounted: false, reason: 'disabled', baseURL: null, apiKey: null });
    assert.equal(calls.length, 0);
  });

  it('stands down when the route is already registered', async () => {
    const { ctx, calls } = fakeContext({ providers: [{ id: PROVIDER, name: 'WorkBuddy' }] });
    const result = await mountProvider(ctx, base(), quiet);
    assert.equal(result.reason, 'already-served');
    assert.equal(calls.length, 0);
  });

  it('does not spawn a duplicate when the plugin is missing', async () => {
    const { ctx, calls } = fakeContext();
    const result = await mountProvider(
      ctx,
      {
        ...base(),
        importUpstream: async () => {
          throw new Error('Cannot find package');
        },
      },
      quiet,
    );
    assert.equal(result.reason, 'upstream-missing');
    assert.equal(calls.length, 0);
  });

  it('mounts the upstream plugin and forwards the derived connection facts', async () => {
    const { ctx, calls } = fakeContext();
    const fakeModule = { name: 'llm-workbuddy', inject: ['llm'], apply() {} };
    const result = await mountProvider(ctx, { ...base(), importUpstream: async () => fakeModule }, quiet);

    assert.equal(result.mounted, true);
    assert.equal(result.baseURL, 'http://127.0.0.1:7863/v1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mod, fakeModule);
    assert.deepEqual(calls[0].config, {
      baseURL: 'http://127.0.0.1:7863/v1',
      apiKey: 'k',
      discovery: true,
      autoCheckin: true,
      checkinAfterHour: 10,
    });
  });

  it('treats a lost race against the standalone bundle as a skip, not a failure', async () => {
    const { ctx } = fakeContext({
      plugin: () => Promise.reject(Object.assign(new Error('already registered'), { code: 'DUPLICATE_ADAPTER' })),
    });
    const result = await mountProvider(ctx, { ...base(), importUpstream: async () => ({ apply() {} }) }, quiet);
    assert.equal(result.mounted, false);
    assert.equal(result.reason, 'already-served');
  });

  it('reports a real mount failure instead of throwing', async () => {
    const { ctx } = fakeContext({ plugin: () => Promise.reject(new Error('llm seam exploded')) });
    const result = await mountProvider(ctx, { ...base(), importUpstream: async () => ({ apply() {} }) }, quiet);
    assert.equal(result.mounted, false);
    assert.equal(result.reason, 'mount-failed');
  });

  it('does not even try to mount when the composition has no llm service', async () => {
    const calls = [];
    const ctx = { get: () => undefined, plugin: (...args) => calls.push(args) };
    const result = await mountProvider(ctx, base(), quiet);
    assert.equal(result.reason, 'no-llm-service');
    assert.equal(calls.length, 0);
  });

  it('names the package to install in the skip result path', () => {
    assert.equal(UPSTREAM_PACKAGE, 'dsh-llm-workbuddy');
  });
});
