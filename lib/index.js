/**
 * dsh-workbuddy-codex — keep the WorkBuddy reverse-proxy chain alive.
 *
 * Two local services have to be running before this harness can talk to the
 * WorkBuddy models, and neither of them is installed as a Windows service:
 *
 *   127.0.0.1:7863  wb2api gateway            (OpenAI-compatible /v1/chat/completions)
 *   127.0.0.1:7864  codex-chat-bridge        (Responses API -> chat/completions)
 *
 * Historically both had to be started by hand, and a reboot silently left the
 * model picker pointing at a dead port. This plugin supervises them: on load it
 * probes each health endpoint, spawns whatever is missing, and re-checks on a
 * timer so a crashed process is brought back.
 *
 * It deliberately does NOT reimplement the gateway, and it does not reimplement
 * the WorkBuddy LLM adapter either: the `workbuddy` provider route is mounted by
 * delegating to `dsh-llm-workbuddy` (see ./provider.js), so one install gives the
 * model picker its provider *and* gives Codex a Responses endpoint — the routes
 * that already exist are reused, not forked.
 *
 * Namespace plugin (named exports, no default export).
 * @module dsh-workbuddy-codex
 */
import z from '@deepseek-ai/schemastery';
import { mountProvider, PROVIDER, providerAlreadyServed, resolveProviderConfig } from './provider.js';
import { statusToolDefinition } from './status-tool.js';
import {
  ManagedProcess,
  bridgeLaunchSpec,
  describeServices,
  normalizeV1,
  resolveCommand,
  startSupervisor,
  superviseOnce,
} from './supervisor.js';

export const name = 'workbuddy-codex';

/**
 * No hard dependencies: supervision is useful even in a composition without the
 * tools seam, so the plugin must never be held back waiting for one. The status
 * tool attaches later through `ctx.inject(['tools'], …)`, the same pattern
 * `dsh-llm-workbuddy` uses for its optional `webServer` routes.
 */
export const inject = [];

/** Default install directory of the gateway, relative to the user's home. */
export const DEFAULT_GATEWAY_DIR = '~/Documents/deepseek-harness/default-workspace/workbuddy2api-panel';

const ServiceConfig = z.object({
  /** Supervise this service at all. */
  enabled: z.boolean().default(true),
  /** Start it when the health probe fails. False = observe only. */
  autostart: z.boolean().default(true),
  /**
   * Base URL to probe, without needing to agree with what the provider plugin
   * uses — this is the supervisor's own view of "is it up".
   */
  baseURL: z.string(),
  /** Executable to spawn. Bare names resolve on PATH, `./x` against the plugin root. */
  command: z.string().default(''),
  /** Arguments passed to `command`. */
  args: z.array(z.string()).default([]),
  /** Working directory for the child. Empty = the harness process's cwd. */
  cwd: z.string().default(''),
  /** Extra environment for the child, on top of the harness's own. */
  env: z.dict(z.string()).default({}),
  /**
   * Status codes that count as "alive" on the health endpoint. Empty = any 2xx.
   * The gateway answers 503 while running without a usable account, which must
   * not be read as "not started".
   */
  acceptStatus: z.array(z.natural()).default([200, 503]),
});

/**
 * The Responses bridge has its own knobs, because asking a user to hand-write
 * the bridge's argv and env is where this chain usually breaks: the API key has
 * to match the gateway's, and a missing `conversation_id` makes the upstream
 * answer 400 and the gateway disable the account.
 */
const BridgeConfig = z.object({
  enabled: z.boolean().default(true),
  autostart: z.boolean().default(true),
  baseURL: z.string().default('http://127.0.0.1:7864'),
  /** Leave empty to run the bridge this package ships. */
  command: z.string().default(''),
  args: z.array(z.string()).default([]),
  cwd: z.string().default(''),
  env: z.dict(z.string()).default({}),
  acceptStatus: z.array(z.natural()).default([200]),
  /** Chat Completions backend. Empty = the gateway's own baseURL. */
  upstream: z.string().default(''),
  /** Bearer for the upstream. Empty = read `api_key` from the gateway's config.json. */
  apiKey: z.string().default(''),
  /**
   * `auto` sends a per-session `metadata.conversation_id`. Not optional against
   * a WorkBuddy gateway: it answers 400 / code 11-128 without the conversation
   * headers, and the gateway reads that as an account fault.
   */
  conversationId: z.string().default('auto'),
  /** Models the bridge will forward. Empty = forward everything. */
  modelAllowlist: z.array(z.string()).default([]),
  /**
   * Fail-fast prompt ceiling in tokens; 0 disables it. Above it the bridge
   * answers 413 locally instead of forwarding a body the upstream will reject
   * with 400 `prompt_too_long` — a 400 that carries no `usage`, which is what
   * leaves a client resending the same oversized history forever.
   */
  maxPromptTokens: z.natural().default(0),
});

