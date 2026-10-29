/**
 * Dry-run what Claude Desktop will render as the thinking control per model.
 *
 * Desktop never shows an effort control unless it can (a) resolve the row to a
 * built-in Claude family, whose `Kfn` entry supplies the ladder, and (b) attach
 * `thinking.effort_options` through `ipn`, which trims the ladder at the row's
 * `max_effort_level` and moves the "Default" badge onto `defaultModelEffort`.
 * Both steps are reimplemented here so a missing field is caught before a
 * restart, exactly like `check-desktop-picker.mjs` does for the picker itself.
 *
 * Usage:
 *   node scripts/check-desktop-effort.mjs [baseURL] [defaultEffort]
 *   node scripts/check-desktop-effort.mjs http://127.0.0.1:7865 max
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:7865';
const DEFAULT_EFFORT = process.argv[3] ?? 'max';
const KEY = process.env.ANB_API_KEY ?? 'unchecked-by-the-bridge';

// --- lifted from Desktop's bundle (obfuscated names kept so they can be diffed)
const LADDER = ['low', 'medium', 'high', 'xhigh', 'max'];
/** `Kfn` — the built-in ladder per Claude family, with its recommended level. */
const FAMILY_LADDERS = {
  'claude-haiku-4-5': { modes: ['extended'] },
  'claude-sonnet-4-5': { modes: ['extended'] },
  'claude-sonnet-4-6': { effortLevels: ['low', 'medium', 'high', 'max'], recommended: 'low', modes: ['auto'] },
  'claude-sonnet-5': { effortLevels: LADDER, recommended: 'medium', modes: ['auto'] },
  'claude-opus-4-6': { effortLevels: ['low', 'medium', 'high', 'max'], recommended: 'medium', modes: ['extended'] },
  'claude-opus-4-7': { effortLevels: LADDER, recommended: 'xhigh', modes: ['auto'] },
  'claude-opus-4-8': { effortLevels: LADDER, recommended: 'high', modes: ['auto'] },
  'claude-opus-5': { effortLevels: LADDER, recommended: 'high', modes: ['auto'], disallowThinkingDisabled: true },
};

/** `wT` — ladder rank, -1 when the level is not on the ladder. */
const rank = (e) => (e === undefined ? -1 : LADDER.indexOf(e));
/** `rpn` — highest option at or below `limit`. */
const atOrBelow = (options, limit) => {
  const ranked = options.filter((o) => rank(o.id) >= 0).sort((a, b) => rank(b.id) - rank(a.id));
  return ranked.find((o) => rank(o.id) <= limit) ?? ranked.at(-1);
};
/** `$fn` — build `effort_options` from a ladder spec. */
function effortOptions(spec) {
  if (!spec?.effortLevels?.length) return undefined;
  const options = LADDER.filter((l) => spec.effortLevels.includes(l)).map((id) => ({
    id,
    ...(id === spec.recommended ? { recommended: true, badge: { message: 'Default', variant: 'neutral' } } : {}),
  }));
  return options.length ? options : undefined;
}
/** `apn` — ladder for a Claude family id, the only source Desktop has. */
const familyOptions = (id) => effortOptions(FAMILY_LADDERS[id]);
/** `ipn` — trim the ladder at `max_effort_level` and re-badge the default. */
function attach(options, { maxEffort, defaultEffort }) {
  if (!options?.length) return options;
  const top = rank(maxEffort);
  const fallback = rank(defaultEffort);
  if (top < 0 && fallback < 0) return options;
  const trimmed = top < 0 ? options : options.filter((o) => rank(o.id) >= 0 && rank(o.id) <= top);
  if (trimmed.length === 0) return options;
  const previously = trimmed.find((o) => o.recommended);
  const chosen = atOrBelow(trimmed, fallback >= 0 ? fallback : previously ? rank(previously.id) : Infinity) ?? previously;
  return trimmed.map((o) => (o === chosen ? { ...o, recommended: true } : { ...o, recommended: undefined }));
}

// --- probe -----------------------------------------------------------------
const r = await fetch(`${BASE}/v1/models?limit=1000`, { headers: { 'x-api-key': KEY } });
if (!r.ok) {
  console.error(`GET /v1/models -> HTTP ${r.status}`);
  console.error((await r.text()).slice(0, 400));
  process.exit(1);
}
const rows = (await r.json()).data ?? [];
if (rows.length === 0) {
  console.error('no models returned — is the bridge running?');
  process.exit(1);
}

let missingFamily = 0;
let missingLadder = 0;
const report = rows.map((m) => {
  const entry = {
    label: m.display_name ?? m.id,
    family: m.behaves_as,
    window: m.max_input_tokens,
    is1m: m.prefer_1m === true || m.max_input_tokens >= 1e6,
    maxEffort: m.max_effort_level,
  };
  if (!m.behaves_as) {
    missingFamily += 1;
    return { ...entry, options: undefined, note: 'no behaves_as → Desktop shows no thinking UI at all' };
  }
  const base = familyOptions(m.behaves_as);
  if (!base) {
    missingFamily += 1;
    return { ...entry, options: undefined, note: `behaves_as "${m.behaves_as}" is not a family Desktop knows` };
  }
  const options = attach(base, { maxEffort: m.max_effort_level, defaultEffort: DEFAULT_EFFORT });
  if (!options?.length) {
    missingLadder += 1;
    return { ...entry, options, note: 'ladder trimmed to nothing' };
  }
  return { ...entry, options };
});

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
console.log(`${pad('model', 30)} ${pad('window', 9)} ${pad('1m', 4)} ${pad('max', 6)} default  ladder`);
for (const e of report) {
  const opts = e.options ? e.options.map((o) => (o.recommended ? `[${o.id}]` : o.id)).join(' ') : '—';
  const win = e.window ? `${Math.round(e.window / 1000)}k` : '(200k default)';
  console.log(`${pad(e.label, 30)} ${pad(win, 9)} ${pad(e.is1m ? 'yes' : '', 4)} ${pad(e.maxEffort ?? '—', 6)} ${pad(e.options?.find((o) => o.recommended)?.id ?? '—', 8)} ${opts}`);
  if (e.note) console.log(`${' '.repeat(31)}↳ ${e.note}`);
}

const ok = missingFamily === 0 && missingLadder === 0;
console.log(`\n${ok ? 'OK' : 'MISSING'} — ${rows.length} model(s); ${missingFamily} without a resolvable family, ${missingLadder} without a ladder`);
process.exitCode = ok ? 0 : 1;
