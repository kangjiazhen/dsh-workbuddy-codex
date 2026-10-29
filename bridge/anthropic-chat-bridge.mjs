#!/usr/bin/env node
/**
 * anthropic-chat-bridge — Anthropic Messages  <->  WorkBuddy (OpenAI Chat Completions)
 * ----------------------------------------------------------------------------------
 * Claude Code / Claude Desktop (3p mode) speak the Anthropic Messages wire:
 *
 *     GET  {base}/v1/models
 *     POST {base}/v1/messages                 (SSE when stream:true)
 *     POST {base}/v1/messages/count_tokens
 *     headers: anthropic-version, x-api-key | authorization
 *
 * The WorkBuddy gateway (wb2api) speaks OpenAI Chat Completions only. This
 * process is the missing translation layer, exactly like
 * `codex-chat-bridge.mjs` is for the Responses wire:
 *
 *     Claude Desktop --(Anthropic Messages)--> bridge:7865 --(ChatCompletions)--> gateway:7863
 *
 * Three things here are not cosmetic:
 *
 * 1. Model IDs must look like Claude's. Desktop 3p filters every id through an
 *    allowlist (`No()`): an id containing another vendor's brand token
 *    (kimi, glm, gpt, deepseek, …) is dropped from the picker unless it also
 *    carries `anthropic_family_tier`, and a provider check drops it again
 *    regardless. So this bridge exposes stable synthetic ids
 *    (`claude-wb-<hash of the real id>`) and keeps the real gateway id on the
 *    private side of the translation. The dropdown shows the friendly name.
 * 2. `metadata.conversation_id` must be present upstream. Without it the
 *    gateway silently omits `X-Conversation-ID`, the international upstream
 *    answers `400 / 11-128`, and wb2api classifies that as an account fault and
 *    *disables the account pool*. A stable per-conversation id is derived here.
 * 3. Tool results may carry images. Stringifying them re-inflates a screenshot
 *    into hundreds of thousands of tokens, so images are hoisted into a
 *    following user message instead (same trick as the Codex bridge).
 */

import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.1.0';
const SERVICE = 'anthropic-chat-bridge';
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ */
/* argv / env                                                         */
/* ------------------------------------------------------------------ */

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

const args = parseArgv(process.argv.slice(2));

if (args.help || args.h) {
  console.log(`anthropic-chat-bridge ${VERSION}

Usage: node bridge/anthropic-chat-bridge.mjs [options]

  --port <n>              listen port                 (default 7865, env ANB_PORT)
  --host <addr>           listen address              (default 127.0.0.1, env ANB_HOST)
  --upstream <url>        gateway base URL            (default http://127.0.0.1:7863/v1, env ANB_UPSTREAM)
  --api-key <key>         gateway bearer              (env ANB_API_KEY)
  --gateway-config <path> gateway config.json to read the bearer from
  --default-model <id>    model used for Claude-style alias ids
  --capture <dir>         write every inbound/outbound body there
  --no-usage              do not ask upstream for stream usage
`);
  process.exit(0);
}

/** Strip trailing slashes and guarantee exactly one trailing /v1. */
function normalizeBase(raw) {
  const t = String(raw || '').trim().replace(/\/+$/, '');
  if (!t) throw new Error('upstream must be non-empty');
  return /\/v1$/.test(t) ? t : `${t}/v1`;
}

const BASE = normalizeBase(args.upstream || process.env.ANB_UPSTREAM || 'http://127.0.0.1:7863/v1');
const PORT = Number(args.port || process.env.ANB_PORT || 7865);
const HOST = String(args.host || process.env.ANB_HOST || '127.0.0.1');
const CAPTURE = String(args.capture || process.env.ANB_CAPTURE || '');
const INCLUDE_USAGE = process.env.ANB_INCLUDE_USAGE !== '0' && args['no-usage'] !== true;
const TIMEOUT_MS = Number(process.env.ANB_TIMEOUT_MS || 900_000);

/**
 * Read the bearer out of the gateway's own config.json.
 *
 * The gateway answers 401 without it, and asking the user to copy the secret
 * into a second file invites drift. Search order: explicit flag, env, the
 * sibling gateway folder in this workspace, then the plugin's own config dir.
 */
