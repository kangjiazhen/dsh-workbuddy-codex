#!/usr/bin/env node
/**
 * codex-chat-bridge
 * ------------------------------------------------------------------
 * Run OpenAI Codex CLI against ANY OpenAI-compatible /v1/chat/completions
 * backend (Ollama, vLLM, llama.cpp, LM Studio, one-api, LiteLLM, custom
 * gateways, ...).
 *
 * Why this exists
 * ---------------
 * codex-cli >= 0.1xx dropped `wire_api = "chat"` and now speaks ONLY the
 * OpenAI **Responses** API (`POST /v1/responses`, SSE). Plenty of otherwise
 * perfectly good backends still implement only **Chat Completions**
 * (`POST /v1/chat/completions`). This bridge sits in between and translates
 * both the request and the streamed response.
 *
 *   Codex CLI --(Responses)--> this bridge --(ChatCompletions)--> your backend
 *
 * Zero dependencies. Node >= 18 (uses global fetch + ReadableStream).
 *
 * Usage
 * -----
 *   node bin/codex-chat-bridge.mjs [--port 7864] [--upstream http://host:port]
 *   node bin/codex-chat-bridge.mjs --help
 *
 * MIT License.
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION = '0.1.0';

/* ------------------------------------------------------------------ */
/* Config                                                             */
/* ------------------------------------------------------------------ */

