/**
 * Dry-run Claude Desktop 3p's model discovery against a running bridge.
 *
 * Reimplements the parts of Desktop that decide what the model picker shows, so
 * a bad catalog is caught before restarting the app:
 *   - `No(id)`     — the vendor/Anthropic-shape filter applied to every row
 *   - the row builder that reads `display_name` as the label
 *   - the `(name, family)` merge that collapses duplicate rows
 *
 * Exits non-zero when anything Desktop would silently swallow is found — a
 * dropped row, or two models that merge into one entry.
 *
 * Usage:
 *   node scripts/check-desktop-picker.mjs [baseURL] [apiKey]
 *   node scripts/check-desktop-picker.mjs http://127.0.0.1:7865
 *
 * With no arguments it probes the bridge's default port.
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:7865';
const KEY = process.argv[3] ?? 'unchecked-by-the-bridge';

// --- lifted from Desktop's bundle (obfuscated names kept so they can be diffed)
const FAMILIES = ['sonnet', 'opus', 'haiku', 'fable', 'mythos'];
const ANTHROPIC_ALIAS = RegExp(`^(${FAMILIES.join('|')})(-[\\d.]+)?$`);
const ANTHROPIC_TOKENS = ['claude', ...FAMILIES, 'anthropic'];
const OTHER_VENDORS = /ark-code|astron|command-r|deepseek|doubao|gemini|gemma|glm|gpt|grok|hermes|hy3|kimi|lfm|\bling\b|llama|longcat|mimo|minimax|mistral|mixtral|moonshot|nemotron|openai|phi-|qianfan|qwen|tc-code|\bunic\b|yi-|stepfun|step-3|seed-|bytedance|hunyuan|granite|amazon\.nova|nova-|devstral|ministral|ernie/i;

/** Desktop's `No()`: is this an Anthropic-shaped route it will keep? */
function isAnthropicRoute(id) {
  const lower = id.toLowerCase();
  if (OTHER_VENDORS.test(lower)) return false;
  return ANTHROPIC_ALIAS.test(lower) || ANTHROPIC_TOKENS.some((t) => lower.includes(t));
}

/** Desktop's family extraction: what an id says it behaves like. */
function familyOf(row) {
  if (row.anthropic_family_tier) return row.anthropic_family_tier;
  const last = row.id.toLowerCase().split('/').at(-1) ?? '';
  return new RegExp(FAMILIES.join('|')).exec(last)?.[0] ?? '';
}

/** Desktop's merge key: rows sharing it collapse into one picker entry. */
function mergeKey(row) {
  return isAnthropicRoute(row.id) && !row.id.endsWith('[1m]') ? `${row.name}\n${familyOf(row)}` : undefined;
}

// --- the requests Desktop actually makes ----------------------------------
const rows = [];
let afterId;
for (let page = 1; page <= 3; page += 1) {
  const query = `limit=1000${afterId === undefined ? '' : `&after_id=${encodeURIComponent(afterId)}`}`;
  const r = await fetch(`${BASE}/v1/models?${query}`, {
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
  });
  console.log(`page ${page}: HTTP ${r.status}`);
  if (!r.ok) { console.log(await r.text()); break; }
  const body = await r.json();
  if (!Array.isArray(body?.data)) { console.log('unexpected body:', body); break; }
  for (const m of body.data) rows.push({ id: m.id, name: m.display_name ?? m.name ?? m.id, raw: m });
  // Same continuation rule the app uses: only follow an explicit cursor.
  if (!body.next_cursor && !body.has_more) break;
  afterId = body.next_cursor ?? rows.at(-1)?.id;
}
if (rows.length === 0) {
  console.error('\nno models returned — is the bridge running?');
  process.exit(1);
}

// --- Desktop's filtering and merging --------------------------------------
const kept = rows.filter((r) => isAnthropicRoute(r.id));
const dropped = rows.filter((r) => !isAnthropicRoute(r.id));

const seen = new Set();
const unique = kept.filter((r) => !seen.has(r.id) && seen.add(r.id));
const groups = new Map();
for (const r of unique) {
  const key = mergeKey(r);
  if (key === undefined) continue;
  groups.set(key, [...(groups.get(key) ?? []), r]);
}
const collapsed = [...groups].filter(([, g]) => g.length > 1);
const picker = unique.length - collapsed.reduce((n, [, g]) => n + g.length - 1, 0);

// --- report ---------------------------------------------------------------
console.log(`\nrows returned : ${rows.length}`);
console.log(`kept by No()  : ${kept.length}`);
console.log(`dropped       : ${dropped.length}`);
if (dropped.length) console.log('  dropped ids :', dropped.map((d) => d.id).slice(0, 10));
if (collapsed.length) {
  console.log(`\nmerged rows   : ${collapsed.length} group(s)`);
  for (const [key, g] of collapsed) console.log(`  ${JSON.stringify(key)} <- ${g.map((r) => r.id).join(', ')}`);
}
console.log(`\npicker entries: ${picker}`);
console.log('\nfirst 8 the user will see:');
for (const r of unique.slice(0, 8)) console.log(`  ${r.id}  ->  ${r.name}`);

const ok = dropped.length === 0 && collapsed.length === 0;
console.log(`\n${ok ? 'OK' : 'MISMATCH'} — every gateway model ${ok ? 'reaches' : 'does NOT reach'} the picker`);
process.exitCode = ok ? 0 : 1;
