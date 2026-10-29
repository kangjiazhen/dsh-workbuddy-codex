/**
 * End-to-end check: speak Anthropic Messages to the bridge, the way Claude
 * Desktop (3p mode) does, and print what comes back.
 *
 * Covers the three paths Desktop exercises on its own:
 *   1. plain streaming turn      -> `message_start` / `content_block_delta` / `message_stop`
 *   2. tool_use round trip       -> the model asks, we answer, it concludes
 *   3. alias resolution          -> a bare `claude-sonnet-*` id still lands on a real model
 *
 * Usage: node scripts/check-anthropic-e2e.mjs [baseURL]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:7865';
const HEADERS = {
  'content-type': 'application/json',
  'x-api-key': 'dsh-workbuddy-codex-local-bridge',
  'anthropic-version': '2023-06-01',
};

/** Read an SSE body into a list of `event:`/`data:` pairs. */
async function sse(path, body) {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  if (!r.ok) return { ok: false, status: r.status, text: await r.text() };
  const text = await r.text();
  const events = [];
  for (const chunk of text.split('\n\n')) {
    const name = /^event: (.+)$/m.exec(chunk)?.[1];
    const data = /^data: (.+)$/m.exec(chunk)?.[1];
    if (data) events.push({ name, data: JSON.parse(data) });
  }
  return { ok: true, events };
}

/** Join the text deltas of a message. */
function textOf(events) {
  return events
    .filter((e) => e.name === 'content_block_delta' && e.data.delta?.type === 'text_delta')
    .map((e) => e.data.delta.text)
    .join('');
}

// --- 1. model list, the way Desktop asks for it ---------------------------
const modelsRes = await fetch(`${BASE}/v1/models?limit=1000`, { headers: HEADERS });
const models = (await modelsRes.json()).data ?? [];
const ids = models.map((m) => m.id);
console.log(`models: HTTP ${modelsRes.status}, ${models.length} rows, all claude-*: ${ids.every((i) => i.startsWith('claude-'))}`);

// --- 2. a plain streaming turn -------------------------------------------
const model = ids[0];
console.log(`\n[1] streaming turn on ${model}`);
const plain = await sse('/v1/messages', {
  model,
  max_tokens: 64,
  stream: true,
  messages: [{ role: 'user', content: 'Reply with exactly: bridge ok' }],
});
if (!plain.ok) {
  console.log(`  HTTP ${plain.status}: ${plain.text.slice(0, 400)}`);
} else {
  const kinds = [...new Set(plain.events.map((e) => e.name))];
  console.log(`  events : ${kinds.join(', ')}`);
  console.log(`  text   : ${JSON.stringify(textOf(plain.events).slice(0, 120))}`);
  const stop = plain.events.at(-1);
  console.log(`  ended  : ${stop?.name} (stop_reason=${plain.events.find((e) => e.name === 'message_delta')?.data.delta?.stop_reason ?? '?'})`);
  const usage = plain.events.find((e) => e.name === 'message_delta')?.data.usage;
  console.log(`  usage  : ${usage ? JSON.stringify(usage) : 'none reported'}`);
}

// --- 3. a tool_use round trip --------------------------------------------
console.log('\n[2] tool_use round trip');
const tool = {
  name: 'get_time',
  description: 'Return the current time in a named timezone.',
  input_schema: {
    type: 'object',
    properties: { timezone: { type: 'string' } },
    required: ['timezone'],
  },
};
const first = await sse('/v1/messages', {
  model,
  max_tokens: 256,
  stream: true,
  tools: [tool],
  messages: [{ role: 'user', content: 'What time is it in Asia/Shanghai? Use the tool.' }],
});
if (!first.ok) {
  console.log(`  HTTP ${first.status}: ${first.text.slice(0, 400)}`);
} else {
  const block = first.events.find((e) => e.name === 'content_block_start' && e.data.content_block?.type === 'tool_use');
  const stop = first.events.find((e) => e.name === 'message_delta')?.data.delta?.stop_reason;
  console.log(`  stop_reason : ${stop}`);
  if (!block) {
    console.log('  no tool_use block — model answered in text instead');
    console.log(`  text        : ${JSON.stringify(textOf(first.events).slice(0, 160))}`);
  } else {
    const tu = block.data.content_block;
    const args = first.events
      .filter((e) => e.name === 'content_block_delta' && e.data.delta?.type === 'input_json_delta')
      .map((e) => e.data.delta.partial_json)
      .join('');
    console.log(`  tool_use    : ${tu.name} (id=${tu.id})`);
    console.log(`  arguments   : ${args || '{}'}`);

    const second = await sse('/v1/messages', {
      model,
      max_tokens: 128,
      stream: true,
      tools: [tool],
      messages: [
        { role: 'user', content: 'What time is it in Asia/Shanghai? Use the tool.' },
        { role: 'assistant', content: [{ type: 'tool_use', id: tu.id, name: tu.name, input: JSON.parse(args || '{}') }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu.id, content: '2026-10-29T10:00:00+08:00' }] },
      ],
    });
    if (!second.ok) {
      console.log(`  follow-up HTTP ${second.status}: ${second.text.slice(0, 400)}`);
    } else {
      console.log(`  follow-up   : ${JSON.stringify(textOf(second.events).slice(0, 160))}`);
    }
  }
}

// --- 4. alias resolution --------------------------------------------------
console.log('\n[3] bare Claude alias');
for (const alias of ['claude-sonnet-4-5', 'opus', 'haiku']) {
  const r = await sse('/v1/messages', {
    model: alias,
    max_tokens: 16,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  });
  const routed = r.ok
    ? (r.events.find((e) => e.name === 'message_start')?.data.message?.model ?? '?')
    : `HTTP ${r.status} ${r.text.slice(0, 120)}`;
  console.log(`  ${alias.padEnd(18)} -> ${routed}`);
}