function resolveApiKey() {
  const direct = args['api-key'] || process.env.ANB_API_KEY;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();

  const candidates = [];
  const explicit = args['gateway-config'] || process.env.ANB_GATEWAY_CONFIG;
  if (explicit) candidates.push(String(explicit));
  candidates.push(resolve(PLUGIN_ROOT, '..', 'workbuddy2api-panel', 'config.json'));
  candidates.push(resolve(PLUGIN_ROOT, '..', 'workbuddy-api', 'config.json'));

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
      const key = parsed?.api_key ?? parsed?.apiKey;
      if (typeof key === 'string' && key.trim()) {
        log(`bearer read from ${p}`);
        return key.trim();
      }
    } catch { /* try the next candidate */ }
  }
  log('WARNING: no gateway bearer found — every upstream call will answer 401');
  return '';
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

const API_KEY = resolveApiKey();

let captureN = 0;
if (CAPTURE) { try { mkdirSync(CAPTURE, { recursive: true }); } catch { /* best effort */ } }
function capture(kind, payload) {
  if (!CAPTURE) return;
  try {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    writeFileSync(join(CAPTURE, `${kind}-${String(++captureN).padStart(3, '0')}.json`), body);
  } catch { /* best effort */ }
}

/* ------------------------------------------------------------------ */
/* model catalog                                                      */
/* ------------------------------------------------------------------ */

const ANON_PREFIX = 'claude-wb-';
const ANON_RE = /^claude-wb-[0-9a-f]{6,}$/i;

/**
 * Synthetic id for a gateway model.
 *
 * It must not carry any other vendor's brand token (Desktop's `No()` filter
 * drops those) and must look Claude-ish (`claude…`) to survive the provider
 * check, so the readable part of the real id is *hashed away* and the human
 * name is carried by `display_name` instead.
 */
function anonIdFor(realId) {
  return ANON_PREFIX + createHash('sha1').update(String(realId)).digest('hex').slice(0, 10);
}

function vendorPrefix(realId) {
  const i = realId.indexOf(':');
  if (i < 0) return '';
  const v = realId.slice(0, i).toLowerCase();
  if (v === 'cn') return 'CN · ';
  if (v === 'global') return 'Global · ';
  return `${realId.slice(0, i)} · `;
}

function friendlyName(m) {
  const raw = (m?.name || String(m?.id || '')).trim() || String(m?.id || '');
  return `${vendorPrefix(String(m?.id || ''))}${raw}`.slice(0, 200);
}

/**
 * Distinguishing tail of a real id, e.g. `cn:hy3-x` → `x`.
 *
 * The gateway ships several *different* models under one display name
 * (`cn:hy3` / `cn:hy3-x`, `cn:hy4-preview` / `cn:hy4-preview-f`, …). Desktop's
 * picker merges rows whose `name` + Anthropic family match, so keeping the bare
 * name would silently hide all but one of each pair. The tail is what the two
 * ids differ by, which is also what the user needs to tell them apart.
 */
function nameSuffix(m) {
  const id = String(m?.id || '');
  const base = (m?.name || '').trim().toLowerCase().replace(/[\s·]+/g, '-');
  const tail = id.split(':').pop().toLowerCase();
  if (!base) return tail;
  if (!tail.startsWith(base)) return tail;
  return tail.slice(base.length).replace(/^-+/, '');
}

/**
 * Picker label for a model.
 *
 * `disambiguate` is set when another model in the same catalog already owns
 * this exact name; only then is the id tail appended, so the common case stays
 * as clean as the gateway's own naming.
 */
function labelFor(m, disambiguate = false) {
  const base = friendlyName(m);
  if (!disambiguate) return base;
  const suffix = nameSuffix(m);
  return (suffix ? `${base} (${suffix})` : base).slice(0, 200);
}

function shortDescription(m) {
  const bits = [];
  const id = String(m?.id || '');
  if (id) bits.push(id);
  if (m?.credits) bits.push(`credits ${m.credits}`);
  const ctx = Number(m?.context_length);
  if (Number.isFinite(ctx) && ctx > 0) bits.push(`${Math.round(ctx / 1000)}k ctx`);
  if (m?.supports_images) bits.push('vision');
  return bits.join(' · ').slice(0, 100);
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Ascending effort ladder — `low` first, `max` last. */
function highestEffort(efforts) {
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined;
  return efforts.slice().sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b)).at(-1);
}

/**
 * Input window the gateway advertises, in tokens.
 *
 * Desktop decides "is this a 1M model?" with `number >= 1e6`, and it silently
 * substitutes 200 000 for a row that says nothing, so the number has to travel.
 */