const HELP = `codex-chat-bridge ${VERSION}

Translate the OpenAI Responses API (used by Codex CLI) into the
OpenAI Chat Completions API (implemented by most local/self-hosted backends).

Usage
  codex-chat-bridge [options]

Options
  --port <n>            Listen port (default 7864, env CCB_PORT)
  --host <addr>         Listen address (default 127.0.0.1, env CCB_HOST)
  --upstream <url>      Backend base URL, with or without /v1
                        (default http://127.0.0.1:8080, env CCB_UPSTREAM)
  --help, -h            Show this help
  --version, -v         Show version

Environment
  CCB_UPSTREAM           Backend base URL (required unless --upstream)
  CCB_API_KEY            Bearer token sent to the backend
                         (falls back to OPENAI_API_KEY)
  CCB_MODEL_ALLOWLIST    Comma-separated model allowlist. Empty = allow all.
  CCB_MODEL_MAP          Model rewrite map, e.g. "codex=gpt-5.3-codex,fast=x"
  CCB_CONVERSATION_ID    "auto" to derive a conversation id per session and
                         send it as metadata.conversation_id; or a literal id.
                         Unset = do not send metadata.
  CCB_INCLUDE_USAGE      1 (default) to ask the backend for token usage
  CCB_CAPTURE            Directory; dump every inbound Responses request body
  CCB_TIMEOUT_MS         Upstream request timeout (default 600000)
  CCB_MAX_PROMPT_TOKENS  Refuse locally above this estimated prompt size, with
                         a readable 413, instead of letting the upstream answer
                         400 prompt_too_long (which returns no usage and leaves
                         the client unable to compact). Defaults to 1200000,
                         just above the real 1048576 ceiling; 0 = disabled.

Codex config (~/.codex/config.toml)

  model_provider = "bridge"
  [model_providers.bridge]
  name = "bridge"
  base_url = "http://127.0.0.1:7864/v1"
  wire_api = "responses"
  experimental_bearer_token = "anything"
`;

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version' || a === '-v') out.version = true;
    else if (a === '--port') out.port = argv[++i];
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--upstream') out.upstream = argv[++i];
    else if (a.startsWith('--port=')) out.port = a.slice(7);
    else if (a.startsWith('--host=')) out.host = a.slice(7);
    else if (a.startsWith('--upstream=')) out.upstream = a.slice(11);
    else {
      console.error(`unknown argument: ${a}\n`);
      console.error(HELP);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgv(process.argv.slice(2));
if (args.help) { console.log(HELP); process.exit(0); }
if (args.version) { console.log(VERSION); process.exit(0); }

/** Strip trailing slashes and guarantee a single trailing /v1. */
function normalizeBase(raw) {
  const trimmed = String(raw).trim().replace(/\/+$/, '');
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

const UPSTREAM_RAW = args.upstream || process.env.CCB_UPSTREAM || 'http://127.0.0.1:8080';
const BASE = normalizeBase(UPSTREAM_RAW);
const API_KEY = process.env.CCB_API_KEY || process.env.OPENAI_API_KEY || '';
const PORT = Number(args.port || process.env.CCB_PORT || 7864);
const HOST = args.host || process.env.CCB_HOST || '127.0.0.1';
const CAPTURE = process.env.CCB_CAPTURE || '';
const INCLUDE_USAGE = process.env.CCB_INCLUDE_USAGE !== '0';
const TIMEOUT_MS = Number(process.env.CCB_TIMEOUT_MS || 600000);
const CONV_MODE = process.env.CCB_CONVERSATION_ID || '';

/**
 * Fail-fast prompt ceiling, in tokens. `CCB_MAX_PROMPT_TOKENS=0` disables it.
 *
 * Without it an oversized body is still forwarded, the upstream answers 400
 * `prompt_too_long`, and that 400 carries no `usage` — so the client cannot learn
 * how big it really is, keeps resending the same body, and never compacts. The
 * request also burns an upstream account and can trip its rate-limit cooldown.
 * Answering locally with a readable 413 keeps the account untouched and says how
 * much to cut.
 *
 * The default sits just above the real 1,048,576-token upstream ceiling, so an
 * estimate that runs a little high cannot refuse a request that would have fit.
 * It lives here, not in a launcher's environment, on purpose: the bridge is
 * started by the DSH supervisor, by `start-bridge.vbs`, and by hand during
 * debugging, and a launcher-only default silently disarms the tripwire the first
 * time somebody picks a different launch path. Callers that want a different
 * ceiling still override it; `0` turns it off.
 */
const DEFAULT_MAX_PROMPT_TOKENS = 1_200_000;
const MAX_PROMPT_TOKENS = (() => {
  const raw = process.env.CCB_MAX_PROMPT_TOKENS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_PROMPT_TOKENS;
  return Number(raw) || 0;
})();

/** Empty allowlist means "allow everything" — the sane default for a generic bridge. */
const MODEL_ALLOWLIST = new Set(
  (process.env.CCB_MODEL_ALLOWLIST || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
);

/** Optional model rewriting: "from=to,from2=to2". */
const MODEL_MAP = new Map(
  (process.env.CCB_MODEL_MAP || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf('=');
      return i > 0 ? [pair.slice(0, i).trim(), pair.slice(i + 1).trim()] : null;
    })
    .filter(Boolean),
);

const SERVICE = 'codex-chat-bridge';

const log = (...a) => console.log(new Date().toISOString(), ...a);

let captureN = 0;
if (CAPTURE) mkdirSync(CAPTURE, { recursive: true });

/* ------------------------------------------------------------------ */
/* Responses request  ->  Chat Completions request                    */
/* ------------------------------------------------------------------ */

/**
 * Flatten a Responses `content` value (string or array of parts) into either a
 * plain string or a Chat-Completions multimodal array.
 */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text') {
      parts.push(c.text ?? '');
    } else if (c.type === 'refusal') {
      parts.push(c.refusal ?? '');
    } else if (c.type === 'input_image') {
      const url = c.image_url || c.url;
      if (url) parts.push({ __image: url });
    }
  }
  if (parts.every((p) => typeof p === 'string')) return parts.join('');
  return parts.map((p) => (typeof p === 'string'
    ? { type: 'text', text: p }
    : { type: 'image_url', image_url: { url: p.__image } }));
}

/** In-band note that a tool result's images were moved, not lost. */
const omittedImages = (n) => `[${n} image${n === 1 ? '' : 's'} attached in the next user `
  + 'message: a tool message carries text only]';

/**
 * Last line of defence for tool results: strip any inline image data that
 * survived flattening.
 *
 * The shapes above cover what Codex sends today, but an unrecognised shape
 * falling back to `JSON.stringify` would reintroduce the exact bug this file is
 * fixing — and it would be invisible, because the request still succeeds and
 * only the bill changes. A `data:` URL and a long base64 run are both cheap to
 * recognise, so anything left is replaced here rather than trusted.
 */
const DATA_URL = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

