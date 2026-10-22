/**
 * Contract tests for the `workbuddy_codex_status` tool descriptor.
 *
 * Why these exist: `tools.register()` rejects any definition without
 * `output { schema, render }` and validates the returned value against that
 * schema at call time. A descriptor that merely *looks* fine is therefore
 * silently dropped — the tool never reaches the model and the plugin reports
 * nothing. These assertions pin the shape the harness actually requires.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { STATUS_OUTPUT_SCHEMA, statusToolDefinition } from '../lib/status-tool.js';

const build = (providerState = { status: 'mounted', baseURL: 'http://127.0.0.1:7863/v1' }) =>
  statusToolDefinition({ services: [], probeTimeoutMs: 200, providerState });

test('declares the name the docs promise', () => {
  assert.equal(build().name, 'workbuddy_codex_status');
});

test('declares output { schema, render }, which register() requires', () => {
  const def = build();
  assert.equal(typeof def.output, 'object');
  assert.equal(typeof def.output.render, 'function');
  assert.equal(def.output.schema, STATUS_OUTPUT_SCHEMA);
});

test('parameter spec is an empty map, not a JSON Schema', () => {
  // `defineTool` reads `parameters` as a name → spec map; passing
  // `{ type: 'object' }` there would be parsed as a parameter called "type".
  assert.deepEqual(build().parameters, {});
});

test('output schema closes the object and requires both fields', () => {
  assert.equal(STATUS_OUTPUT_SCHEMA.type, 'object');
  assert.equal(STATUS_OUTPUT_SCHEMA.additionalProperties, false);
  // `defineTool` reads per-property `required: true` and emits the JSON Schema
  // required array itself, so that is the flag to assert here.
  assert.equal(STATUS_OUTPUT_SCHEMA.properties.ok.required, true);
  assert.equal(STATUS_OUTPUT_SCHEMA.properties.summary.required, true);
  assert.deepEqual(Object.keys(STATUS_OUTPUT_SCHEMA.properties).sort(), ['ok', 'summary']);
});

test('renders the summary rather than the raw value', () => {
  const def = build();
  const value = { ok: true, summary: 'line one\nline two' };
  assert.equal(def.output.render({}, value), 'line one\nline two');
});

test('returns exactly { ok, summary } so the value stays inside the schema', async () => {
  const def = build();
  const value = await def.execute({}, {});
  assert.deepEqual(Object.keys(value).sort(), ['ok', 'summary']);
  assert.equal(typeof value.ok, 'boolean');
  assert.equal(typeof value.summary, 'string');
});

test('reports the provider mount decision at call time, not at build time', async () => {
  const providerState = { status: 'mounted', baseURL: 'http://127.0.0.1:9999/v1' };
  const def = statusToolDefinition({ services: [], probeTimeoutMs: 200, providerState });
  // A later mount rewrites the same object; the tool must see the new value.
  providerState.status = 'already-served';
  const value = await def.execute({}, {});
  assert.match(value.summary, /provider workbuddy: already-served/);
});

test('a service that does not answer turns ok false and the row DOWN', async () => {
  // Port 1 on loopback refuses immediately, so this stays offline and fast.
  const services = [
    {
      label: 'bridge',
      baseURL: 'http://127.0.0.1:1/v1',
      acceptStatus: [200],
      spawnIfDown: true,
      process: { lastState: 'down', pid: null, lastError: null },
    },
  ];
  const def = statusToolDefinition({
    services,
    probeTimeoutMs: 500,
    providerState: { status: 'pending' },
  });
  const value = await def.execute({}, {});
  assert.equal(value.ok, false);
  assert.match(value.summary, /bridge: DOWN \(http:\/\/127\.0\.0\.1:1\/healthz\)/);
});

test('defineTool accepts the descriptor when the harness package is importable', async (t) => {
  let defineTool;
  try {
    ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
  } catch {
    t.skip('@deepseek-ai/dsh-tools is only resolvable inside DSH');
    return;
  }
  const tool = defineTool(build());
  assert.equal(tool.name, 'workbuddy_codex_status');
  assert.equal(typeof tool.output.render, 'function');
  const value = await tool.execute({}, {});
  assert.deepEqual(Object.keys(value).sort(), ['ok', 'summary']);
});