function contextWindowOf(m) {
  for (const raw of [m?.context_length, m?.max_allowed_size]) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

/**
 * Effort ladder a gateway row offers, ascending.
 *
 * Most rows publish `reasoning_supported_efforts`; a few reasoning rows only
 * publish the single `reasoning_effort` scalar. Taking those at face value left
 * them with no ladder at all, which costs them both the effort selector in
 * Desktop and the "highest effort by default" rule — the two rows affected here
 * are reasoning-only models that accept the entire ladder (verified against the
 * live gateway), so an undeclared ladder expands to all of it rather than none.
 */
function effortsOf(m) {
  const declared = Array.isArray(m?.reasoning_supported_efforts)
    ? m.reasoning_supported_efforts.filter((e) => EFFORTS.includes(e))
    : [];
  if (declared.length) {
    return declared.slice().sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
  }
  return m?.supports_reasoning === true ? EFFORTS.slice() : undefined;
}

/**
 * Claude model a reasoning row claims to behave like.
 *
 * Desktop only renders an effort selector for ids it can resolve to a built-in
 * Claude family (`claude-<tier>-<version>`); everything else gets no thinking
 * UI at all. Synthetic ids have the real gateway id hashed out of them, so the
 * family has to be declared separately — and the declaration is also what
 * supplies the effort ladder (`Kfn`), which is why one alias covers both the
 * "max by default" and "selector appears" requirements.
 */
const FAMILY_ALIAS = 'claude-sonnet-5';

let CATALOG = { list: [], byAnon: new Map(), byReal: new Map(), fetchedAt: 0, error: null };

function ingestCatalog(models) {
  const list = [];
  const byAnon = new Map();
  const byReal = new Map();
  // Labels are only unique within the catalog, so count them up front: a name
  // shared by two real ids needs its suffix added to *both*.
  const labelCount = new Map();
  for (const m of models) {
    if (!m || typeof m.id !== 'string' || !m.id) continue;
    const base = friendlyName(m);
    labelCount.set(base, (labelCount.get(base) ?? 0) + 1);
  }
  for (const m of models) {
    if (!m || typeof m.id !== 'string' || !m.id) continue;
    if (byReal.has(m.id)) continue;
    const real = m.id;
    let anon = anonIdFor(real);
    // Astronomically unlikely, but never hand out a colliding id.
    let salt = 0;
    while (byAnon.has(anon) && byAnon.get(anon).real !== real) {
      salt += 1;
      anon = ANON_PREFIX + createHash('sha1').update(`${real}#${salt}`).digest('hex').slice(0, 10);
    }
    const efforts = effortsOf(m);
    const entry = {
      real,
      anon,
      label: labelFor(m, (labelCount.get(friendlyName(m)) ?? 1) > 1),
      description: shortDescription(m),
      maxOutput: Number(m.max_output_tokens) || undefined,
      // Desktop reads `max_input_tokens` off /v1/models and otherwise falls back
      // to its built-in 200 000 default; the gateway advertises the real window.
      contextWindow: contextWindowOf(m),
      efforts,
      maxEffort: highestEffort(efforts),
      // A reasoning model gets a Claude family alias so Desktop can attach the
      // effort ladder it has no other way of learning about (see exposesRow()).
      behavesAs: efforts ? FAMILY_ALIAS : undefined,
      supportsTools: m.supports_tool_call !== false,
    };
    list.push(entry);
    byAnon.set(anon, entry);
    byReal.set(real, entry);
  }
  CATALOG = { list, byAnon, byReal, fetchedAt: Date.now(), error: null };
  log(`catalog: ${list.length} models`);
  return CATALOG;
}

async function upstreamJson(path, init = {}) {
  const headers = { ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}), ...(init.headers || {}) };
  const r = await fetch(path.startsWith('http') ? path : `${BASE}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(init.timeoutMs || 30_000),
  });
  const text = await r.text();
  if (!r.ok) {
    const e = new Error(`upstream ${r.status}: ${text.slice(0, 400)}`);
    e.status = r.status;
    e.body = text;
    throw e;
  }
  try { return JSON.parse(text); } catch { throw new Error(`upstream returned non-JSON: ${text.slice(0, 200)}`); }
}

async function catalog({ force = false } = {}) {
  const fresh = CATALOG.fetchedAt > 0 && Date.now() - CATALOG.fetchedAt < 60_000;
  if (!force && fresh) return CATALOG;
  try {
    const body = await upstreamJson('/models');
    const models = Array.isArray(body?.data) ? body.data : [];
    if (models.length === 0) {
      if (CATALOG.list.length > 0) return CATALOG;
      throw new Error('gateway listed no models');
    }
    return ingestCatalog(models);
  } catch (e) {
    if (CATALOG.list.length > 0) {
      log(`catalog refresh failed (${e.message}); keeping ${CATALOG.list.length} cached models`);
      return CATALOG;
    }
    CATALOG = { ...CATALOG, error: e.message };
    log(`catalog unavailable: ${e.message}`);
    throw e;
  }
}

/** Resolve an inbound model id to a gateway model. */
function resolveModel(rawId) {
  const raw = String(rawId || '').trim();
  const stripped = raw.replace(/\[1m\]$/i, '');
  const hit = CATALOG.byAnon.get(stripped) || CATALOG.byReal.get(stripped);
  if (hit) return hit;
  // Claude-style alias (claude-sonnet-5, sonnet, opus…) — Desktop or the CLI
  // may ask for one when the picker was never touched.
  const alias = /^(?:claude-)?(sonnet|opus|haiku|fable|mythos)(?:[-\d.]+)?$/i.test(stripped);
  const fallback = CATALOG.byReal.get(String(args['default-model'] || process.env.ANB_DEFAULT_MODEL || ''))
    || CATALOG.list[0];
  if (alias && fallback) {
    log(`model alias "${raw}" -> ${fallback.real}`);
    return fallback;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Anthropic request  ->  Chat Completions request                      */
/* ------------------------------------------------------------------ */

const DATA_URL = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

function textOf(blocks) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b && (b.type === 'text' || b.type === 'output_text'))
    .map((b) => b.text ?? '')
    .join('');
}

/** System prompt: string, or an array of text blocks (each may carry cache_control). */
function systemText(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .map((b) => (typeof b === 'string' ? b : (b?.text ?? '')))
    .filter(Boolean)
    .join('\n\n');
}

function imagePart(block) {
  const src = block?.source;
  if (!src) return undefined;
  if (src.type === 'base64' && src.data) {
    return { type: 'image_url', image_url: { url: `data:${src.media_type || 'image/png'};base64,${src.data}` } };
  }
  if (src.type === 'url' && src.url) return { type: 'image_url', image_url: { url: src.url } };
  return undefined;
}

/**
 * Anthropic `tools[]` -> Chat Completions `tools[]`.
 * The JSON-Schema is passed through: Anthropic's `input_schema` is a plain
 * object schema, which is exactly what `parameters` wants.
 */
function convertTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const name = t.name || t?.function?.name;
    if (!name) continue;
    out.push({
      type: 'function',
      function: {
        name,
        description: t.description || t?.function?.description || '',
        parameters: t.input_schema || t?.function?.parameters || { type: 'object', properties: {} },
      },
    });
  }
  return out.length ? out : undefined;
}

function convertToolChoice(tc) {
  if (!tc) return undefined;
  if (typeof tc === 'string') {
    if (tc === 'any') return 'required';
    if (tc === 'auto' || tc === 'none') return tc;
    return 'auto';
  }
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'none') return 'none';
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } };
  return 'auto';
}

const NOTE_MOVED_IMAGES = (n) => `[${n} image${n === 1 ? '' : 's'} attached in the next user `
  + 'message: a tool message carries text only]';

/** Images moved out of tool results, flushed once at the end of the turn. */
const hoistQueue = [];

/**
 * Anthropic `messages[]` -> Chat Completions `messages[]`.
 *
 * The structural work: `tool_use` blocks become `assistant.tool_calls`, and
 * `tool_result` blocks become `role:"tool"` messages paired by id. Tool results
 * that carry images are split out into a following user message, because a
 * `tool` message is text-only upstream.
 */
function convertMessages(messages) {
  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const content = msg.content;

    if (typeof content === 'string') {
      out.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (role === 'assistant') {
      const texts = [];
      const calls = [];
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') texts.push(b.text ?? '');
        else if (b.type === 'tool_use') {
          calls.push({
            id: b.id || `call_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        }
        // thinking / redacted_thinking: not replayable on the Chat wire.
      }
      const joined = texts.join('');
      if (calls.length === 0) { out.push({ role: 'assistant', content: joined }); continue; }
      out.push({
        role: 'assistant',
        content: joined.trim() ? joined : null,
        tool_calls: calls,
      });
      continue;
    }

    // user
    const toolMsgs = [];
    const parts = [];
    let hoisted = 0;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_result') {
        const inner = b.content;
        let text = '';
        const imgs = [];
        if (typeof inner === 'string') text = inner;
        else if (Array.isArray(inner)) {
          for (const ib of inner) {
            if (!ib || typeof ib !== 'object') continue;
            if (ib.type === 'text') text += ib.text ?? '';
            else if (ib.type === 'image') {
              const p = imagePart(ib);
              if (p) imgs.push(p);
            }
          }
        }
        if (imgs.length > 0) {
          hoisted += imgs.length;
          text += `\n\n${NOTE_MOVED_IMAGES(imgs.length)}`;
          hoistQueue.push(...imgs);
        }
        toolMsgs.push({
          role: 'tool',
          tool_call_id: b.tool_use_id || '',
          content: text || (b.is_error ? '[tool error with no message]' : ''),
        });
      } else if (b.type === 'text') {
        parts.push({ type: 'text', text: b.text ?? '' });
      } else if (b.type === 'image') {
        const p = imagePart(b);
        if (p) parts.push(p);
      }
      // document / search_result / etc: flattened to text if they have any.
      else if (b.type === 'document' && typeof b.title === 'string') {
        parts.push({ type: 'text', text: b.title });
      }
    }
    out.push(...toolMsgs);

    const onlyText = parts.every((p) => p.type === 'text');
    if (parts.length === 1 && onlyText) out.push({ role: 'user', content: parts[0].text });
    else if (parts.length > 0) out.push({ role: 'user', content: parts });
  }

  if (hoistQueue.length > 0) {
    out.push({ role: 'user', content: [...hoistQueue] });
    hoistQueue.length = 0;
  }
  return out;
}

