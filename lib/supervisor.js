/**
 * dsh-workbuddy-codex — process supervisor (no DSH dependencies)
 * ------------------------------------------------------------------
 * Kept free of `@deepseek-ai/*` imports so it can be unit-tested standalone.
 * `lib/index.js` is the thin DSH plugin wrapper around this.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Probe a URL; resolves true when it answers with an acceptable status.
 *
 * `accept` exists because a service can be perfectly alive and still return a
 * non-2xx health code: the wb2api gateway answers `503` on `/healthz` while it
 * is running but has no usable upstream account. Treating that as "down" would
 * make the supervisor spawn a second copy of an already-running gateway.
 */
export async function probe(url, timeoutMs = 2000, accept = null) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    // Drain so the socket is released.
    await r.text().catch(() => {});
    if (Array.isArray(accept) && accept.length > 0) return accept.includes(r.status);
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Normalize a base URL to exactly one trailing `/v1`.
 * Accepts `http://host:port`, `http://host:port/`, `http://host:port/v1`.
 */
export function normalizeV1(raw) {
  const t = String(raw || '').trim().replace(/\/+$/, '');
  if (!t) throw new Error('dsh-workbuddy-codex: baseURL must be non-empty');
  return /\/v1$/.test(t) ? t : `${t}/v1`;
}

/** Health endpoint for a gateway-style base URL (`…/v1` -> `…/healthz`). */
export function healthURLFor(baseURL) {
  return String(baseURL).replace(/\/v1\/?$/, '') + '/healthz';
}

/**
 * Expand `~`, `$VAR`/`${VAR}` and Windows `%VAR%` in a configured path.
 *
 * Config files cannot rely on the shell to expand these, and hard-coding an
 * absolute home directory would make the plugin unusable on any other machine.
 */
export function expandPath(raw) {
  let p = String(raw ?? '');
  if (!p) return p;
  p = p.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, k) => process.env[k] ?? m);
  p = p.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => process.env[a ?? b] ?? m);
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return resolve(homedir(), p.slice(2));
  return p;
}

/**
 * Resolve a command that may be absolute, relative to the plugin root, or a
 * bare executable name on PATH. Returns the string to hand to `spawn`.
 */
export function resolveCommand(command) {
  const c = expandPath(command).trim();
  if (!c) throw new Error('dsh-workbuddy-codex: command must be non-empty');
  if (isAbsolute(c)) return c;
  if (c.startsWith('./') || c.startsWith('../')) return resolve(PLUGIN_ROOT, c);
  return c; // bare name: let the OS resolve it via PATH
}

/** Absolute path of the bridge entry this package ships. */
export const BRIDGE_ENTRY = resolve(PLUGIN_ROOT, 'bridge', 'codex-chat-bridge.mjs');

/**
 * Read the gateway's own `api_key` out of its `config.json`.
 *
 * The gateway rejects every request without it (401), and the bridge is the
 * process that has to present it, so the two cannot be configured
 * independently without asking the user to copy a secret by hand. Reading the
 * file the gateway already trusts keeps a single source of truth; an absent or
 * unreadable file is not an error here, because a gateway configured with a
 * different auth scheme is a legitimate setup.
 *
 * @param {string} gatewayDir Directory holding the gateway's `config.json`.
 * @returns {{ apiKey: string|null, path: string, error: string|null }}
 */
export function readGatewayApiKey(gatewayDir) {
  const path = resolve(expandPath(gatewayDir || '.'), 'config.json');
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    const key = parsed?.api_key ?? parsed?.apiKey ?? null;
    if (typeof key === 'string' && key.trim()) return { apiKey: key.trim(), path, error: null };
    return { apiKey: null, path, error: 'no `api_key` field in config.json' };
  } catch (e) {
    return { apiKey: null, path, error: e.code === 'ENOENT' ? 'config.json not found' : e.message };
  }
}

