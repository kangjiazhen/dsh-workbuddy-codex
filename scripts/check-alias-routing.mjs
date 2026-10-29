/**
 * Resolve a few bare Claude aliases through the bridge and report where they land.
 *
 * Desktop and Claude Code both send short names like `claude-sonnet-4-5` or
 * `opus`; the bridge is supposed to map those onto real catalog ids. This prints
 * the id the upstream actually served, so an alias that silently picks the wrong
 * model is visible.
 *
 * Waits between calls because the gateway queues per account and answers 429
 * `queue.waiting` when three turns are in flight.
 *
 * Usage: node scripts/check-alias-routing.mjs [baseURL]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:7865';
const HEADERS = {
  'content-type': 'application/json',
  'x-api-key': 'dsh-workbuddy-codex-local-bridge',
  'anthropic-version': '2023-06-01',
};

const aliases = process.argv.slice(3);
if (aliases.length === 0) aliases.push('claude-sonnet-4-5', 'opus', 'haiku', 'claude-opus-5-5');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const [i, alias] of aliases.entries()) {
  if (i > 0) await sleep(12_000);
  const body = { model: alias, max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] };
  const r = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) {
    let msg = text.slice(0, 120);
    try { msg = JSON.parse(text).error?.message?.slice(0, 120) ?? msg; } catch {}
    console.log(`${alias.padEnd(20)} HTTP ${r.status}  ${msg}`);
    continue;
  }
  // `message_start` carries the id the upstream really used.
  const served = /"model":"([^"]+)"/.exec(text)?.[1] ?? '(not echoed)';
  console.log(`${alias.padEnd(20)} -> ${served}`);
}