function scrubInlineImages(text) {
  const urls = [];
  let scrubbed = 0;
  let out = text.replace(DATA_URL, (m) => { urls.push(m); scrubbed += 1; return ''; });
  out = out.replace(/[A-Za-z0-9+/]{4000,}={0,2}/g, () => { scrubbed += 1; return ''; });
  return { text: out, urls, scrubbed };
}

/**
 * Split a tool result into the text a `role: "tool"` message can carry and the
 * image URLs it cannot.
 *
 * Chat Completions tool messages are text-only, so an image has no slot there.
 * Stringifying instead put the whole data URL into the prompt as literal text,
 * and the upstream tokenizer charged roughly one token per character: one 1080p
 * screenshot measured 280k-594k input tokens, enough to fill a 1M context in a
 * single step. The text is kept verbatim; the images are returned so the caller
 * can hand them to a channel that does accept them.
 *
 * @param {unknown} output A Responses `function_call_output.output`.
 * @returns {{text: string, images: string[]}}
 */
function splitOutput(output) {
  const texts = [];
  const images = [];

  const walk = (v) => {
    if (typeof v === 'string') { texts.push(v); return; }
    if (Array.isArray(v)) { for (const p of v) walk(p); return; }
    if (v && typeof v === 'object') {
      if (v.type === 'input_image' || v.type === 'image_url') {
        // `image_url` is a string in Responses and an object in Chat
        // Completions; accept both so a replayed body works either way.
        const url = typeof v.image_url === 'string'
          ? v.image_url
          : (v.image_url?.url || v.url);
        if (typeof url === 'string' && url) images.push(url);
        return;
      }
      if (typeof v.text === 'string') { texts.push(v.text); return; }
      if (typeof v.output_text === 'string') { texts.push(v.output_text); return; }
      texts.push(JSON.stringify(v));
      return;
    }
    if (v != null) texts.push(String(v));
  };

  walk(output);
  return { text: texts.join('\n'), images };
}

/**
 * How many images from one tool result may be re-attached to the conversation.
 * Each costs a normal vision budget, so a runaway tool cannot inflate the prompt;
 * anything past the cap is reported rather than silently dropped.
 */
const MAX_HOISTED_IMAGES = 8;

/** A user message that re-attaches images a tool result could not carry. */
function imagesAsUserMessage(urls, label) {
  return {
    role: 'user',
    content: [
      { type: 'text', text: `${label} (image${urls.length === 1 ? '' : 's'} from the tool result above)` },
      ...urls.map((url) => ({ type: 'image_url', image_url: { url } })),
    ],
  };
}

/**
 * Rough prompt-size estimate, used only to fail fast and legibly. Text is
 * ~4 chars/token; a long base64 run is ~1 char/token (that is what the upstream
 * tokenizer actually charges), so runs of base64 are weighted separately.
 * An image part is billed as a fixed vision cost, not by its data URL length.
 */
const BASE64_RUN = /[A-Za-z0-9+/]{200,}={0,2}/g;

function estimatePromptTokens(chat) {
  let tokens = 0;
  const addText = (s) => {
    let b64 = 0;
    for (const m of s.match(BASE64_RUN) || []) b64 += m.length;
    tokens += Math.ceil((s.length - b64) / 4) + b64;
  };
  for (const m of chat.messages || []) {
    if (typeof m.content === 'string') addText(m.content);
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part?.type === 'text') addText(part.text ?? '');
        else if (part?.type === 'image_url') tokens += 1600;
      }
    }
    for (const c of m.tool_calls || []) addText(String(c.function?.arguments ?? ''));
  }
  for (const t of chat.tools || []) tokens += Math.ceil(JSON.stringify(t).length / 4);
  return tokens;
}

/**
 * Responses tools are flat ({type:'function', name, parameters}); Chat
 * Completions wants them nested under `function`. `custom` tools (Codex's
 * apply_patch) are freeform, so they get wrapped into a single-string-argument
 * function. `namespace` groups are flattened with a `group__tool` prefix.
 */
function convertTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out = [];
  const emit = (t) => {
    if (!t || typeof t !== 'object') return;
    if (t.type === 'function') {
      const fn = t.function && t.function.name ? t.function : {
        name: t.name,
        description: t.description,
        parameters: t.parameters || { type: 'object', properties: {} },
      };
      if (!fn.name) return;
      out.push({ type: 'function', function: fn });
    } else if (t.type === 'custom' && t.name) {
      out.push({
        type: 'function',
        function: {
          name: t.name,
          description: `${t.description || ''}\n\nCall this tool with a single "input" string argument containing the raw text payload.`,
          parameters: {
            type: 'object',
            properties: { input: { type: 'string', description: 'Raw text payload.' } },
            required: ['input'],
          },
        },
      });
    } else if (t.type === 'namespace' && Array.isArray(t.tools)) {
      for (const sub of t.tools) {
        if (!sub || typeof sub !== 'object') continue;
        emit({
          ...sub,
          name: sub.name ? `${t.name}__${sub.name}` : sub.name,
          description: [t.description, sub.description].filter(Boolean).join('\n\n'),
        });
      }
    }
    // local_shell / web_search / file_search: no Chat Completions equivalent.
  };
  for (const t of tools) emit(t);
  return out.length ? out : undefined;
}

function convertToolChoice(tc) {
  if (!tc) return undefined;
  if (typeof tc === 'string') return tc;
  if (tc.type === 'function' && tc.name) return { type: 'function', function: { name: tc.name } };
  return 'auto';
}

/**
 * Responses `input[]` -> Chat `messages[]`.
 *
 * The important part: `function_call` / `function_call_output` items must be
 * rebuilt into `assistant.tool_calls` and `role:"tool"` messages, correctly
 * paired by `call_id`, or the backend rejects the request.
 */
function convertInput(input, instructions) {
  const messages = [];
  if (instructions && String(instructions).trim()) {
    messages.push({ role: 'system', content: String(instructions) });
  }
  const items = typeof input === 'string'
    ? [{ type: 'message', role: 'user', content: input }]
    : Array.isArray(input) ? input : [];

  let pendingCalls = [];
  const flushPending = () => {
    if (pendingCalls.length) {
      messages.push({ role: 'assistant', content: null, tool_calls: pendingCalls });
      pendingCalls = [];
    }
  };

  // Images that a tool result could not carry. They are re-attached as one user
  // message *after* the whole run of tool results, because inserting a user
  // message between two `role:"tool"` messages would break their pairing with
  // the assistant `tool_calls` that produced them.
  let pendingImages = [];
  let imageLabel = '';
  const flushImages = () => {
    if (!pendingImages.length) return;
    const capped = pendingImages.slice(0, MAX_HOISTED_IMAGES);
    const dropped = pendingImages.length - capped.length;
    const note = dropped > 0
      ? `${imageLabel} — ${dropped} further image(s) omitted (cap ${MAX_HOISTED_IMAGES} per tool result)`
      : imageLabel;
    messages.push(imagesAsUserMessage(capped, note));
    pendingImages = [];
    imageLabel = '';
  };

  /**
   * Push a `role:"tool"` message for a tool result, keeping its text there and
   * diverting any images to `pendingImages`.
   */
  const pushToolResult = (callId, output) => {
    const { text, images } = splitOutput(output);
    const scrubbed = scrubInlineImages(text);
    const all = [...images, ...scrubbed.urls];

    let content = scrubbed.text;
    if (all.length > 0) {
      // Say so in-band too: the tool text is what the model reads first, and a
      // silent disappearance reads as "the tool returned nothing".
      content = `${content}\n${omittedImages(all.length)}`.trim();
      pendingImages.push(...all);
      imageLabel = `Images returned by tool call ${callId}`;
    }
    messages.push({ role: 'tool', tool_call_id: callId, content });
  };

  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const type = it.type || (it.role ? 'message' : undefined);

    if (type === 'message') {
      const role = it.role === 'developer' ? 'system' : (it.role || 'user');
      const content = contentToText(it.content);
      flushPending();
      // A new turn starts here, so the images from the previous tool run can be
      // attached now, still ahead of this message.
      flushImages();
      if (role === 'assistant') {
        const text = typeof content === 'string' ? content : '';
        if (text) messages.push({ role: 'assistant', content: text });
      } else {
        if (typeof content === 'string' && !content) continue;
        messages.push({ role, content });
      }
    } else if (type === 'function_call') {
      pendingCalls.push({
        id: it.call_id || it.id,
        type: 'function',
        function: { name: it.name, arguments: it.arguments || '{}' },
      });
    } else if (type === 'function_call_output') {
      flushPending();
      pushToolResult(it.call_id || it.id, it.output);
    } else if (type === 'local_shell_call' || type === 'custom_tool_call') {
      pendingCalls.push({
        id: it.call_id || it.id,
        type: 'function',
        function: { name: it.name || 'local_shell', arguments: it.arguments || '{}' },
      });
    } else if (type === 'custom_tool_call_output' || type === 'local_shell_call_output') {
      flushPending();
      pushToolResult(it.call_id || it.id, it.output);
    }
    // `reasoning` items are not fed back to the backend.
  }
  flushPending();
  flushImages();
  return messages;
}