/**
 * Pick a `reasoning_effort` the target model actually accepts.
 *
 * The gateway rejects (or silently ignores) an effort the model does not list,
 * so an unsupported request is walked down to the nearest supported level
 * rather than passed through verbatim.
 *
 * An *unstated* effort resolves to the model's highest level. Desktop and the
 * CLI only send `output_config.effort` once the user has touched the selector,
 * so "nothing asked for" is the common case, and the product decision here is
 * that a reasoning model should think as hard as it can by default.
 */
function chooseEffort(entry, wanted) {
  const supported = entry?.efforts;
  if (!Array.isArray(supported) || supported.length === 0) return undefined;
  const want = String(wanted || '').trim().toLowerCase();
  if (want && supported.includes(want)) return want;
  const from = EFFORTS.indexOf(want);
  if (from >= 0) {
    for (let i = from; i >= 0; i -= 1) if (supported.includes(EFFORTS[i])) return EFFORTS[i];
  }
  for (let i = EFFORTS.length - 1; i >= 0; i -= 1) if (supported.includes(EFFORTS[i])) return EFFORTS[i];
  return supported[0];
}

/** Every way Claude Code states "think harder", in priority order. */
function wantedEffort(body) {
  const direct = body?.output_config?.effort;
  if (typeof direct === 'string' && direct.trim()) return direct.trim().toLowerCase();
  const budget = Number(body?.thinking?.budget_tokens);
  if (Number.isFinite(budget) && budget > 0) {
    if (budget >= 64_000) return 'max';
    if (budget >= 32_000) return 'xhigh';
    if (budget >= 24_000) return 'high';
    if (budget >= 8_000) return 'medium';
    return 'low';
  }
  if (typeof body?.reasoning_effort === 'string' && body.reasoning_effort.trim()) {
    return body.reasoning_effort.trim().toLowerCase();
  }
  return undefined;
}