/**
 * Build the argv and environment for the Responses bridge.
 *
 * Everything the bridge needs is derived here rather than left to the user's
 * `cordis.yml`: the upstream defaults to the gateway this plugin already
 * supervises, the bearer is read from that gateway's own `config.json`, and the
 * conversation id defaults to `auto`. Getting any of those wrong is not a
 * cosmetic mistake — a bridge pointed at the wrong port just fails, but a
 * bridge missing `conversation_id` makes the upstream answer `400 / 11-128`,
 * which the gateway classifies as an account fault and answers by disabling the
 * account.
 *
 * @param {object} config A resolved plugin config.
 * @param {{info: Function, warn: Function}} logger
 * @returns {{ command: string, args: string[], env: object, cwd: string|undefined, notes: string[] }}
 */
export function bridgeLaunchSpec(config, logger) {
  const notes = [];
  const bridge = config.bridge;
  const gatewayBase = normalizeV1(config.gateway.baseURL);

  const upstream = bridge.upstream ? normalizeV1(bridge.upstream) : gatewayBase;
  if (!bridge.upstream) notes.push(`upstream defaults to the supervised gateway (${upstream})`);

  const command = bridge.command || process.execPath;
  const args = bridge.command
    ? [...bridge.args]
    : [BRIDGE_ENTRY, ...bridge.args, '--port', String(portOf(bridge.baseURL)), '--upstream', upstream];

  // The bridge takes its port from `--port` or CCB_PORT; when a custom command
  // is configured, the env is the only channel we can rely on.
  const env = { ...bridge.env };
  if (bridge.command) env.CCB_PORT = String(portOf(bridge.baseURL));

  env.CCB_UPSTREAM = upstream;
  env.CCB_HOST = hostOf(bridge.baseURL);
  if (bridge.conversationId) env.CCB_CONVERSATION_ID = bridge.conversationId;

  if (bridge.apiKey) {
    env.CCB_API_KEY = bridge.apiKey;
  } else {
    const found = readGatewayApiKey(config.gatewayDir);
    if (found.apiKey) {
      env.CCB_API_KEY = found.apiKey;
      notes.push(`bearer read from ${found.path}`);
    } else {
      logger.warn(
        `dsh-workbuddy-codex: no bridge api key — set bridge.apiKey or fix ${found.path} ` +
          `(${found.error}). The gateway answers 401 to every request without it.`,
      );
    }
  }

  if (bridge.modelAllowlist?.length > 0) env.CCB_MODEL_ALLOWLIST = bridge.modelAllowlist.join(',');
  if (!env.CCB_CONVERSATION_ID) {
    logger.warn(
      'dsh-workbuddy-codex: bridge.conversationId is empty — a WorkBuddy gateway answers 400 ' +
        '(code 11-128) to requests without conversation headers and then disables the account.',
    );
  }

  return {
    command,
    args,
    env,
    cwd: bridge.cwd || undefined,
    notes,
  };
}

/** `http://host:port/...` -> port number, defaulting to 7864. */
function portOf(baseURL) {
  try {
    return Number(new URL(baseURL).port || 7864);
  } catch {
    return 7864;
  }
}

/** `http://host:port/...` -> host, defaulting to 127.0.0.1. */
function hostOf(baseURL) {
  try {
    return new URL(baseURL).hostname || '127.0.0.1';
  } catch {
    return '127.0.0.1';
  }
}

/**
 * A supervised child. Tracks state so the supervisor can log transitions only
 * and avoid spawning duplicates.
 */