/**
 * Some upstreams require a per-conversation correlation id (and will fault the
 * whole account pool if it is missing). Opt in with CCB_CONVERSATION_ID=auto;
 * Codex's `prompt_cache_key` is a session-stable value, which is exactly the
 * right granularity — it also lets upstream prompt caching work per session.
 */
function conversationIdFor(body) {
  if (!CONV_MODE) return undefined;
  if (CONV_MODE !== 'auto') return CONV_MODE;
  const candidate = body.prompt_cache_key || body.conversation_id;
  if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  return randomUUID();
}

/**
 * The Responses API carries the thinking level as `reasoning.effort`; Chat
 * Completions carries it as the flat `reasoning_effort` string. Dropping it here
 * makes every request run at the upstream's own default, so a client that asks
 * for `max` gets exactly what it would get for `low` — the selector moves, the
 * model does not think harder.
 */
function reasoningEffortFor(body) {
  const effort = body?.reasoning?.effort;
  if (typeof effort === 'string' && effort.trim() !== '') return effort.trim();
  if (typeof body?.reasoning_effort === 'string' && body.reasoning_effort.trim() !== '') {
    return body.reasoning_effort.trim();
  }
  return undefined;
}

function toChatRequest(body) {
  const rawModel = body.model;
  const model = MODEL_MAP.get(rawModel) || rawModel;

  const chat = {
    model,
    messages: convertInput(body.input, body.instructions),
    stream: true,
  };
  if (INCLUDE_USAGE) chat.stream_options = { include_usage: true };

  const convId = conversationIdFor(body);
  if (convId) chat.metadata = { conversation_id: convId };

  const tools = convertTools(body.tools);
  if (tools) {
    chat.tools = tools;
    chat.tool_choice = convertToolChoice(body.tool_choice) ?? 'auto';
    if (body.parallel_tool_calls !== undefined) chat.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (body.max_output_tokens) chat.max_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) chat.temperature = body.temperature;
  if (body.top_p !== undefined) chat.top_p = body.top_p;

  const effort = reasoningEffortFor(body);
  if (effort !== undefined) chat.reasoning_effort = effort;

  return chat;
}