/** A stable per-conversation id; see the header comment for why it is mandatory. */
function conversationIdFor(body, req) {
  const header = req.headers['x-claude-code-session-id'] || req.headers['x-session-id'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const uid = body?.metadata?.user_id;
  if (typeof uid === 'string' && uid.trim()) {
    try {
      const parsed = JSON.parse(uid);
      if (parsed?.session_id) return String(parsed.session_id);
    } catch { /* user_id is not always JSON */ }
  }
  const sys = systemText(body?.system).slice(0, 800);
  const firstUser = (() => {
    const m = Array.isArray(body?.messages) ? body.messages.find((x) => x?.role === 'user') : undefined;
    return m ? textOf(m.content).slice(0, 800) : '';
  })();
  if (sys || firstUser) {
    return `wb-${createHash('sha1').update(`${sys}\u0000${firstUser}`).digest('hex').slice(0, 24)}`;
  }
  return randomUUID();
}

function toChatRequest(body, req, entry) {
  const chat = {
    model: entry.real,
    messages: convertMessages(body.messages || []),
    // Anthropic semantics: `stream` defaults to false. Some clients (notably
    // the desktop app's config-health probe) omit it entirely and then parse
    // the reply with `res.json()`; answering those with SSE makes the probe
    // fail with "unparseable completion body".
    stream: body.stream === true,
  };
  if (INCLUDE_USAGE && chat.stream) chat.stream_options = { include_usage: true };

  const sys = systemText(body.system);
  if (sys.trim()) chat.messages.unshift({ role: 'system', content: sys });

  chat.metadata = { conversation_id: conversationIdFor(body, req) };

  const tools = convertTools(body.tools);
  if (tools) {
    chat.tools = tools;
    chat.tool_choice = convertToolChoice(body.tool_choice) ?? 'auto';
    if (body.disable_parallel_tool_use === true) chat.parallel_tool_calls = false;
  }

  const maxTokens = Number(body.max_tokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    const cap = entry.maxOutput;
    chat.max_tokens = cap && maxTokens > cap ? cap : maxTokens;
  }
  if (body.temperature !== undefined) chat.temperature = body.temperature;
  if (body.top_p !== undefined) chat.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) chat.stop_sequences = body.stop_sequences;

  if (body?.thinking?.type !== 'disabled') {
    const effort = chooseEffort(entry, wantedEffort(body));
    if (effort) chat.reasoning_effort = effort;
  }

  return chat;
}

