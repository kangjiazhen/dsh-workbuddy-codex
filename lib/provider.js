/**
 * Mount the WorkBuddy chat provider route.
 *
 * This plugin's own job is process supervision: it never touches `ctx.llm`. But
 * a user who installs *only* this package still expects the WorkBuddy models to
 * show up in the picker, so the provider route is **delegated** to
 * `dsh-llm-workbuddy` (MIT) instead of being reimplemented here — that package
 * owns a ~2.5k-line adapter, its settings section, the daily checkin scheduler
 * and the login helper, and a second copy of all that would drift the moment
 * either side is updated.
 *
 * Delegation is done with `ctx.plugin()`, the same call `dshmarket` uses to
 * mount a foreign plugin, so the mounted copy lives in this plugin's fiber tree
 * and is disposed with it.
 *
 * The important constraint is that cordis keys plugin runtimes by the `apply`
 * function, and `llm.registerAdapter()` throws `DUPLICATE_ADAPTER` for a route
 * that is already served. A mounted copy and the standalone bundle therefore
 * cannot both own `workbuddy`, so we look at `llm.listProviders()` first and
 * stand down when somebody else already serves the route. That is also what
 * makes the two safe to keep enabled side by side: whoever registers first
 * wins, and the loser does not fault.
 *
 * @module dsh-workbuddy-stack/provider
 */
import { expandPath, normalizeV1, readGatewayApiKey } from './supervisor.js';

/** The npm package that owns the WorkBuddy adapter. */
export const UPSTREAM_PACKAGE = 'dsh-llm-workbuddy';

/** The provider route both this plugin and the upstream package register. */
export const PROVIDER = 'workbuddy';

/**
 * The `llm` service, or `null` when this composition has no llm seam.
 *
 * `ctx.get()` is the non-throwing lookup; a cordis context also exposes the
 * service as a property, but reading it before it is provided throws.
 *
 * @param {object} ctx A cordis context.
 * @returns {object|null}
 */
function llmOf(ctx) {
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined;
    if (viaGet) return viaGet;
  } catch {
    /* fall through to the property form */
  }
  try {
    return ctx?.llm ?? null;
  } catch {
    return null;
  }
}

/**
 * Is the `workbuddy` route already served?
 *
 * `llm` is absent in a composition without the llm seam, in which case nobody
 * can serve the route and the caller must not try to mount either.
 *
 * @param {object} ctx A cordis context.
 * @returns {boolean} True when an adapter already registered the route.
 */
export function providerAlreadyServed(ctx) {
  const llm = llmOf(ctx);
  if (!llm) return false;
  try {
    const providers = llm.listProviders?.();
    if (!Array.isArray(providers)) return false;
    return providers.some((entry) => entry?.id === PROVIDER);
  } catch {
    // A throwing registry is not a reason to skip: mounting will surface the
    // real reason (and is wrapped in its own try/catch).
    return false;
  }
}

/**
 * Resolve the config handed to the upstream plugin.
 *
 * `baseURL` empty means "follow the gateway this plugin supervises", and an
 * empty `apiKey` means "read the gateway's own `config.json`" — the same single
 * source of truth the bridge uses. Asking the user to type the port and the key
 * twice is exactly how these two halves drift apart.
 *
 * @param {object} options Resolved options (see `mountProvider`).
 * @returns {{ baseURL: string, apiKey: string, discovery: boolean, autoCheckin: boolean, checkinAfterHour: number, keySource: string|null, keyError: string|null }}
 */
export function resolveProviderConfig(options) {
  const baseURL = String(options.baseURL || '').trim()
    ? normalizeV1(options.baseURL)
    : normalizeV1(options.gatewayBaseURL || '');

  let apiKey = String(options.apiKey || '').trim();
  let keySource = apiKey ? 'provider.apiKey' : null;
  let keyError = null;
  if (!apiKey) {
    const found = readGatewayApiKey(expandPath(options.gatewayDir || '.'));
    if (found.apiKey) {
      apiKey = found.apiKey;
      keySource = found.path;
    } else {
      keyError = `${found.error} (${found.path})`;
    }
  }

  return {
    baseURL,
    apiKey,
    discovery: options.discovery !== false,
    autoCheckin: options.autoCheckin !== false,
    checkinAfterHour: Number.isInteger(options.checkinAfterHour) ? options.checkinAfterHour : 10,
    keySource,
    keyError,
  };
}