export class ManagedProcess {
  /**
   * @param {string} label
   * @param {{command: string, args?: string[], cwd?: string, env?: object}} spec
   * @param {{logger?: any, probeTimeoutMs?: number}} opts
   */
  constructor(label, spec, opts = {}) {
    this.label = label;
    this.spec = spec;
    this.logger = opts.logger ?? console;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 2000;
    this.child = null;
    this.lastState = null; // 'up' | 'down' | 'starting' | 'failed'
    this.restarts = 0;
    this.lastError = null;
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  /** Set the observable state, logging only on change. */
  setState(state, detail) {
    if (state === this.lastState) return;
    const prev = this.lastState;
    this.lastState = state;
    const tag = `dsh-workbuddy-codex[${this.label}]`;
    if (state === 'up') {
      this.logger.info(`${tag}: healthy${detail ? ` (${detail})` : ''}`);
    } else if (state === 'starting') {
      this.logger.info(`${tag}: starting${detail ? ` (${detail})` : ''}`);
    } else if (state === 'failed') {
      this.logger.warn(`${tag}: ${detail ?? 'failed'}`);
    } else if (prev && state === 'down') {
      this.logger.warn(`${tag}: went down${detail ? ` (${detail})` : ''}`);
    }
  }

  /**
   * Start the child if it is not already running. Returns true when a spawn
   * was attempted.
   */
  start() {
    if (this.child && this.child.exitCode === null && !this.child.killed) return false;
    if (this.spec.precheckPath && !existsSync(this.spec.precheckPath)) {
      this.setState('failed', `missing ${this.spec.precheckPath}`);
      return false;
    }
    const command = resolveCommand(this.spec.command);
    // Only expand args that are clearly paths; a literal `$` inside a model name
    // or prompt must survive untouched.
    const args = (this.spec.args ?? []).map((a) =>
      typeof a === 'string' && (a.startsWith('~') || /^%[A-Za-z_]+%/.test(a)) ? expandPath(a) : a,
    );
    let child;
    try {
      child = spawn(command, args, {
        cwd: this.spec.cwd ? expandPath(this.spec.cwd) : undefined,
        env: { ...process.env, ...(this.spec.env || {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      this.lastError = e;
      this.setState('failed', `spawn threw: ${e.message}`);
      return false;
    }
    this.child = child;
    this.setState('starting', `${command} ${args.join(' ')}`.trim());

    // Keep the tail of stderr so a crash is explainable instead of silent.
    let tail = '';
    const collect = (buf) => {
      tail = (tail + String(buf)).slice(-600);
    };
    child.stderr?.on('data', collect);
    child.stdout?.on('data', collect);

    child.on('error', (e) => {
      this.lastError = e;
      this.setState('failed', `child error: ${e.message}`);
    });
    child.on('exit', (code, signal) => {
      this.child = null;
      if (this.disposing) return;
      const why = signal ? `signal ${signal}` : `code ${code}`;
      this.setState('down', `${why}${tail.trim() ? `; last output: ${tail.trim().split('\n').slice(-3).join(' | ')}` : ''}`);
    });
    return true;
  }

  /** Terminate the child, waiting briefly for a graceful exit. */
  async stop(graceMs = 1500) {
    this.disposing = true;
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    await new Promise((r) => {
      const t = setTimeout(r, graceMs);
      child.once('exit', () => { clearTimeout(t); r(); });
    });
    if (child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }
}

/**
 * One supervision pass: ensure each service is either already answering or
 * spawned. Idempotent, so it is safe to call on a timer.
 *
 * @param {Array<{label: string, baseURL: string, process: ManagedProcess, spawnIfDown?: boolean, acceptStatus?: number[]}>} services
 * @param {{probeTimeoutMs?: number}} opts
 */
export async function superviseOnce(services, opts = {}) {
  const results = [];
  for (const svc of services) {
    const url = healthURLFor(svc.baseURL);
    const healthy = await probe(url, opts.probeTimeoutMs ?? 2000, svc.acceptStatus);
    if (healthy) {
      svc.process.setState('up', url);
      results.push({ label: svc.label, action: 'none', healthy: true });
      continue;
    }
    if (svc.spawnIfDown === false) {
      svc.process.setState('down', `${url} unreachable, autostart disabled`);
      results.push({ label: svc.label, action: 'none', healthy: false });
      continue;
    }
    const spawned = svc.process.start();
    results.push({ label: svc.label, action: spawned ? 'spawn' : 'skip', healthy: false });
  }
  return results;
}

/**
 * Poll `superviseOnce` until disposed. Resolves immediately; the loop is
 * unref'd so it never keeps the host process alive on its own.
 */
export function startSupervisor(services, opts = {}) {
  const intervalMs = opts.intervalMs ?? 15000;
  const logger = opts.logger ?? console;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      await superviseOnce(services, opts);
    } catch (e) {
      logger.warn(`dsh-workbuddy-codex: supervisor pass failed: ${e.message}`);
    }
  };

  // First pass runs immediately, without blocking apply().
  void tick();
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();

  return async function dispose() {
    stopped = true;
    clearInterval(timer);
    await Promise.all(services.map((s) => s.process.stop()));
  };
}