/* ------------------------------------------------------------------ */
/* Chat Completions  ->  Anthropic Messages                            */
/* ------------------------------------------------------------------ */

const STOP_REASONS = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  length: 'max_tokens',
  content_filter: 'end_turn',
};

function stopReasonFor(finish) {
  return STOP_REASONS[finish] || 'end_turn';
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const newId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

function usageFrom(u) {
  if (!u || typeof u !== 'object') return undefined;
  const out = {
    input_tokens: Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0,
    output_tokens: Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0,
  };
  const cacheRead = Number(u.prompt_cache_hit_tokens ?? u.cache_read_input_tokens ?? 0) || 0;
  const cacheWrite = Number(u.prompt_cache_write_tokens ?? u.cache_creation_input_tokens ?? 0) || 0;
  if (cacheRead) out.cache_read_input_tokens = cacheRead;
  if (cacheWrite) out.cache_creation_input_tokens = cacheWrite;
  return out;
}

/**
 * Translate a `chat.completion.chunk` stream into the Anthropic SSE sequence.
 *
 *   message_start
 *   -> [content_block_start / *_delta* / content_block_stop]   (thinking, text, tool_use)
 *   -> message_delta (stop_reason + usage)
 *   -> message_stop
 *
 * Blocks are emitted in the order they first appear, and a block is closed
 * before the next one opens — Anthropic's client accumulates per index and
 * rejects interleaved indices.
 */
async function pipeChatStream(upstream, res, requestedModel, chatReq) {
  const msgId = newId('msg');
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-bridge': SERVICE,
  });

  let blockIndex = -1;
  let open = null; // {kind, index, toolIndex?}
  let started = false;
  let finish = null;
  let usage;

  const startMessage = () => {
    if (started) return;
    started = true;
    sse(res, 'message_start', {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model: requestedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };

  const closeBlock = () => {
    if (!open) return;
    if (open.kind === 'thinking') {
      // A signature is what lets the client replay the block; we never send it
      // upstream again, but a missing signature makes the CLI warn.
      const sig = createHash('sha1').update(`${msgId}:${open.index}`).digest('base64');
      sse(res, 'content_block_delta', {
        type: 'content_block_delta', index: open.index,
        delta: { type: 'signature_delta', signature: `wb${sig}` },
      });
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: open.index });
    open = null;
  };

  const openBlock = (kind, extra = {}) => {
    closeBlock();
    blockIndex += 1;
    open = { kind, index: blockIndex, ...extra };
    sse(res, 'content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: kind === 'thinking'
        ? { type: 'thinking', thinking: '', signature: '' }
        : kind === 'text'
          ? { type: 'text', text: '' }
          : { type: 'tool_use', id: extra.id, name: extra.name, input: {} },
    });
    return open;
  };

  const toolBlocks = new Map(); // upstream tool index -> state

  const emitToolArgs = (index, args) => {
    if (!args) return;
    sse(res, 'content_block_delta', {
      type: 'content_block_delta', index,
      delta: { type: 'input_json_delta', partial_json: args },
    });
  };

  /**
   * A `tool_calls` delta only carries `index` once the call opens; the name may
   * arrive in that same chunk or a later one. Nothing may be emitted before the
   * name is known (Anthropic's `content_block_start` requires it), so any
   * arguments that arrive first are buffered and flushed when the block opens.
   */
  const onToolDelta = (tc) => {
    const ti = Number.isInteger(tc.index) ? tc.index
      : (toolBlocks.size > 0 ? [...toolBlocks.keys()].at(-1) : 0);
    let st = toolBlocks.get(ti);
    if (!st) { st = { blockIndex: null, id: null, name: '', args: '', opened: false }; toolBlocks.set(ti, st); }
    if (typeof tc.id === 'string' && tc.id) st.id = tc.id;
    if (typeof tc.function?.name === 'string' && tc.function.name) st.name = tc.function.name;

    const args = typeof tc.function?.arguments === 'string' ? tc.function.arguments : '';

    if (!st.opened) {
      if (!st.name) { st.args += args; return; }
      startMessage();
      const block = openBlock('tool_use', { id: st.id || newId('toolu'), name: st.name });
      st.opened = true;
      st.blockIndex = block.index;
      if (st.args) { emitToolArgs(st.blockIndex, st.args); st.args = ''; }
    }
    emitToolArgs(st.blockIndex, args);
  };

  const onDelta = (delta) => {
    if (!delta || typeof delta !== 'object') return;
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      startMessage();
      if (!open || open.kind !== 'thinking') openBlock('thinking');
      sse(res, 'content_block_delta', {
        type: 'content_block_delta', index: open.index,
        delta: { type: 'thinking_delta', thinking: reasoning },
      });
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      startMessage();
      if (!open || open.kind !== 'text') openBlock('text');
      sse(res, 'content_block_delta', {
        type: 'content_block_delta', index: open.index,
        delta: { type: 'text_delta', text: delta.content },
      });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) if (tc && typeof tc === 'object') onToolDelta(tc);
    }
  };

  const decoder = new TextDecoder();
  let buffer = '';
  let sawDone = false;

  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const rawLine = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const line = rawLine.trim();
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { sawDone = true; break; }
        let json;
        try { json = JSON.parse(payload); } catch { continue; }
        const choice = json?.choices?.[0];
        if (json?.usage) usage = usageFrom(json.usage) || usage;
        if (choice?.delta) onDelta(choice.delta);
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (!started) startMessage();
      }
      if (sawDone) break;
    }
  } catch (e) {
    closeBlock();
    sse(res, 'error', {
      type: 'error',
      error: { type: 'api_error', message: `bridge: upstream stream failed: ${e.message}` },
    });
    res.end();
    return;
  }

  startMessage();
  closeBlock();

  const finalUsage = usage || { input_tokens: 0, output_tokens: 0 };
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReasonFor(finish), stop_sequence: null },
    usage: { output_tokens: finalUsage.output_tokens, ...finalUsage },
  });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
  log('stream done', requestedModel, `stop=${stopReasonFor(finish)}`,
    `in=${finalUsage.input_tokens}`, `out=${finalUsage.output_tokens}`);
}

