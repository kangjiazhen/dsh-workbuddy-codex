/**
 * dsh-workbuddy-stack — keep the WorkBuddy reverse-proxy chain alive.
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
 * It deliberately does NOT reimplement the gateway. It only orchestrates
 * processes that already exist on disk. Provider registration is left to
 * `dsh-llm-workbuddy` — this plugin's job is to make sure the port it talks to
 * is actually answering.
 *
 * Namespace plugin (named exports, no default export).
 * @module dsh-workbuddy-stack
 */
import z from '@deepseek-ai/schemastery';
import {
  ManagedProcess,
  healthURLFor,
  normalizeV1,
  probe,
  resolveCommand,
  startSupervisor,
  superviseOnce,
} from './supervisor.js';

export const name = 'workbuddy-stack';

/**
 * No hard dependencies: supervision is useful even in a composition without the
 * tools seam, so the plugin must never be held back waiting for one. The status
 * tool attaches later through `ctx.inject(['tools'], …)`, the same pattern
 * `dsh-llm-workbuddy` uses for its optional `webServer` routes.
 */
export const inject = [];

/** Default install directory of the gateway, relative to the user's home. */
export const DEFAULT_GATEWAY_DIR = 'Documents/deepseek-harness/default-workspace/workbuddy2api-panel';

/** Default install directory of the Responses bridge, as a sibling project. */
export const DEFAULT_BRIDGE_DIR = 'Documents/deepseek-harness/default-workspace/codex-chat-bridge';

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
  command: z.string(),
  /** Arguments passed to `command`. */
  args: z.array(z.string()).default([]),
  /** Working directory for the child. Empty = the harness process's cwd. */
  cwd: z.string().default(''),
  /**
   * Status codes that count as "alive" on the health endpoint. Empty = any 2xx.
   * The gateway answers 503 while running without a usable account, which must
   * not be read as "not started".
   */
  acceptStatus: z.array(z.natural()).default([200, 503]),
});

export const Config = z.object({
  /** How often to re-probe the services. */
  intervalMs: z.natural().min(2000).default(15000),
  /** Per-probe timeout. */
  probeTimeoutMs: z.natural().min(200).default(2000),
  /** The reverse-proxy gateway. */
  gateway: ServiceConfig,
  /** The Responses API bridge used by Codex. */
  bridge: ServiceConfig,
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
 */
export function buildServices(config, logger) {
  const opts = { logger, probeTimeoutMs: config.probeTimeoutMs };
  const services = [];

  for (const key of ['gateway', 'bridge']) {
    const svc = config[key];
    if (!svc?.enabled) continue;
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
          precheckPath: precheckFor(svc.command),
        },
        opts,
      ),
    });
  }
  return services;
}

/** Human-readable one-liner per service, for the status tool. */
export async function describeServices(services, probeTimeoutMs = 2000) {
  return Promise.all(
    services.map(async (svc) => {
      const url = healthURLFor(svc.baseURL);
      const healthy = await probe(url, probeTimeoutMs, svc.acceptStatus);
      return {
        service: svc.label,
        baseURL: svc.baseURL,
        healthURL: url,
        healthy,
        state: svc.process.lastState ?? 'unknown',
        pid: svc.process.pid,
        autostart: svc.spawnIfDown !== false,
        lastError: svc.process.lastError?.message ?? null,
      };
    }),
  );
}

/**
 * Register the status tool if the `tools` seam is mounted.
 *
 * `defineTool` lives in `@deepseek-ai/dsh-tools`, which the harness supplies at
 * runtime rather than through the profile's `node_modules` — so it is resolved
 * lazily and the plain descriptor is used when it is not importable. A missing
 * helper must not cost us the tool, and a missing seam must not cost us the
 * supervisor.
 */
async function registerStatusTool(ctx, services, probeTimeoutMs) {
  let define = (x) => x;
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (typeof mod.defineTool === 'function') define = mod.defineTool;
  } catch {
    /* helper unavailable: the raw descriptor is still valid */
  }

  ctx.inject(['tools'], (toolsCtx) => {
    if (typeof toolsCtx.tools?.register !== 'function') return;
    try {
      toolsCtx.tools.register(
        define({
          name: 'workbuddy_stack_status',
          description:
            'Report whether the local WorkBuddy reverse-proxy gateway and the Codex Responses bridge are running. Probes each health endpoint live and includes the supervised child pid, so a down service is distinguishable from a misconfigured provider.',
          parameters: {},
          async execute() {
            const rows = await describeServices(services, probeTimeoutMs);
            const lines = rows.map(
              (r) =>
                `${r.service}: ${r.healthy ? 'up' : 'DOWN'} ` +
                `(${r.healthURL}${r.pid ? `, pid ${r.pid}` : ''}${r.autostart ? '' : ', autostart off'})` +
                (r.lastError ? ` — last error: ${r.lastError}` : ''),
            );
            return { ok: rows.every((r) => r.healthy), services: rows, summary: lines.join('\n') };
          },
        }),
      );
    } catch (e) {
      ctx.logger.warn(`dsh-workbuddy-stack: could not register status tool: ${e.message}`);
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
  const services = buildServices(config, ctx.logger);

  if (services.length === 0) {
    ctx.logger.info('dsh-workbuddy-stack: every service is disabled, nothing to supervise');
    return;
  }

  ctx.logger.info(
    `dsh-workbuddy-stack: supervising ${services.map((s) => `${s.label}@${s.baseURL}`).join(', ')}`,
  );

  const stopSupervisor = startSupervisor(services, {
    intervalMs: config.intervalMs,
    probeTimeoutMs: config.probeTimeoutMs,
    logger: ctx.logger,
  });

  ctx.effect(() => stopSupervisor);

  // Fire and forget: registration must not delay the supervision pass.
  registerStatusTool(ctx, services, config.probeTimeoutMs).catch((e) => {
    ctx.logger.warn(`dsh-workbuddy-stack: status tool unavailable: ${e.message}`);
  });
}

export { ManagedProcess, healthURLFor, normalizeV1, probe, resolveCommand, startSupervisor, superviseOnce };
