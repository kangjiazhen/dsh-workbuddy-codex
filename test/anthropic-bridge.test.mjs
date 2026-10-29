/**
 * Tests for the Anthropic Messages -> Chat Completions bridge.
 *
 * Like the Responses bridge, this one is a standalone script that exports
 * nothing, so the tests spawn it against a fake Chat Completions upstream. That
 * is also the only way to assert what the upstream *receives* — which is the
 * point of the model-id and effort assertions below.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { after, describe, it } from 'node:test';

import { ANTHROPIC_BRIDGE_ENTRY } from '../lib/supervisor.js';

/**
 * A fake gateway. `/v1/models` serves a catalog whose ids carry other vendors'
 * brand tokens — exactly what Desktop's own filter would drop, and therefore
 * exactly what the bridge has to hide behind a Claude-shaped alias.
 */
function startFakeUpstream({ models, streamChunks } = {}) {
  const seen = [];
  const catalog = models ?? [
    { id: 'cn:kimi-k3.1-pro', name: 'Kimi K3.1 Pro', supports_images: true, context_length: 1_000_000 },
    { id: 'global:gpt-6.1', name: 'GPT 6.1' },
  ];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ data: catalog, has_more: false }));
        return;
      }
      let body = {};
      try { body = JSON.parse(raw); } catch { body = { __unparsable: raw }; }
      seen.push({ url: req.url, headers: req.headers, body });

      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          id: 'c1',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const chunk of streamChunks ?? [
        { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 11, completion_tokens: 2 } },
      ]) {
        res.write(`data: ${JSON.stringify({ id: 'c1', ...chunk })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

/** Spawn the bridge against `upstreamPort` and wait for its listen line. */
function startBridge(upstreamPort, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [ANTHROPIC_BRIDGE_ENTRY, '--port', '0', '--upstream', `http://127.0.0.1:${upstreamPort}`],
      { env: { ...process.env, ANB_API_KEY: 'test-key', ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    const onData = (buf) => {
      out += String(buf);
      const m = out.match(/listening on (http:\/\/[^\s]+)/);
      if (m) {
        child.stdout.off('data', onData);
        resolve({ child, baseURL: m[1], logs: () => out + err });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (b) => { err += String(b); });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`bridge exited ${code}: ${err || out}`)));
    setTimeout(() => reject(new Error(`bridge did not start: ${err || out}`)), 15_000);
  });
}

/** Parse an Anthropic SSE body into `{event, data}` pairs. */
function parseSSE(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (!event || !data) continue;
    events.push({ event, data: JSON.parse(data) });
  }
  return events;
}

