# dsh-workbuddy-stack

**English** | [简体中文](README.zh-CN.md)

A DeepSeek Harness plugin that keeps the local WorkBuddy reverse-proxy chain alive.

Two services have to be running before the harness can talk to WorkBuddy models, and neither installs itself as a Windows service:

| Port | Service | Role |
| --- | --- | --- |
| `127.0.0.1:7863` | `wb2api` gateway | OpenAI-compatible `/v1/chat/completions` |
| `127.0.0.1:7864` | `codex-chat-bridge` | Responses API → chat/completions, for Codex CLI |

Both used to be started by hand, so a reboot silently left the model picker pointing at a dead port — the provider plugin loaded fine, listed models fine, and failed on the first request. This plugin supervises them: on load it probes each health endpoint, spawns whatever is missing, and re-checks on a timer so a crashed process comes back.

It deliberately **does not reimplement the gateway**. It only orchestrates processes that already exist on disk. Provider registration stays with the provider plugin (`dsh-llm-workbuddy` and friends) — this plugin's only job is making sure the port that provider talks to is actually answering.

## Install

```bash
dsh plugin add git+https://github.com/kangjiazhen/dsh-workbuddy-stack.git
```

Or from a local checkout:

```bash
dsh plugin add file:/path/to/dsh-workbuddy-stack
```

The plugin ships a `cordis.patch.yml`, so the profile picks up the `workbuddy-stack` entry automatically once the package is a profile dependency.

## Configuration

The defaults assume the usual layout under your home directory and can be overridden in the profile's `cordis.yml`:

```yaml
- id: workbuddy-stack
  name: dsh-workbuddy-stack
  config:
    intervalMs: 15000        # re-probe cadence
    probeTimeoutMs: 2000     # per-probe timeout

    gateway:
      enabled: true
      autostart: true
      baseURL: http://127.0.0.1:7863
      acceptStatus: [200, 503]
      command: ~/Documents/deepseek-harness/default-workspace/workbuddy2api-panel/wb2api.exe
      args: [-config, config.json]
      cwd: ~/Documents/deepseek-harness/default-workspace/workbuddy2api-panel

    bridge:
      enabled: false
      autostart: true
      baseURL: http://127.0.0.1:7864
      acceptStatus: [200]
      command: node
      args:
        - ~/Documents/deepseek-harness/default-workspace/codex-chat-bridge/bin/codex-chat-bridge.mjs
        - --port
        - '7864'
        - --upstream
        - http://127.0.0.1:7863
```

Paths accept `~`, `$VAR` / `${VAR}`, and Windows `%VAR%`, so a config file can be copied between machines without rewriting the home directory.

`bridge.enabled` is `false` by default: that half of the chain only exists for the Codex CLI, and it should stay quiet on machines where `codex-chat-bridge` is not installed.

### `acceptStatus` matters

The gateway answers **`503`** on `/healthz` while it is running but has no usable upstream account yet (nothing signed in, or every account cooling down). That is *alive*, not *down*.

A supervisor that only accepts `2xx` would read that as "not started", spawn a second copy, and lose the port race. So the gateway entry accepts `[200, 503]` by default, while the bridge accepts `[200]` only.

### `autostart: false`

Observe without ever spawning. Use this when something else owns the lifecycle — a scheduled task, a container, a wrapper script — and you only want the health reporting.

## Status tool

When the `tools` seam is mounted, the plugin registers `workbuddy_stack_status`:

```
gateway: up (http://127.0.0.1:7863/healthz, pid 14592)
bridge: up (http://127.0.0.1:7864/healthz)
```

Each line carries the live probe result, the supervised child pid, and the last spawn error if there was one — so "the model list is empty" can be told apart from "the port is dead" without reading logs.

If `@deepseek-ai/dsh-tools` is not importable, the tool is still registered from the raw descriptor; if the `tools` seam is absent, the supervisor still runs. Neither is required for the other.

## Lifecycle

- The first supervision pass runs asynchronously right after `apply()`, so a cold start never blocks the harness.
- The timer is `unref`'d — an idle supervisor cannot hold the process open.
- On dispose the timer stops and any child **this plugin spawned** is terminated. A service that was already running before the plugin loaded is left alone: it is probed and reported, never adopted, so unloading the plugin does not kill a process someone else started.

## Scope and limits

- Process supervision only. It does not start, stop, or configure the *upstream* provider, and it has no opinion about which models are reachable.
- No restart backoff: a child that dies instantly is respawned once per `intervalMs`. If the binary is missing or the port is held by a foreign process, the logs will say so on every pass rather than spinning.
- `windowsHide: true` is set on spawn, so a supervised console child does not flash a window on Windows.
- Linux and macOS work with the same code; only the default paths in `cordis.patch.yml` are Windows-specific.

## Related

- [codex-chat-bridge](https://github.com/kangjiazhen/codex-chat-bridge) — the Responses → chat/completions bridge this plugin can supervise.
- [LiteLLM](https://github.com/BerriAI/litellm), [one-api](https://github.com/songquanpeng/one-api), [new-api](https://github.com/Calcium-Ion/new-api) — full gateways, if you need routing and key management rather than local process supervision.

## License

MIT