/**
 * The WorkBuddy provider route.
 *
 * Empty `baseURL` means "follow `gateway.baseURL`", and empty `apiKey` means
 * "read the gateway's own `config.json`" — the same single source of truth the
 * bridge uses, so the three halves of the chain cannot be pointed at different
 * ports or keys by accident.
 */
const ProviderConfig = z.object({
  /** Register the `workbuddy` route at all. */
  enabled: z.boolean().default(true),
  /** Gateway base URL for the adapter. Empty = `gateway.baseURL`. */
  baseURL: z.string().default(''),
  /** Bearer for the adapter. Empty = the gateway's `config.json` `api_key`. */
  apiKey: z.string().default(''),
  /** Ask the gateway's `/v1/models` for the live catalog. */
  discovery: z.boolean().default(true),
  /** Claim the daily WorkBuddy checkin. */
  autoCheckin: z.boolean().default(true),
  /** Local hour (0-23) after which the daily checkin is claimed. */
  checkinAfterHour: z.natural().min(0).max(23).default(10),
});

export const Config = z.object({
  /** How often to re-probe the services. */
  intervalMs: z.natural().min(2000).default(15000),
  /** Per-probe timeout. */
  probeTimeoutMs: z.natural().min(200).default(2000),
  /** Directory holding the gateway's `config.json`; the bridge reads its key from there. */
  gatewayDir: z.string().default(DEFAULT_GATEWAY_DIR),
  /** The WorkBuddy LLM provider route (delegated to `dsh-llm-workbuddy`). */
  provider: ProviderConfig,
  /** The reverse-proxy gateway. */
  gateway: ServiceConfig,
  /** The Responses API bridge used by Codex. */
  bridge: BridgeConfig,
});

/** True when `p` exists and is a file (used to skip spawning missing binaries). */
function precheckFor(command) {
  try {
    const resolved = resolveCommand(command);
    // Bare names (e.g. `node`) must not be prechecked — PATH resolution is the
    // OS's job, and a false negative here would silently disable autostart.
    return resolved === command ? undefined : resolved;
  } catch {
    return undefined;
  }
}

/**
 * Build the supervised service list from config. Exported so the tests can
 * exercise the mapping without mounting a harness.
 *
 * A half-filled service entry is skipped with a warning rather than thrown on:
 * a stale `cordis.yml` from another machine should cost that one service, not
 * the whole plugin — the other half of the chain may still be worth watching.
 */
export function buildServices(config, logger) {
  const opts = { logger, probeTimeoutMs: config.probeTimeoutMs };
  const services = [];

  for (const key of ['gateway', 'bridge']) {
    const svc = config[key];
    if (!svc?.enabled) continue;
    if (!svc.baseURL || !svc.command) {
      logger.warn(
        `dsh-workbuddy-codex: skipping ${key} — both baseURL and command are required ` +
          `(got baseURL=${JSON.stringify(svc.baseURL ?? null)}, command=${JSON.stringify(svc.command ?? null)})`,
      );
      continue;
    }
    const baseURL = normalizeV1(svc.baseURL);
    services.push({
      label: key,
      baseURL,
      spawnIfDown: svc.autostart,
      acceptStatus: svc.acceptStatus,
      process: new ManagedProcess(
        key,
        {
          command: svc.command,
          args: svc.args,
          cwd: svc.cwd || undefined,
          env: svc.env,
          precheckPath: precheckFor(svc.command),
        },
        opts,
      ),
    });
  }
  return services;
}

/**
 * Register the status tool if the `tools` seam is mounted.
 *
 * `defineTool` lives in `@deepseek-ai/dsh-tools`, which the harness supplies at
 * runtime rather than through the profile's `node_modules`, so it is resolved
 * lazily. When it cannot be resolved the tool is skipped with a warning instead
 * of registering a raw descriptor: `tools.register()` requires the `defineTool`
 * shape and would reject ours. A missing helper must not cost us the supervisor,
 * and a missing seam must not cost us the tool registration on other profiles.
 */