const post = (baseURL, path, body) => fetch(`${baseURL}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'client-key' },
  body: JSON.stringify(body),
});

describe('anthropic-chat-bridge', () => {
  const cleanups = [];
  after(() => {
    for (const fn of cleanups) fn();
  });

  async function setup(opts) {
    const upstream = await startFakeUpstream(opts);
    const bridge = await startBridge(upstream.port);
    cleanups.push(() => { bridge.child.kill(); upstream.server.close(); });
    return { upstream, bridge };
  }

  it('lists the gateway catalog under Claude-shaped ids', async () => {
    const { bridge, upstream } = await setup();
    const body = await (await fetch(`${bridge.baseURL}/v1/models`)).json();
    assert.equal(body.data.length, 2);
    for (const m of body.data) {
      // Desktop drops any id carrying another vendor's brand token, and rejects
      // a non-Anthropic id outright — so neither the real id nor its vendor
      // prefix may survive into the picker.
      assert.match(m.id, /^claude-wb-[0-9a-f]+$/);
      assert.ok(!/kimi|gpt/i.test(m.id), `id must not leak the vendor: ${m.id}`);
    }
    // …but the human still has to recognise the model, so the label keeps it.
    assert.match(body.data[0].display_name, /Kimi K3\.1 Pro/);
    assert.equal(body.has_more, false);
    assert.ok(upstream.seen.every((r) => r.headers.authorization === 'Bearer test-key'));
  });

  it('keeps models with an identical gateway name distinguishable', async () => {
    const { bridge } = await setup({
      models: [
        { id: 'cn:hy3', name: 'Hy3' },
        { id: 'cn:hy3-x', name: 'Hy3' },
        { id: 'cn:solo', name: 'Solo' },
      ],
    });
    const body = await (await fetch(`${bridge.baseURL}/v1/models`)).json();
    const labels = body.data.map((m) => m.display_name);
    // Desktop merges picker rows on (display_name, Anthropic family). Distinct
    // real ids sharing one name would collapse into a single entry, so every
    // label has to be unique — but only the clashing ones grow a suffix.
    assert.equal(new Set(labels).size, labels.length, `duplicate labels: ${labels.join(' | ')}`);
    assert.deepEqual(labels, ['CN · Hy3', 'CN · Hy3 (x)', 'CN · Solo']);
    assert.equal(body.data.length, 3);
  });

  it('translates a streamed answer into the Anthropic SSE sequence', async () => {
    const { bridge } = await setup();
    const models = await (await fetch(`${bridge.baseURL}/v1/models`)).json();
    const r = await post(bridge.baseURL, '/v1/messages', {
      model: models.data[0].id,
      max_tokens: 16,
      system: [{ type: 'text', text: 'be terse' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      stream: true,
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/event-stream/);

    const events = parseSSE(await r.text());
    const names = events.map((e) => e.event);
    assert.equal(names[0], 'message_start');
    assert.equal(names.at(-1), 'message_stop');
    assert.ok(names.includes('content_block_start'));
    assert.ok(names.includes('content_block_delta'));
    assert.ok(names.includes('content_block_stop'));
    assert.ok(names.indexOf('message_delta') > names.lastIndexOf('content_block_stop'));

    const text = events
      .filter((e) => e.data.delta?.type === 'text_delta')
      .map((e) => e.data.delta.text)
      .join('');
    assert.equal(text, 'ok');

    const delta = events.find((e) => e.event === 'message_delta').data;
    assert.equal(delta.delta.stop_reason, 'end_turn');
    assert.equal(delta.usage.output_tokens, 2);
  });

  it('answers a request that omits `stream` with JSON, not SSE', async () => {
    // Anthropic's default is non-streaming, and the desktop app's config-health
    // probe relies on it: it sends `max_tokens: 1` with no `stream` field and
    // parses the reply with `res.json()`. Replying with SSE made every probe
    // fail as "unparseable completion body" and the app showed
    // "Gateway returned an error" even though inference worked.
    const { bridge, upstream } = await setup();
    const models = await (await fetch(`${bridge.baseURL}/v1/models`)).json();
    const r = await post(bridge.baseURL, '/v1/messages', {
      model: models.data[0].id,
      max_tokens: 1,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Say OK' }] }],
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /application\/json/);

    const message = await r.json();
    assert.equal(message.type, 'message');
    assert.equal(message.role, 'assistant');
    assert.equal(message.model, models.data[0].id);
    assert.equal(message.content[0].type, 'text');
    assert.equal(message.content[0].text, 'ok');
    assert.equal(message.stop_reason, 'end_turn');
    // Upstream must be told to answer in one shot, or it streams anyway.
    assert.equal(upstream.seen.at(-1).body.stream, false);
  });

  it('sends the real model id upstream and a conversation id the gateway requires', async () => {
    const { bridge, upstream } = await setup();
    const models = await (await fetch(`${bridge.baseURL}/v1/models`)).json();
    await post(bridge.baseURL, '/v1/messages', {
      model: models.data[1].id,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const sent = upstream.seen.at(-1).body;
    // The alias exists only on the client side of the translation.
    assert.equal(sent.model, 'global:gpt-6.1');
    assert.equal(sent.stream, true);
    assert.equal(typeof sent.metadata?.conversation_id, 'string');
    assert.ok(sent.metadata.conversation_id.length > 0);
  });

  it('maps tools both ways, including the tool_result round trip', async () => {
    const { bridge, upstream } = await setup({
      streamChunks: [
        {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"北京"}' },
              }],
            },
            finish_reason: null,
          }],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ],
    });
    const models = await (await fetch(`${bridge.baseURL}/v1/models`)).json();
    const tool = {
      name: 'get_weather',
      description: 'weather',
      input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    };

    const r = await post(bridge.baseURL, '/v1/messages', {
      model: models.data[0].id,
      max_tokens: 64,
      tools: [tool],
      messages: [{ role: 'user', content: 'weather in Beijing?' }],
      stream: true,
    });
    const events = parseSSE(await r.text());
    const start = events.find((e) => e.data.content_block?.type === 'tool_use')?.data.content_block;
    assert.ok(start, 'a tool_use block must be announced');
    assert.equal(start.name, 'get_weather');
    const json = events
      .filter((e) => e.data.delta?.type === 'input_json_delta')
      .map((e) => e.data.delta.partial_json)
      .join('');
    assert.deepEqual(JSON.parse(json), { city: '北京' });
    assert.equal(events.find((e) => e.event === 'message_delta').data.delta.stop_reason, 'tool_use');

    // The upstream tool schema is the Anthropic `input_schema`, unwrapped.
    const sentTools = upstream.seen.at(-1).body.tools;
    assert.equal(sentTools[0].type, 'function');
    assert.deepEqual(sentTools[0].function.parameters, tool.input_schema);

    // And a tool_result on the way back becomes a `role:"tool"` message.
    await post(bridge.baseURL, '/v1/messages', {
      model: models.data[0].id,
      max_tokens: 64,
      tools: [tool],
      messages: [
        { role: 'user', content: 'weather in Beijing?' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'call it', signature: 'sig' },
            { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: '北京' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '22C sunny' }],
        },
      ],
      stream: true,
    });
    const roundTrip = upstream.seen.at(-1).body.messages;
    const assistant = roundTrip.find((m) => m.role === 'assistant');
    assert.equal(assistant.tool_calls[0].function.name, 'get_weather');
    assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { city: '北京' });
    const toolMsg = roundTrip.find((m) => m.role === 'tool');
    assert.equal(toolMsg.tool_call_id, 'call_1');
    assert.equal(toolMsg.content, '22C sunny');
  });

  it('answers count_tokens locally, since the gateway has no such endpoint', async () => {
    const { bridge, upstream } = await setup();
    const before = upstream.seen.length;
    const body = await (await post(bridge.baseURL, '/v1/messages/count_tokens', {
      model: 'claude-wb-anything',
      messages: [{ role: 'user', content: 'hello world' }],
    })).json();
    assert.ok(body.input_tokens > 0);
    assert.equal(upstream.seen.length, before, 'count_tokens must not hit the upstream');
  });

  it('rejects an unknown model instead of forwarding a guess', async () => {
    const { bridge } = await setup();
    const r = await post(bridge.baseURL, '/v1/messages', {
      model: 'totally-unknown-model',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    assert.equal(r.status, 404);
    const body = await r.json();
    assert.equal(body.type, 'error');
  });

  it('falls back to the catalog for a bare Claude alias', async () => {
    const { bridge, upstream } = await setup();
    // A client that names `claude-sonnet-5-5` never saw the picker; it must
    // still reach a real model rather than 404.
    const r = await post(bridge.baseURL, '/v1/messages', {
      model: 'claude-sonnet-5-5',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    assert.equal(r.status, 200);
    assert.equal(upstream.seen.at(-1).body.model, 'cn:kimi-k3.1-pro');
  });

  it('carries the gateway context window so Desktop stops showing 200K', async () => {
    const { bridge } = await setup({
      models: [
        { id: 'cn:big', name: 'Big', context_length: 1_000_000 },
        { id: 'cn:small', name: 'Small', context_length: 200_000 },
      ],
    });
    const body = await (await fetch(`${bridge.baseURL}/v1/models`)).json();
    // Desktop derives "1M" from `max_input_tokens >= 1e6` and substitutes its
    // own 200 000 default when the row omits the field — silently capping every
    // model. The number therefore has to survive the translation.
    const byLabel = Object.fromEntries(body.data.map((m) => [m.display_name, m]));
    assert.equal(byLabel['CN · Big'].max_input_tokens, 1_000_000);
    assert.equal(byLabel['CN · Big'].prefer_1m, true);
    assert.equal(byLabel['CN · Small'].max_input_tokens, 200_000);
    assert.equal(byLabel['CN · Small'].prefer_1m, undefined);
  });

  it('advertises the top effort and a Claude family so the selector renders', async () => {
    const { bridge } = await setup({
      models: [
        { id: 'cn:thinker', name: 'Thinker', reasoning_supported_efforts: ['low', 'medium', 'max'] },
        { id: 'cn:plain', name: 'Plain' },
      ],
    });
    const body = await (await fetch(`${bridge.baseURL}/v1/models`)).json();
    const byLabel = Object.fromEntries(body.data.map((m) => [m.display_name, m]));
    // A missing `max_effort_level` reads as "low" to Desktop; a row with no
    // resolvable Claude family gets no thinking UI at all.
    assert.equal(byLabel['CN · Thinker'].max_effort_level, 'max');
    assert.match(byLabel['CN · Thinker'].behaves_as, /^claude-/);
    // A non-reasoning model must not claim a ladder it cannot honour.
    assert.equal(byLabel['CN · Plain'].max_effort_level, undefined);
    assert.equal(byLabel['CN · Plain'].behaves_as, undefined);
  });

  it('assumes the full ladder for a reasoning row that declares none', async () => {
    const { bridge } = await setup({
      models: [
        // The gateway serves a couple of reasoning-only models whose row carries
        // `supports_reasoning` and a single `reasoning_effort` scalar but no
        // `reasoning_supported_efforts` array. Reading that as "no ladder" cost
        // them both the picker's effort control and the max-by-default rule,
        // even though the gateway accepts every level for them.
        { id: 'cn:mimo', name: 'MiMo', supports_reasoning: true, reasoning_effort: 'high' },
        { id: 'cn:plain', name: 'Plain', supports_reasoning: false },
      ],
    });
    const body = await (await fetch(`${bridge.baseURL}/v1/models`)).json();
    const byLabel = Object.fromEntries(body.data.map((m) => [m.display_name, m]));
    assert.equal(byLabel['CN · MiMo'].max_effort_level, 'max');
    assert.match(byLabel['CN · MiMo'].behaves_as, /^claude-/);
    assert.equal(byLabel['CN · Plain'].max_effort_level, undefined);
  });

  it('thinks as hard as it can when the client states no effort at all', async () => {
    const { bridge, upstream } = await setup({
      models: [{ id: 'cn:hy4-preview', name: 'Hy4', reasoning_supported_efforts: ['low', 'high', 'max'] }],
    });
    const models = await (await fetch(`${bridge.baseURL}/v1/models`)).json();
    // Desktop and the CLI only send an effort once the user touches the
    // selector, so "unstated" is the everyday case — and the product decision
    // is that it must default to the model's highest level, not its lowest.
    await post(bridge.baseURL, '/v1/messages', {
      model: models.data[0].id,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    assert.equal(upstream.seen.at(-1).body.reasoning_effort, 'max');
  });

  it('never forwards an effort the target model does not advertise', async () => {
    const { bridge, upstream } = await setup({
      models: [{
        id: 'cn:hy4-preview',
        name: 'Hy4 preview',
        reasoning_supported_efforts: ['low', 'medium'],
      }],
    });
    const models = await (await fetch(`${bridge.baseURL}/v1/models`)).json();
    await post(bridge.baseURL, '/v1/messages', {
      model: models.data[0].id,
      max_tokens: 8,
      output_config: { effort: 'max' },
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    // 'max' is unsupported here; walking down the ladder must stop at 'medium'
    // rather than sending a value the gateway would reject or silently drop.
    assert.equal(upstream.seen.at(-1).body.reasoning_effort, 'medium');
  });

  it('serves a complete message when the client does not stream', async () => {
    const { bridge } = await setup();
    const models = await (await fetch(`${bridge.baseURL}/v1/models`)).json();
    const r = await post(bridge.baseURL, '/v1/messages', {
      model: models.data[0].id,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.type, 'message');
    assert.equal(body.role, 'assistant');
    assert.equal(body.stop_reason, 'end_turn');
    assert.equal(body.content[0].text, 'ok');
  });
});