/** Non-streaming: assemble a complete Anthropic `message` object. */
function nonStreamingMessage(json, requestedModel) {
  const choice = json?.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) {
    content.push({ type: 'thinking', thinking: msg.reasoning_content, signature: `wb${newId('sig')}` });
  }
  if (typeof msg.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc?.function?.arguments || '{}'); } catch { input = { __raw: tc?.function?.arguments }; }
      content.push({ type: 'tool_use', id: tc.id || newId('toolu'), name: tc?.function?.name || 'tool', input });
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return {
    id: json?.id ? `msg_${String(json.id).slice(0, 24)}` : newId('msg'),
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: stopReasonFor(choice.finish_reason),
    stop_sequence: null,
    usage: usageFrom(json?.usage) || { input_tokens: 0, output_tokens: 0 },
  };
}

/* ------------------------------------------------------------------ */
/* HTTP                                                               */
/* ------------------------------------------------------------------ */

function readBody(req) {
  return new Promise((resolve_, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve_(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function jsonError(res, status, message, type = 'invalid_request_error') {
  res.writeHead(status, { 'content-type': 'application/json' })
    .end(JSON.stringify({ type: 'error', error: { type, message } }));
}

/** Rough token estimate for `count_tokens`; the upstream has no such endpoint. */
function estimateTokens(body) {
  const sys = systemText(body?.system);
  let chars = sys.length;
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (typeof m?.content === 'string') { chars += m.content.length; continue; }
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content) {
      if (typeof b?.text === 'string') chars += b.text.length;
      else if (typeof b?.content === 'string') chars += b.content.length;
      else if (Array.isArray(b?.content)) chars += textOf(b.content).length;
      else if (b?.type === 'image') chars += 1200; // ~ a mid-size image, not its base64
      else if (b?.type === 'tool_use') chars += JSON.stringify(b.input ?? {}).length;
    }
  }
  if (Array.isArray(body?.tools)) chars += JSON.stringify(body.tools).length;
  return Math.max(1, Math.round(chars / 3.4));
}

const server = createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && (url === '/' || url === '/healthz' || url === '/health')) {
    const c = CATALOG;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      ok: true,
      service: SERVICE,
      version: VERSION,
      upstream: BASE,
      models: c.list.length,
      catalog_age_ms: c.fetchedAt ? Date.now() - c.fetchedAt : null,
      catalog_error: c.error || undefined,
      conversation_id: 'auto',
      effort: 'mapped to model capabilities',
    }));
    return;
  }

  if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
    try {
      const c = await catalog();
      const data = c.list.map((m) => ({
        type: 'model',
        id: m.anon,
        display_name: m.label,
        description: m.description,
        created_at: '2025-01-01T00:00:00Z',
        // Desktop reads these off the discovery row and nothing else:
        //   max_input_tokens   -> the context window it shows (default 200 000
        //                         when absent) and `supports1m` when >= 1e6
        //   max_effort_level   -> the top of the effort ladder it renders; a
        //                         missing value silently means "low"
        //   behaves_as         -> the Claude family whose thinking UI it reuses
        ...(m.contextWindow && { max_input_tokens: m.contextWindow }),
        ...(m.maxOutput && { max_output_tokens: m.maxOutput }),
        ...(m.maxEffort && { max_effort_level: m.maxEffort }),
        ...(m.behavesAs && { behaves_as: m.behavesAs }),
        ...(m.contextWindow >= 1_000_000 && { prefer_1m: true }),
      }));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        data,
        has_more: false,
        first_id: data[0]?.id,
        last_id: data.at(-1)?.id,
      }));
    } catch (e) {
      jsonError(res, 502, `bridge: cannot list models from ${BASE}: ${e.message}`, 'api_error');
    }
    return;
  }

  if (req.method === 'POST' && url === '/v1/messages/count_tokens') {
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch {
      jsonError(res, 400, 'bridge: request body is not valid JSON'); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ input_tokens: estimateTokens(body) }));
    return;
  }

  if (req.method === 'POST' && url === '/v1/messages') {
    const raw = await readBody(req).catch(() => Buffer.alloc(0));
    let body;
    try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch {
      jsonError(res, 400, 'bridge: request body is not valid JSON'); return;
    }
    capture('messages-in', raw.toString('utf8'));

    try { await catalog(); } catch { /* resolveModel falls back to pass-through */ }

    const entry = resolveModel(body.model);
    if (!entry) {
      const known = CATALOG.list.slice(0, 8).map((m) => m.anon).join(', ');
      jsonError(res, 404, `bridge: unknown model "${body.model}". Known ids include: ${known}…`, 'not_found_error');
      return;
    }

    const chatReq = toChatRequest(body, req, entry);
    capture('chat-out', chatReq);

    const wantStream = body.stream === true;
    log(`${wantStream ? 'stream' : 'one-shot'} ->`, entry.real,
      `msgs=${chatReq.messages.length}`, `tools=${chatReq.tools?.length ?? 0}`,
      `effort=${chatReq.reasoning_effort ?? '-'}`);

    let upstream;
    try {
      upstream = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}),
        },
        body: JSON.stringify(chatReq),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      jsonError(res, 502, `bridge: cannot reach upstream ${BASE}: ${e.message}`, 'api_error');
      return;
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      let detail = text.slice(0, 600);
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message || parsed?.msg || parsed?.error || detail;
      } catch { /* keep raw text */ }
      log(`upstream ${upstream.status}: ${String(detail).slice(0, 200)}`);
      const type = upstream.status === 401 || upstream.status === 403 ? 'authentication_error'
        : upstream.status === 429 ? 'rate_limit_error'
          : upstream.status === 400 ? 'invalid_request_error' : 'api_error';
      jsonError(res, upstream.status === 401 ? 401 : 502,
        `bridge: upstream ${upstream.status}: ${detail}`, type);
      return;
    }

    if (wantStream) {
      await pipeChatStream(upstream, res, body.model, chatReq);
      return;
    }

    const text = await upstream.text();
    let json;
    try { json = JSON.parse(text); } catch {
      jsonError(res, 502, `bridge: upstream returned non-JSON: ${text.slice(0, 300)}`, 'api_error');
      return;
    }
    capture('chat-in', json);
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify(nonStreamingMessage(json, body.model)));
    return;
  }

  log('unhandled', req.method, url);
  jsonError(res, 404, `bridge: no route for ${req.method} ${url}`, 'not_found_error');
});

server.listen(PORT, HOST, () => {
  // `--port 0` asks the OS for a free port; report the one actually bound.
  const bound = server.address()?.port ?? PORT;
  log(`${SERVICE} ${VERSION} listening on http://${HOST}:${bound}`);
  log(`upstream ${BASE}  bearer=${API_KEY ? 'set' : 'MISSING'}`);
  catalog().catch((e) => log(`initial catalog failed: ${e.message}`));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { log(`${sig}: shutting down`); server.close(() => process.exit(0)); });
}