/**
 * Mount the provider route, or explain why it stayed with somebody else.
 *
 * Never throws: a provider that cannot be mounted must not take the supervisor
 * down with it, and the gateway/bridge half of the chain is still worth having.
 *
 * @param {object} ctx A cordis context.
 * @param {object} options `enabled`, `baseURL`, `apiKey`, `discovery`,
 *   `autoCheckin`, `checkinAfterHour`, plus `gatewayBaseURL` and `gatewayDir`
 *   used to derive the connection facts.
 * @param {{info: Function, warn: Function}} logger
 * @returns {Promise<{ mounted: boolean, reason: string, baseURL: string|null, apiKey: string|null }>}
 */
export async function mountProvider(ctx, options, logger) {
  const skip = (reason) => ({ mounted: false, reason, baseURL: null, apiKey: null });

  if (!options?.enabled) {
    logger.info('dsh-workbuddy-stack: provider registration disabled (provider.enabled=false)');
    return skip('disabled');
  }
  if (!llmOf(ctx)) {
    logger.warn(
      'dsh-workbuddy-stack: no llm service in this composition — the WorkBuddy provider ' +
        'cannot be registered. Supervising the gateway and bridge only.',
    );
    return skip('no-llm-service');
  }
  if (providerAlreadyServed(ctx)) {
    logger.info(
      `dsh-workbuddy-stack: provider "${PROVIDER}" is already registered — leaving that route alone`,
    );
    return skip('already-served');
  }

  let resolved;
  try {
    resolved = resolveProviderConfig(options);
  } catch (e) {
    logger.warn(`dsh-workbuddy-stack: provider config is unusable: ${e.message}`);
    return skip('invalid-config');
  }
  if (!resolved.apiKey) {
    logger.warn(
      `dsh-workbuddy-stack: no provider api key — set provider.apiKey or fix the gateway's ` +
        `config.json (${resolved.keyError}). The gateway answers 401 to every request without it.`,
    );
  }

  let mod;
  // Injectable so the tests can exercise the mount and duplicate-route paths
  // without the real package being installed.
  const load = options.importUpstream ?? (() => import(UPSTREAM_PACKAGE));
  try {
    mod = await load();
  } catch (e) {
    logger.warn(
      `dsh-workbuddy-stack: cannot register the "${PROVIDER}" provider because ` +
        `${UPSTREAM_PACKAGE} is not installed (${e.message}). ` +
        `Run \`dsh plugin add ${UPSTREAM_PACKAGE}\`, or set provider.enabled=false to stop trying.`,
    );
    return skip('upstream-missing');
  }

  try {
    // `ctx.plugin()` returns a thenable fiber: awaiting it settles when the
    // upstream's `apply()` has run, which is when the route is actually served.
    await ctx.plugin(mod, {
      baseURL: resolved.baseURL,
      apiKey: resolved.apiKey,
      discovery: resolved.discovery,
      autoCheckin: resolved.autoCheckin,
      checkinAfterHour: resolved.checkinAfterHour,
    });
  } catch (e) {
    const message = String(e?.message ?? e);
    if (e?.code === 'DUPLICATE_ADAPTER' || /already registered/.test(message)) {
      // Lost a race against a standalone bundle loading at the same time.
      logger.info(
        `dsh-workbuddy-stack: provider "${PROVIDER}" was registered by another plugin first — skipping`,
      );
      return skip('already-served');
    }
    logger.warn(`dsh-workbuddy-stack: could not register the "${PROVIDER}" provider: ${message}`);
    return skip('mount-failed');
  }

  logger.info(
    `dsh-workbuddy-stack: registered provider "${PROVIDER}" at ${resolved.baseURL} ` +
      `via ${UPSTREAM_PACKAGE} (key from ${resolved.keySource})`,
  );
  return { mounted: true, reason: 'mounted', baseURL: resolved.baseURL, apiKey: resolved.keySource };
}
