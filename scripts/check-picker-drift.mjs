/**
 * Report picker ids that the gateway no longer serves.
 *
 * The bridge keeps its last good catalog when a refresh comes back empty, which
 * is right — a 503 from the gateway must not blank the picker. But the gateway
 * catalog also *shrinks* in normal operation: an account cools down and only the
 * models that account could serve stay listed. If the bridge then hands out the
 * stale, larger list, the picker offers ids that resolve to nothing upstream.
 *
 * This measures the gap right now: how many ids the bridge advertises, how many
 * the gateway still lists, and how many bridge ids are therefore orphaned.
 *
 * Usage: node scripts/check-picker-drift.mjs [bridgeURL] [gatewayURL]
 */
import { createHash } from 'node:crypto';

const BRIDGE = process.argv[2] ?? 'http://127.0.0.1:7865';
const GATEWAY = process.argv[3] ?? 'http://127.0.0.1:7863';
const GATEWAY_KEY = process.env.WB_API_KEY ?? '';

const anonIdFor = (real) => 'claude-wb-' + createHash('sha1').update(real).digest('hex').slice(0, 10);

async function json(url, headers) {
  const r = await fetch(url, { headers });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return { status: r.status, body };
}

const bridge = await json(`${BRIDGE}/v1/models?limit=1000`, { 'x-api-key': 'probe', 'anthropic-version': '2023-06-01' });
if (bridge.status !== 200) {
  console.error(`bridge /v1/models -> HTTP ${bridge.status}`);
  console.error(JSON.stringify(bridge.body).slice(0, 400));
  process.exit(1);
}
const advertised = (bridge.body.data ?? []).map((m) => ({ id: m.id, label: m.display_name }));

const gateway = await json(`${GATEWAY}/v1/models`, GATEWAY_KEY ? { authorization: `Bearer ${GATEWAY_KEY}` } : {});
const served = gateway.status === 200 ? (gateway.body.data ?? []).map((m) => m.id) : null;

console.log(`bridge advertises : ${advertised.length}`);
if (served === null) {
  console.log(`gateway           : HTTP ${gateway.status} — cannot compare`);
  process.exit(0);
}
console.log(`gateway serves    : ${served.length}`);

const liveIds = new Set(served.map(anonIdFor));
const orphans = advertised.filter((a) => !liveIds.has(a.id));
console.log(`orphaned in picker: ${orphans.length}`);
if (orphans.length) {
  console.log('\nids a user can still pick but the gateway will not serve:');
  for (const o of orphans.slice(0, 10)) console.log(`  ${o.id}  ${o.label}`);
  if (orphans.length > 10) console.log(`  … and ${orphans.length - 10} more`);
  console.log('\nPicking one of these ends in a 502 "unknown model" from the bridge.');
}
process.exitCode = orphans.length === 0 ? 0 : 2;