/* ------------------------------------------------------------------ */
/* Chat Completions SSE  ->  Responses SSE                            */
/* ------------------------------------------------------------------ */

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const rid = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 18)}`;

/**
 * Translate a `chat.completion.chunk` stream into the Responses event
 * sequence. Event order follows what the Codex parser expects:
 *
 *   response.created
 *   -> response.in_progress
 *   -> [reasoning item:  output_item.added / reasoning_summary_text.delta* / ...done]
 *   -> [message item:    output_item.added / content_part.added / output_text.delta* / ...done]
 *   -> [function_call:   output_item.added / function_call_arguments.delta* / output_item.done]
 *   -> response.completed
 */
async function pipeStream(upstreamResp, res, model, chatReq) {
  const respId = rid('resp');
  const created = Math.floor(Date.now() / 1000);

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-bridge': SERVICE,
  });

  const responseObj = (status, extra = {}) => ({
    id: respId,
    object: 'response',
    created_at: created,
    status,
    model,
    output: [],
    parallel_tool_calls: true,
    tool_choice: chatReq.tool_choice ?? 'auto',
    tools: chatReq.tools ?? [],
    ...extra,
  });

  sse(res, 'response.created', { type: 'response.created', response: responseObj('in_progress') });
  sse(res, 'response.in_progress', { type: 'response.in_progress', response: responseObj('in_progress') });

  const outputItems = [];
  let outIndex = 0;
  let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

  let reasoningId = null;
  let reasoningBuf = '';
  let reasoningIndex = -1;

  let messageId = null;
  let messageBuf = '';
  let messageIndex = -1;

  const calls = new Map();

  const ensureReasoning = () => {
    if (reasoningId) return;
    reasoningId = rid('rs');
    reasoningIndex = outIndex++;
    sse(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: reasoningIndex,
      item: { type: 'reasoning', id: reasoningId, summary: [] },
    });
    sse(res, 'response.reasoning_summary_part.added', {
      type: 'response.reasoning_summary_part.added',
      item_id: reasoningId,
      output_index: reasoningIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    });
  };

  const ensureMessage = () => {
    if (messageId) return;
    messageId = rid('msg');
    messageIndex = outIndex++;
    sse(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: messageIndex,
      item: { type: 'message', id: messageId, role: 'assistant', status: 'in_progress', content: [] },
    });
    sse(res, 'response.content_part.added', {
      type: 'response.content_part.added',
      item_id: messageId,
      output_index: messageIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  };

  const closeReasoning = () => {
    if (!reasoningId) return;
    sse(res, 'response.reasoning_summary_text.done', {
      type: 'response.reasoning_summary_text.done',
      item_id: reasoningId,
      output_index: reasoningIndex,
      summary_index: 0,
      text: reasoningBuf,
    });
    sse(res, 'response.reasoning_summary_part.done', {
      type: 'response.reasoning_summary_part.done',
      item_id: reasoningId,
      output_index: reasoningIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: reasoningBuf },
    });
    const item = {
      type: 'reasoning',
      id: reasoningId,
      summary: [{ type: 'summary_text', text: reasoningBuf }],
    };
    sse(res, 'response.output_item.done', {
      type: 'response.output_item.done', output_index: reasoningIndex, item,
    });
    outputItems.push(item);
    reasoningId = null;
  };

  const closeMessage = () => {
    if (!messageId) return;
    sse(res, 'response.output_text.done', {
      type: 'response.output_text.done',
      item_id: messageId,
      output_index: messageIndex,
      content_index: 0,
      text: messageBuf,
    });
    sse(res, 'response.content_part.done', {
      type: 'response.content_part.done',
      item_id: messageId,
      output_index: messageIndex,
      content_index: 0,
      part: { type: 'output_text', text: messageBuf, annotations: [] },
    });
    const item = {
      type: 'message',
      id: messageId,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: messageBuf, annotations: [] }],
    };
    sse(res, 'response.output_item.done', {
      type: 'response.output_item.done', output_index: messageIndex, item,
    });
    outputItems.push(item);
    messageId = null;
  };

  const ensureCall = (idx, id, name) => {
    let c = calls.get(idx);
    if (c) {
      if (!c.name && name) c.name = name;
      return c;
    }
    c = {
      id: id || rid('call'),
      name: name || '',
      args: '',
      outIndex: outIndex++,
      added: false,
    };
    calls.set(idx, c);
    return c;
  };

  const addCallItem = (c) => {
    if (c.added) return;
    c.added = true;
    sse(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: c.outIndex,
      item: {
        type: 'function_call',
        id: c.id,
        call_id: c.id,
        name: c.name,
        arguments: '',
        status: 'in_progress',
      },
    });
  };

  const closeCalls = () => {
    for (const [, c] of [...calls.entries()].sort((a, b) => a[1].outIndex - b[1].outIndex)) {
      addCallItem(c);
      const item = {
        type: 'function_call',
        id: c.id,
        call_id: c.id,
        name: c.name,
        arguments: c.args || '{}',
        status: 'completed',
      };
      sse(res, 'response.output_item.done', {
        type: 'response.output_item.done', output_index: c.outIndex, item,
      });
      outputItems.push(item);
    }
  };

  const decoder = new TextDecoder();
  let buf = '';
  let sawDone = false;

  const handleLine = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') { sawDone = true; return; }

    let chunk;
    try { chunk = JSON.parse(payload); } catch { return; }

    if (chunk.usage) {
      usage = {
        input_tokens: chunk.usage.prompt_tokens ?? 0,
        output_tokens: chunk.usage.completion_tokens ?? 0,
        total_tokens: chunk.usage.total_tokens ?? 0,
        input_tokens_details: { cached_tokens: chunk.usage.prompt_cache_hit_tokens ?? 0 },
        output_tokens_details: {
          reasoning_tokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
        },
      };
    }

    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};

    const rc = delta.reasoning_content ?? delta.reasoning;
    if (typeof rc === 'string' && rc) {
      ensureReasoning();
      reasoningBuf += rc;
      sse(res, 'response.reasoning_summary_text.delta', {
        type: 'response.reasoning_summary_text.delta',
        item_id: reasoningId,
        output_index: reasoningIndex,
        summary_index: 0,
        delta: rc,
      });
    }

    if (typeof delta.content === 'string' && delta.content) {
      closeReasoning();
      ensureMessage();
      messageBuf += delta.content;
      sse(res, 'response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: messageId,
        output_index: messageIndex,
        content_index: 0,
        delta: delta.content,
      });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const c = ensureCall(idx, tc.id, tc.function?.name);
        if (tc.function?.name && !c.name) c.name = tc.function.name;
        addCallItem(c);
        const frag = tc.function?.arguments;
        if (typeof frag === 'string' && frag) {
          c.args += frag;
          sse(res, 'response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: c.id,
            output_index: c.outIndex,
            delta: frag,
          });
        }
      }
    }
  };

  try {
    for await (const piece of upstreamResp.body) {
      buf += decoder.decode(piece, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        handleLine(line);
      }
    }
    if (buf) handleLine(buf.replace(/\r$/, ''));
  } catch (e) {
    log('upstream stream error:', e.message);
  }

  closeReasoning();
  closeMessage();
  if (calls.size) {
    closeCalls();
  } else if (!messageBuf && outIndex === 0) {
    // Empty response: emit one empty assistant message so clients don't
    // complain about a response with no output.
    ensureMessage();
    closeMessage();
  }

  sse(res, 'response.completed', {
    type: 'response.completed',
    response: responseObj('completed', { usage, output: outputItems }),
  });
  res.end();
  if (!sawDone) log('note: upstream never sent [DONE], closed anyway');
}

/**
 * Non-streaming path: run the same translator into an in-memory sink and
 * return the accumulated `response` object as JSON.
 */
async function collectResponse(upstreamResp, model, chatReq) {
  const events = [];
  const sink = {
    writeHead() { return this; },
    write(chunk) {
      for (const block of String(chunk).split('\n\n')) {
        if (!block.trim()) continue;
        const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        try { events.push(JSON.parse(dataLine.slice(5).trim())); } catch { /* ignore */ }
      }
      return true;
    },
    end() {},
  };
  await pipeStream(upstreamResp, sink, model, chatReq);
  const completed = [...events].reverse().find((e) => e.type === 'response.completed');
  return completed?.response ?? { object: 'response', status: 'completed', model, output: [] };
}

/* ------------------------------------------------------------------ */
/* HTTP layer                                                         */
/* ------------------------------------------------------------------ */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function jsonError(res, status, message, code, type = 'invalid_request_error') {
  res.writeHead(status, { 'content-type': 'application/json' })
    .end(JSON.stringify({ error: { message, type, code } }));
}

const server = createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (req.method === 'GET' && (url === '/' || url === '/health' || url === '/healthz')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      ok: true,
      service: SERVICE,
      version: VERSION,
      upstream: BASE,
      model_allowlist: MODEL_ALLOWLIST.size ? [...MODEL_ALLOWLIST] : 'all',
      conversation_id: CONV_MODE || 'off',
      max_prompt_tokens: MAX_PROMPT_TOKENS || 'off',
    }));
    return;
  }

  // Model discovery is passed straight through.
  if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
    try {
      const r = await fetch(`${BASE}/models`, {
        headers: API_KEY ? { authorization: `Bearer ${API_KEY}` } : {},
        signal: AbortSignal.timeout(30000),
      });
      const t = await r.text();
      res.writeHead(r.status, { 'content-type': 'application/json' }).end(t);
    } catch (e) {
      jsonError(res, 502, `bridge: cannot reach upstream ${BASE}: ${e.message}`, 'upstream_unreachable', 'api_error');
    }
    return;
  }

  if (!(req.method === 'POST' && /\/v1\/responses\/?$/.test(url))) {
    log('unhandled', req.method, url);
    jsonError(res, 404, `bridge: no route for ${req.method} ${url}`, 'not_found');
    return;
  }

  let raw;
  try { raw = await readBody(req); } catch (e) {
    jsonError(res, 400, String(e), 'bad_request');
    return;
  }

  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch {
    jsonError(res, 400, 'bridge: request body is not valid JSON', 'invalid_json');
    return;
  }

  if (CAPTURE) {
    try {
      writeFileSync(join(CAPTURE, `req-${String(++captureN).padStart(3, '0')}.json`), raw);
    } catch { /* capture is best-effort */ }
  }

  const chatReq = toChatRequest(body);

  if (MODEL_ALLOWLIST.size && !MODEL_ALLOWLIST.has(chatReq.model)) {
    log('blocked model (not in allowlist):', chatReq.model);
    jsonError(
      res, 400,
      `bridge: model "${chatReq.model}" is not in CCB_MODEL_ALLOWLIST. `
        + `Allowed: ${[...MODEL_ALLOWLIST].join(', ')}`,
      'model_not_allowed',
    );
    return;
  }

  log('POST /v1/responses ->', chatReq.model,
    `msgs=${chatReq.messages.length}`, `tools=${chatReq.tools?.length ?? 0}`,
    `stream=${body.stream !== false}`);

  if (MAX_PROMPT_TOKENS > 0) {
    const estimated = estimatePromptTokens(chatReq);
    if (estimated > MAX_PROMPT_TOKENS) {
      // Local refusal: no upstream account is spent, and the message is
      // actionable. The upstream's own 400 returns no usage, so a client that
      // only learns its size from `usage` would stay blind here.
      log('prompt too large, refusing locally:', `est=${estimated}`, `max=${MAX_PROMPT_TOKENS}`);
      jsonError(
        res, 413,
        `bridge: prompt is about ${estimated} tokens, over the ${MAX_PROMPT_TOKENS}-token `
          + 'ceiling, so the request was not sent upstream. Reduce history or start a new '
          + 'conversation. Images inside tool results are already dropped (a tool message '
          + 'is text-only), so check for large tool output or a very long transcript.',
        'prompt_too_long',
      );
      return;
    }
  }

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
    log('upstream connect failed:', e.message);
    jsonError(res, 502, `bridge: cannot reach upstream ${BASE}: ${e.message}`, 'upstream_unreachable', 'api_error');
    return;
  }

  if (!upstream.ok) {
    const t = await upstream.text();
    log('upstream error', upstream.status, t.slice(0, 400));
    res.writeHead(upstream.status, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: { message: `upstream ${upstream.status}: ${t.slice(0, 2000)}` } }));
    return;
  }

  if (body.stream === false) {
    const response = await collectResponse(upstream, body.model, chatReq);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response));
    return;
  }

  await pipeStream(upstream, res, body.model, chatReq);
});

server.listen(PORT, HOST, () => {
  // Report the bound port, not the requested one: `--port 0` asks the OS to pick,
  // and a test harness needs the real number.
  const bound = server.address().port;
  log(`${SERVICE} ${VERSION} listening on http://${HOST}:${bound} -> ${BASE}`);
  if (!API_KEY) log('note: no CCB_API_KEY / OPENAI_API_KEY set; sending no Authorization header');
  if (MODEL_ALLOWLIST.size) log(`model allowlist: ${[...MODEL_ALLOWLIST].join(', ')}`);
  if (MODEL_MAP.size) log(`model map: ${[...MODEL_MAP].map(([a, b]) => `${a}->${b}`).join(', ')}`);
  if (CAPTURE) log(`capturing inbound request bodies to ${CAPTURE}`);
  if (MAX_PROMPT_TOKENS > 0) log(`prompt ceiling: ~${MAX_PROMPT_TOKENS} tokens (local 413 above it)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