async function registerStatusTool(ctx, services, probeTimeoutMs, providerState) {
  let defineTool = null;
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (typeof mod.defineTool === 'function') defineTool = mod.defineTool;
  } catch {
    /* resolved below */
  }
  if (!defineTool) {
    ctx.logger.warn(
      'dsh-workbuddy-codex: @deepseek-ai/dsh-tools is not resolvable, so the workbuddy_codex_status tool stays unregistered',
    );
    return;
  }

  ctx.inject(['tools'], (toolsCtx) => {
    if (typeof toolsCtx.tools?.register !== 'function') return;
    try {
      toolsCtx.tools.register(
        defineTool(statusToolDefinition({ services, probeTimeoutMs, providerState })),
      );
    } catch (e) {
      ctx.logger.warn(`dsh-workbuddy-codex: could not register status tool: ${e.message}`);
    }
  });
}

/**
 * Mount the supervisor.
 *
 * The first pass runs asynchronously right after load so a cold start does not
 * block the harness; the returned disposer stops the timer and terminates any
 * child this plugin spawned itself.
 */
export function apply(ctx, config) {
  // Resolve the bridge's launch spec once, before the service list is built: the
  // argv and env are derived (shipped entry, gateway upstream, gateway's own api
  // key, `conversation_id=auto`) rather than copied out of `cordis.yml`, so the
  // user only has to say where the gateway lives.
  const effective = { ...config, bridge: { ...config.bridge } };
  if (effective.bridge.enabled) {
    const spec = bridgeLaunchSpec(config, ctx.logger);
    effective.bridge.command = spec.command;
    effective.bridge.args = spec.args;
    effective.bridge.env = { ...config.bridge.env, ...spec.env };
    effective.bridge.cwd = spec.cwd ?? '';
    for (const note of spec.notes) ctx.logger.info(`dsh-workbuddy-codex[bridge]: ${note}`);
  }

  const services = buildServices(effective, ctx.logger);

  // The provider route is mounted before the first supervision pass: the model
  // picker listing no WorkBuddy provider at all is the more visible failure, and
  // registration does not need the gateway to already be answering.
  const providerState = { status: config.provider?.enabled === false ? 'disabled' : 'pending' };
  if (config.provider?.enabled !== false) {
    const providerOptions = {
      ...config.provider,
      gatewayBaseURL: config.gateway?.baseURL ?? '',
      gatewayDir: config.gatewayDir,
    };
    // `inject` rather than a direct call: `llm` is a sibling service whose load
    // order is not ours to assume, and the upstream plugin injects it too.
    ctx.inject(['llm'], (llmCtx) => {
      mountProvider(llmCtx, providerOptions, ctx.logger)
        .then((result) => {
          providerState.status = result.mounted ? 'mounted' : result.reason;
          providerState.baseURL = result.baseURL;
          providerState.apiKeySource = result.apiKey;
        })
        .catch((e) => {
          providerState.status = 'error';
          ctx.logger.warn(`dsh-workbuddy-codex: provider mount failed: ${e.message}`);
        });
    });
  }

  if (services.length === 0) {
    ctx.logger.info('dsh-workbuddy-codex: every service is disabled, nothing to supervise');
    return;
  }

  ctx.logger.info(
    `dsh-workbuddy-codex: supervising ${services.map((s) => `${s.label}@${s.baseURL}`).join(', ')}`,
  );

  const stopSupervisor = startSupervisor(services, {
    intervalMs: config.intervalMs,
    probeTimeoutMs: config.probeTimeoutMs,
    logger: ctx.logger,
  });

  ctx.effect(() => stopSupervisor);

  // Fire and forget: registration must not delay the supervision pass.
  registerStatusTool(ctx, services, config.probeTimeoutMs, providerState).catch((e) => {
    ctx.logger.warn(`dsh-workbuddy-codex: status tool unavailable: ${e.message}`);
  });
}

export {
  ManagedProcess,
  describeServices,
  normalizeV1,
  resolveCommand,
  startSupervisor,
  superviseOnce,
};
export { mountProvider, PROVIDER, providerAlreadyServed, resolveProviderConfig };
