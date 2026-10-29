# dsh-workbuddy-codex

**English** | [简体中文](README.zh-CN.md)

A DeepSeek Harness plugin that keeps the local WorkBuddy reverse-proxy chain alive — the model picker's provider, the gateway behind it, **and the two protocol bridges: Responses for OpenAI Codex CLI, Anthropic Messages for Claude Code and Claude Desktop**.

These have to line up before a WorkBuddy model can answer, and none of them installs itself as a Windows service:

| Port | Service | Role |
| --- | --- | --- |
| `127.0.0.1:7863` | `wb2api` gateway | OpenAI-compatible `/v1/chat/completions` |
| `127.0.0.1:7864` | Responses bridge (**bundled**) | Responses API → chat/completions, for Codex CLI |
| `127.0.0.1:7865` | Anthropic Messages bridge (**bundled**) | Anthropic `/v1/messages` → chat/completions, for Claude Code and Claude Desktop 3p |
| — | `workbuddy` provider | the model-picker route, **mounted from [`dsh-llm-workbuddy`](https://www.npmjs.com/package/dsh-llm-workbuddy)** |

These processes used to be started by hand, so a reboot silently left the model picker pointing at a dead port — the provider plugin loaded fine, listed models fine, and failed on the first request. This plugin supervises them: on load it probes each health endpoint, spawns whatever is missing, and re-checks on a timer so a crashed process comes back.

It deliberately **does not reimplement the gateway, and does not fork the adapter either**. The gateway is orchestrated as a process. The provider route is mounted by delegating to `dsh-llm-workbuddy` with `ctx.plugin()` — that package owns the ~2.5k-line WorkBuddy adapter, its settings section and its daily checkin scheduler, and a second copy of all that would drift the moment either side is updated. So one install covers provider + gateway + bridge.

The delegation is additive, not exclusive: if you also keep `dsh-llm-workbuddy` enabled standalone, whichever plugin registers the route first keeps it and the other stands down with a log line, so both layouts are safe.

## Settings

Everything lives under the `workbuddy-codex` entry's `config` in the profile's `cordis.yml`; the shipped `cordis.patch.yml` has the full default set.

| Key | Default | What it does |
| --- | --- | --- |
| `gatewayDir` | `~/Documents/deepseek-harness/default-workspace/workbuddy2api-panel` | Where the gateway keeps `config.json`. The `api_key` in it is used for **both** the bridge and the provider, so the port and the key are configured once. |
| `provider.enabled` | `true` | Register the `workbuddy` route. |
| `provider.baseURL` | *(empty → `gateway.baseURL`)* | Gateway URL for the adapter. |
| `provider.discovery` | `true` | Ask the gateway's `/v1/models` for the live catalog. |
| `provider.autoCheckin` | `true` | Claim the daily WorkBuddy checkin. |
| `gateway.acceptStatus` | `[200, 503]` | The gateway answers `503` while running without a usable account — alive, not down. |
| `bridge.conversationId` | `auto` | Not optional against a WorkBuddy gateway: without it the upstream answers `400 / 11-128` and the gateway disables the account. |
| `bridge.maxPromptTokens` | `1200000` | Above this estimated prompt size the bridge answers `413` locally instead of forwarding a body the upstream rejects with `400 prompt_too_long`. `0` turns it off. See [Why a local prompt ceiling](#why-a-local-prompt-ceiling). |
| `anthropicBridge.enabled` | `true` | Supervise the Anthropic Messages bridge. |
| `anthropicBridge.baseURL` | `http://127.0.0.1:7865` | Where the bridge listens — and the gateway base URL to give Claude. |
| `anthropicBridge.upstream` | *(empty → `gateway.baseURL`)* | What the bridge forwards to. Empty reuses the same gateway. |
| `anthropicBridge.apiKey` | *(empty → the gateway's `api_key`)* | Upstream bearer. Empty shares the Responses bridge's secret, so the two cannot drift apart. |
| `anthropicBridge.defaultModel` | *(empty → the catalog head)* | Only used when a client names a bare Claude alias (`claude-sonnet-5-5`, `opus`). See [Pointing Claude at it](#pointing-claude-at-it). |

If `dsh-llm-workbuddy` is not installed at all, the plugin still supervises the gateway and the bridge and logs the one command that fixes it (`dsh plugin add dsh-llm-workbuddy`). Nothing throws.

## Why the bridge is bundled

`codex-cli` 0.1xx+ dropped `wire_api = "chat"` and speaks **only** the OpenAI Responses API (`POST /v1/responses`, SSE). A WorkBuddy gateway implements **only** Chat Completions (`POST /v1/chat/completions`). Point Codex straight at the gateway and every request dies with:

```
unexpected status 404 Not Found, url: http://127.0.0.1:7863/v1/responses
```

There is no config flag around this — Codex rejects `wire_api = "chat"` at load time. A translation layer is mandatory, so this package ships one:

```
Codex CLI --(Responses)--> bridge :7864 --(ChatCompletions)--> gateway :7863 --> WorkBuddy
```

It is the same code as [codex-chat-bridge](https://github.com/kangjiazhen/codex-chat-bridge), vendored at `bridge/codex-chat-bridge.mjs` (zero dependencies, runs on the harness's own Node) so installing this plugin is the only step — there is no second repo to clone and no path to fill in.

## Install

```bash
dsh plugin add git+https://github.com/kangjiazhen/dsh-workbuddy-codex.git
```

Or from a local checkout:

```bash
dsh plugin add file:/path/to/dsh-workbuddy-codex
```

The plugin ships a `cordis.patch.yml`, so the profile picks up the `workbuddy-codex` entry automatically once the package is a profile dependency.

### Coming from dsh-llm-workbuddy

This package now covers what that one did, so a profile that already had it enabled needs one edit: drop it from `dsh.profile.bundles` in the profile's `package.json` and leave it in `dependencies`.

```jsonc
"dsh": { "profile": { "bundles": [
  // "dsh-llm-workbuddy",   <- remove this line
  "dsh-workbuddy-codex"
] } }
```

The package itself has to stay installed — this plugin imports it to mount the provider, and there is no second copy of the adapter to drift. Leaving both in `bundles` is not harmful either: the first one to register keeps the route and the other logs `already-served`, but then this plugin is not the thing serving your models, which defeats the point.

### If the git install fails

`pnpm` rewrites `git+https://…` to `git+ssh://git@…` unless told otherwise, so an install on a machine without GitHub SSH keys fails with `Permission denied (publickey)`:

```bash
npm config set git-protocol https
```

Behind a proxy, git also needs to be told about it, because `pnpm` shells out to the `git` binary and does not forward its own proxy settings:

```bash
git config --global http.proxy http://127.0.0.1:7890
```

## Using it with Codex

The bridge listens on `7864` and presents a Responses API. Point Codex at it:

```toml
# ~/.codex/config.toml
model = "global:gpt-5.3-codex"
model_provider = "wb"

[model_providers.wb]
name = "workbuddy"
base_url = "http://127.0.0.1:7864/v1"
wire_api = "responses"
experimental_bearer_token = "anything"
request_max_retries = 2
stream_max_retries = 2
```

The bearer is not checked by the bridge — it authenticates to the gateway itself with the key it reads from the gateway's `config.json`. Set it to any non-empty string; Codex refuses to start without one.

Then just use Codex normally:

```bash
codex exec "list the files in this directory"
```

If you pick a model your account tier cannot use, the gateway answers `11158 model not allowed for user type [...]`. That is an account property, not a bridge fault — see [Model availability](#model-availability).

### Two settings you must not skip

**1. `conversation_id` — the one that can disable your account.**

The WorkBuddy upstream validates three headers (`X-Conversation-ID`, `X-Conversation-Request-ID`, `X-Conversation-Message-ID`) and answers `400 {"code":"11-128","msg":"request illegal"}` when they are missing. The gateway classifies that as an *account fault* and responds by **disabling the account** — every account it touched, in the same pass. The resulting message says `re-login required`, which is misleading: the credentials are usually still valid and reviving them restores service immediately.

So the bridge defaults to `conversationId: auto`: it derives a stable id per Codex session (from `prompt_cache_key`) and sends it as `metadata.conversation_id`. Do not blank this out. The plugin warns at startup if you do.

If you have already tripped it, revive the accounts rather than re-logging in:

```bash
# gateway panel: http://127.0.0.1:7863/panel/
curl -X POST http://127.0.0.1:7863/panel/api/accounts/<uid>/revive
```

**2. The bearer must match the gateway's `api_key`.**

The gateway answers `401` to every request without it. Rather than making you copy the secret, the plugin reads `api_key` straight out of the gateway's `config.json` (that is what `gatewayDir` is for) and hands it to the bridge. Set `bridge.apiKey` only to override that.

### Images only arrive if the model catalog says so

Codex reads `~/.codex/models.json` *before* it builds a request. If the selected model's entry does not list `image` in `input_modalities`, Codex replaces every attachment with the literal string `image content omitted because you do not support image input` — the bridge never sees a picture, and the model falls back to reading the file with a shell tool or guessing.

So for every model the gateway reports as `supports_images: true`, the catalog entry has to say so:

```json
{
  "slug": "cn:deepseek-v4.1-flash",
  "input_modalities": ["text", "image"]
}
```

The bridge passes `input_image` through untouched (to `{"type":"image_url","image_url":{"url":"data:..."}}`), so a missing entry is the only thing that can silence images on the Codex side. `GET /v1/models` is the source of truth — `supports_images` there is what the upstream actually accepts.

### Reasoning effort is a separate field on each side of the bridge

The two protocols name the same setting differently, and the name is the only thing they share:

| Side | Where the level lives |
| --- | --- |
| Responses (Codex) | `"reasoning": { "effort": "max" }` |
| Chat Completions (gateway) | `"reasoning_effort": "max"` |

The bridge reads `reasoning.effort` and forwards it as the flat `reasoning_effort`, omitting the field when the client asked for no level so the upstream default still applies. Without that mapping every request reaches the backend at the gateway's default level, so `low` and `max` behave identically — the selector moves, the model does not think harder.

Which levels exist is the gateway's call, not the bridge's. `reasoning_supported_efforts` in `GET /v1/models` is the authority; on this gateway 17 of 55 models offer `max`, and the rest answer with whatever subset they declare (some only `medium`, some `low`/`high`, some `high`/`xhigh`). A level the model does not declare is dropped by the gateway, silently. Pick the model first, then pick the level.

## Pointing Claude at it

Claude Code and Claude Desktop (3p mode) speak the Anthropic Messages wire (`POST /v1/messages`, SSE). The gateway speaks only Chat Completions. A second bundled bridge translates between them, listening on `7865`.

### Claude Code

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:7865
export ANTHROPIC_API_KEY=anything      # the bridge does not check it; it authenticates upstream with the gateway's key
claude
```

### Claude Desktop (3p)

Edit the config it actually reads (the UUID differs per install; `appliedId` in `_meta.json` names the live one):

```jsonc
// %LOCALAPPDATA%\Claude-3p\configLibrary\<appliedId>.json
{
  "inferenceGatewayBaseUrl": "http://127.0.0.1:7865",
  "inferenceGatewayApiKey": "anything",
  "modelDiscoveryEnabled": true,
  "inferenceProvider": "gateway",
  "inferenceCredentialKind": "static",
  "defaultModelEffort": "max"   // optional; low/medium/high/xhigh also work
}
```

Three things matter:

- **Do not set `inferenceModels`.** Desktop treats that list as hand-written truth: while it is non-empty it skips `/v1/models` discovery and the picker shows only what you transcribed. Leave it out, turn `modelDiscoveryEnabled` on, and the picker becomes a live projection of the gateway catalog.
- **`inferenceGatewayBaseUrl` accepts `http://` on a loopback host**; any other host must be https.
- **`defaultModelEffort` only moves Desktop's "recommended" marker.** The level actually sent upstream is decided by the bridge (next section), so set both or neither — otherwise the picker and the wire disagree.

### Context window and thinking effort

Every gateway model carries a `context_length`, `1000000` for most of them here. Desktop does **not** guess that number: it reads `max_input_tokens` off each `/v1/models` row and silently substitutes its own `200000` default when the field is absent. A bridge that drops the field therefore makes every model look like 200K — nothing to do with the gateway.

So the bridge publishes, per row:

| Discovery field | Source | What Desktop does with it |
| --- | --- | --- |
| `max_input_tokens` | gateway `context_length` / `max_allowed_size` | the window it displays; `>= 1000000` also counts as "1M" |
| `prefer_1m` | set when the same figure is `>= 1000000` | preselects the 1M variant instead of making the user pick it |
| `max_output_tokens` | gateway `max_output_tokens` | per-turn output ceiling |
| `max_effort_level` | top of the gateway's `reasoning_supported_efforts` | upper bound of the effort selector |
| `behaves_as` | fixed `claude-sonnet-5`, reasoning models only | borrows a Claude family's thinking UI; without it there is **no effort selector at all** |

`behaves_as` is the easy one to miss: Desktop renders an effort menu only for ids it can resolve to a built-in Claude family (`claude-<tier>-<version>`). A hashed id carries no family, so the bridge declares one explicitly. And the level that reaches the upstream does not depend on the client at all: when no `output_config.effort` arrives — which is the normal case, since Desktop only sends one after you touch the selector — the bridge picks the model's highest supported level. That is the only reliable place to make "think as hard as possible" the default.

### Why the model ids are rewritten as `claude-wb-…`

Desktop runs every discovered row through a filter (`No()`): an id carrying another vendor's brand token (`kimi`, `gpt`, `deepseek`, `qwen`, `glm`, …) is dropped outright, and the id must also look like an Anthropic route (`claude…`). A real `cn:kimi-k3.1-pro` fails both — the picker comes up empty.

So the bridge hashes the real id into `claude-wb-<10 hex>` and publishes that, keeping the real id only in its in-memory catalog, while **the human-readable name rides in `display_name`** (`CN · Kimi-K3.1-Pro`). When a `claude-wb-…` comes back, the bridge maps it to the real id and forwards that.

One more trap: Desktop merges picker rows by `(name, Anthropic family)`. Several distinct gateway models share one display name (`cn:hy3` / `cn:hy3-x`, `cn:hy4-preview` / `cn:hy4-preview-f`, …), so copying the names verbatim **silently hides rows**. The bridge therefore appends the distinguishing tail of the id, but only where names actually collide: `CN · Hy3 (x)`, `Global · Auto (chat)`. Measured against this gateway: 52 models in, 52 rows in the picker.

### When a client names a bare Claude alias

If a config you copied from elsewhere says `claude-sonnet-5-5` — an alias that never went through the picker, so the bridge has never seen it — the bridge answers from `anthropicBridge.defaultModel` instead of 404ing, falling back to the catalog head when that is empty. A translated config still produces text rather than leaving you to guess at a 404.

## Configuration

The defaults assume the usual layout and can be overridden in the profile's `cordis.yml`:

```yaml
- id: workbuddy-codex
  name: dsh-workbuddy-codex
  config:
    intervalMs: 15000        # re-probe cadence
    probeTimeoutMs: 2000     # per-probe timeout
    gatewayDir: ~/Documents/deepseek-harness/default-workspace/workbuddy2api-panel

    gateway:
      enabled: true
      autostart: true
      baseURL: http://127.0.0.1:7863
      acceptStatus: [200, 503]
      command: ~/Documents/deepseek-harness/default-workspace/workbuddy2api-panel/wb2api.exe
      args: [-config, config.json]
      cwd: ~/Documents/deepseek-harness/default-workspace/workbuddy2api-panel

    bridge:
      enabled: true
      autostart: true
      baseURL: http://127.0.0.1:7864
      acceptStatus: [200]
      command: ''            # empty = run the bundled bridge
      upstream: ''           # empty = the gateway's baseURL
      apiKey: ''             # empty = read gatewayDir/config.json
      conversationId: auto   # required — see above
      modelAllowlist: []     # empty = forward every model
      maxPromptTokens: 1200000  # local 413 above this; 0 = off

    anthropicBridge:
      enabled: true
      autostart: true
      baseURL: http://127.0.0.1:7865
      acceptStatus: [200]
      command: ''            # empty = run the bundled bridge
      upstream: ''           # empty = the gateway's baseURL
      apiKey: ''             # empty = read gatewayDir/config.json
      defaultModel: ''       # empty = the head of the catalog
```

Paths accept `~`, `$VAR` / `${VAR}`, and Windows `%VAR%`, so a config file can be copied between machines without rewriting the home directory.

`bridge.command` is empty on purpose. Setting it switches the plugin from "run the bundled bridge" to "supervise this command instead", which is how you'd point it at a different bridge build; `CCB_PORT`, `CCB_UPSTREAM` and the rest of the environment are still derived for you.

### `acceptStatus` matters

The gateway answers **`503`** on `/healthz` while it is running but has no usable upstream account yet (nothing signed in, or every account cooling down). That is *alive*, not *down*.

A supervisor that only accepted `2xx` would read that as "not started", spawn a second copy, and lose the port race. So the gateway entry accepts `[200, 503]` by default, while the bridge accepts `[200]` only.

### `autostart: false`

Observe without ever spawning. Use this when something else owns the lifecycle — a scheduled task, a container, a wrapper script — and you only want the health reporting.

## Status tool

When the `tools` seam is mounted, the plugin registers `workbuddy_codex_status`:

```
gateway: up (http://127.0.0.1:7863/healthz, pid 14592)
bridge: up (http://127.0.0.1:7864/healthz)
anthropicBridge: up (http://127.0.0.1:7865/healthz, pid 14593)
```

Each line carries the live probe result, the supervised child pid, and the last spawn error if there was one — so "the model list is empty" can be told apart from "the port is dead" without reading logs.

If `@deepseek-ai/dsh-tools` is not importable, the tool is skipped with a warning rather than registered half-formed: `tools.register()` requires the `defineTool` shape (an `output { schema, render }` pair) and rejects anything else, so a raw descriptor would fail silently and the model would never see the tool. The supervisor and the provider run either way — neither depends on the tool.

## Lifecycle

- The first supervision pass runs asynchronously right after `apply()`, so a cold start never blocks the harness.
- The timer is `unref`'d — an idle supervisor cannot hold the process open.
- On dispose the timer stops and any child **this plugin spawned** is terminated. A service that was already running before the plugin loaded is left alone: it is probed and reported, never adopted, so unloading the plugin does not kill a process someone else started.

## Model availability

Which models answer is a property of your **WorkBuddy account tier**, not of this plugin or the bridge. A `personal_free_user` account, measured on 2026-10-21, could reach:

| Realm | Working |
| --- | --- |
| `global:` | `gpt-5.3-codex`, `glm-5.3`, `glm-5.2`, `kimi-k3`, `kimi-k2.6`, `hy4-preview`, `step-5-preview`, `deepseek-v4.1-flash`, `minimax-m3.1-flash` |
| `cn:` | `deepseek-v4.1-flash`, `deepseek-v4-pro`, `glm-5.3` |

Every other GPT model (`gpt-5.4`, `gpt-5.5`, the `gpt-6-*` family, …) answered `11158 model not allowed for user type [personal_free_user]`. That list moves with your subscription, so treat it as a snapshot, not a contract.

`modelAllowlist` exists to fail *fast* on models you know are unreachable: the bridge rejects them with a local `400 model_not_allowed` instead of letting the gateway classify the refusal as an account fault and disable the pool. Leaving it empty is the honest default.

## Why a local prompt ceiling

An upstream `400 prompt_too_long` is not just a rejection — it returns **no `usage`**. A client that learns its own size from `usage` therefore cannot see how far over it is. It holds the last successful measurement, keeps resending the same oversized history, and never reaches the threshold that would trigger auto-compaction. Measured on a real session: the last success was `662,937` input tokens, the rejected body was `1,049,429`, and the client's counter stayed frozen at `662,937` — 70% of a 950k window — for the rest of the session. The overshoot was 849 tokens, and it was unrecoverable.

Two consequences the bridge handles directly:


- **Images in tool results are re-attached, not serialized.** A Chat Completions `role: "tool"` message carries text only, so an image returned by a tool has nowhere to go. Stringifying it put the whole `data:` URL into the prompt as literal text; the upstream tokenizer then charged roughly one token per character. One 1080p screenshot (~570k base64 characters) was measured at 280k–594k input tokens — a single tool result could fill a 1M context. The bridge now keeps the text in the tool message, notes that images moved, and re-attaches them as real `image_url` parts on the next user message (after the whole run of tool results, so the assistant `tool_calls` pairing is not broken). Measured after the fix: the same 762,772-character screenshot costs **1,100** input tokens instead of 594,443, and the model reads the image normally. At most 8 images are hoisted per tool result; the rest are reported by count.
- **`maxPromptTokens` refuses locally.** Above the ceiling the bridge answers `413` with the estimated size and never contacts the upstream. No account is spent, no rate-limit cooldown is tripped, and the message says what to do.

Set it a little **above** the real ceiling (`1200000` for a `1048576`-token upstream) so an estimate that runs high cannot refuse a request that would have fit. The estimate is deliberately crude — ~4 chars/token for text, ~1 char/token for long base64 runs, a fixed vision cost per image — which is why it is a tripwire and not a context manager.

## Scope and limits

- Process supervision plus a request translator. It does not start, stop, or configure the *upstream* provider, and it has no opinion about which models your account may use.
- No restart backoff: a child that dies instantly is respawned once per `intervalMs`. If the binary is missing or the port is held by a foreign process, the logs will say so on every pass rather than spinning.
- `windowsHide: true` is set on spawn, so a supervised console child does not flash a window on Windows.
- Linux and macOS work with the same code; only the default paths in `cordis.patch.yml` are Windows-specific.
- The upstream WorkBuddy project has stopped maintenance and is actively tightening anti-proxy checks. This plugin keeps the chain alive; it cannot keep the upstream channel open.

## Related

- [codex-chat-bridge](https://github.com/kangjiazhen/codex-chat-bridge) — the bridge this plugin bundles, if you want it standalone.
- [LiteLLM](https://github.com/BerriAI/litellm), [one-api](https://github.com/songquanpeng/one-api), [new-api](https://github.com/Calcium-Ion/new-api) — full gateways, if you need routing and key management rather than local process supervision.

## License

MIT
