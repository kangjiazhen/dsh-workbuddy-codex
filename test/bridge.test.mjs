/**
 * Tests for the Responses -> Chat Completions bridge.
 *
 * The bridge is a standalone script (it runs as its own process and exports
 * nothing), so these tests spawn it and point it at a fake Chat Completions
 * upstream. That is also the only way to assert what the upstream actually
 * receives — which is the whole point of the image test below.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { BRIDGE_ENTRY } from '../lib/supervisor.js';

/** A ~570 KB base64 payload, the size of the 1080p screenshot that broke a session. */
const BIG_B64 = 'A'.repeat(569_388);

/**
 * A fake Chat Completions backend. It records each request body and answers
 * with a minimal SSE stream so the bridge can complete.
 */
function startFakeUpstream() {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { seen.push(JSON.parse(raw)); } catch { seen.push({ __unparsable: raw }); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"c1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n');
      res.write('data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
      res.write('data: {"id":"c1","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":1,"total_tokens":12}}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, seen, port: server.address().port });
    });
  });
}

/** Spawn the bridge against `upstreamPort` and wait until it answers /health. */
function startBridge(upstreamPort, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [BRIDGE_ENTRY, '--port', '0', '--upstream', `http://127.0.0.1:${upstreamPort}`],
      { env: { ...process.env, CCB_INCLUDE_USAGE: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
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

/** POST a Responses body and return { status, body }. */
async function post(baseURL, body) {
  const r = await fetch(`${baseURL}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

/** A tool result carrying an image, the shape that caused the overflow. */
function imageToolOutputRequest() {
  return {
    model: 'test-model',
    stream: false,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look' }] },
      { type: 'function_call', call_id: 'call_1', name: 'screenshot', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [
          { type: 'input_text', text: 'captured 1206x759' },
          { type: 'input_image', image_url: `data:image/jpeg;base64,${BIG_B64}`, detail: 'high' },
        ],
      },
    ],
  };
}

describe('bridge: images inside tool results', () => {
  let upstream;
  let bridge;

  before(async () => {
    upstream = await startFakeUpstream();
    bridge = await startBridge(upstream.port);
  });

  after(() => {
    bridge?.child.kill();
    upstream?.server.close();
  });

  it('never forwards the base64 payload as literal text', async () => {
    upstream.seen.length = 0;
    const r = await post(bridge.baseURL, imageToolOutputRequest());
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const sent = upstream.seen.at(-1);
    const toolMsg = sent.messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg, 'a tool message must be sent');
    assert.equal(typeof toolMsg.content, 'string', 'tool content must stay a string');
    assert.ok(
      !toolMsg.content.includes('base64'),
      'the data URL must not reach the upstream as text',
    );
    assert.ok(
      toolMsg.content.length < 200,
      `tool content should be tiny, was ${toolMsg.content.length} chars`,
    );
  });

  it('re-attaches the image as a real image part in a following user message', async () => {
    upstream.seen.length = 0;
    await post(bridge.baseURL, imageToolOutputRequest());
    const sent = upstream.seen.at(-1);

    const withImage = sent.messages.filter(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'),
    );
    assert.equal(withImage.length, 1, 'exactly one message should carry the image');
    const carrier = withImage[0];
    assert.equal(carrier.role, 'user', 'images must ride on a user message');
    const parts = carrier.content.filter((p) => p.type === 'image_url');
    assert.equal(parts.length, 1);
    assert.equal(parts[0].image_url.url, `data:image/jpeg;base64,${BIG_B64}`);

    // The image must come after the tool message, or the tool_calls pairing breaks.
    const toolIdx = sent.messages.findIndex((m) => m.role === 'tool');
    const imgIdx = sent.messages.indexOf(carrier);
    assert.ok(imgIdx > toolIdx, 'the carrier must follow the tool result');
  });

  it('keeps the textual part in the tool message and notes where the image went', async () => {
    upstream.seen.length = 0;
    await post(bridge.baseURL, imageToolOutputRequest());
    const toolMsg = upstream.seen.at(-1).messages.find((m) => m.role === 'tool');
    assert.match(toolMsg.content, /captured 1206x759/);
    assert.match(toolMsg.content, /1 image attached in the next user message/);
  });

  it('still passes images in user messages through as image parts', async () => {
    upstream.seen.length = 0;
    await post(bridge.baseURL, {
      model: 'test-model',
      stream: false,
      input: [{
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'see this' },
          { type: 'input_image', image_url: `data:image/jpeg;base64,${BIG_B64}` },
        ],
      }],
    });
    const userMsg = upstream.seen.at(-1).messages.find((m) => m.role === 'user');
    assert.ok(Array.isArray(userMsg.content), 'user content must stay multimodal');
    assert.ok(userMsg.content.some((p) => p.type === 'image_url'));
  });

  it('hoists an image when output is a bare part object, not an array', async () => {
    upstream.seen.length = 0;
    await post(bridge.baseURL, {
      model: 'test-model',
      stream: false,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
        { type: 'function_call', call_id: 'call_2', name: 'screenshot', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'call_2',
          // Not wrapped in an array — this shape used to reach JSON.stringify.
          output: { type: 'input_image', image_url: `data:image/jpeg;base64,${BIG_B64}` },
        },
      ],
    });
    const sent = upstream.seen.at(-1);
    const toolMsg = sent.messages.find((m) => m.role === 'tool');
    assert.ok(!toolMsg.content.includes('base64'), 'a bare-part image must not leak as text');
    assert.ok(toolMsg.content.length < 200, `was ${toolMsg.content.length} chars`);
    const carrier = sent.messages.find(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'),
    );
    assert.ok(carrier, 'the bare-part image must still be forwarded as an image part');
  });

  it('hoists a data URL that arrives already embedded in a tool text string', async () => {
    upstream.seen.length = 0;
    await post(bridge.baseURL, {
      model: 'test-model',
      stream: false,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
        { type: 'function_call', call_id: 'call_3', name: 'shot', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'call_3',
          output: `screenshot saved\n![img](data:image/png;base64,${BIG_B64})`,
        },
      ],
    });
    const sent = upstream.seen.at(-1);
    const toolMsg = sent.messages.find((m) => m.role === 'tool');
    assert.ok(!toolMsg.content.includes('base64'), 'an embedded data URL must be scrubbed');
    assert.match(toolMsg.content, /screenshot saved/, 'surrounding text must survive');
    const carrier = sent.messages.find(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'),
    );
    assert.ok(carrier, 'an embedded data URL must still be forwarded as an image');
    assert.equal(carrier.content.filter((p) => p.type === 'image_url').length, 1);
  });

  it('caps how many images one tool result may hoist', async () => {
    upstream.seen.length = 0;
    const many = Array.from({ length: 11 }, () => ({
      type: 'input_image',
      image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
    }));
    await post(bridge.baseURL, {
      model: 'test-model',
      stream: false,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
        { type: 'function_call', call_id: 'call_4', name: 'shots', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_4', output: many },
      ],
    });
    const sent = upstream.seen.at(-1);
    const carrier = sent.messages.find(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'),
    );
    assert.equal(carrier.content.filter((p) => p.type === 'image_url').length, 8);
    assert.match(JSON.stringify(carrier.content), /3 further image\(s\) omitted/);
  });
});

describe('bridge: prompt ceiling', () => {
  let upstream;
  let bridge;

  before(async () => {
    upstream = await startFakeUpstream();
    bridge = await startBridge(upstream.port, { CCB_MAX_PROMPT_TOKENS: '1000' });
  });

  after(() => {
    bridge?.child.kill();
    upstream?.server.close();
  });

  it('refuses an oversized prompt locally with 413 and a readable message', async () => {
    upstream.seen.length = 0;
    const huge = 'word '.repeat(40_000); // ~50k tokens
    const r = await post(bridge.baseURL, {
      model: 'test-model',
      stream: false,
      input: [{ type: 'message', role: 'user', content: huge }],
    });
    assert.equal(r.status, 413);
    assert.equal(r.body.error.code, 'prompt_too_long');
    assert.match(r.body.error.message, /over the 1000-token ceiling/);
    assert.equal(upstream.seen.length, 0, 'no upstream call may be spent on a local refusal');
  });

  it('lets a normal prompt through', async () => {
    upstream.seen.length = 0;
    const r = await post(bridge.baseURL, {
      model: 'test-model',
      stream: false,
      input: [{ type: 'message', role: 'user', content: 'hello there' }],
    });
    assert.equal(r.status, 200);
    assert.equal(upstream.seen.length, 1);
  });
});
