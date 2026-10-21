/**
 * dsh-workbuddy-stack — process supervisor (no DSH dependencies)
 * ------------------------------------------------------------------
 * Kept free of `@deepseek-ai/*` imports so it can be unit-tested standalone.
 * `lib/index.js` is the thin DSH plugin wrapper around this.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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
  if (!t) throw new Error('dsh-workbuddy-stack: baseURL must be non-empty');
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
  if (!c) throw new Error('dsh-workbuddy-stack: command must be non-empty');
  if (isAbsolute(c)) return c;
  if (c.startsWith('./') || c.startsWith('../')) return resolve(PLUGIN_ROOT, c);
  return c; // bare name: let the OS resolve it via PATH
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
    const tag = `dsh-workbuddy-stack[${this.label}]`;
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
      logger.warn(`dsh-workbuddy-stack: supervisor pass failed: ${e.message}`);
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
