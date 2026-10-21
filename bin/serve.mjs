#!/usr/bin/env node
/**
 * Run the bundled Responses bridge standalone, without a harness.
 *
 * The plugin supervises the bridge while DSH is running, but Codex can be opened
 * on its own — and then nothing has started the bridge. This entry reuses the
 * same derivation the supervisor uses (`bridgeLaunchSpec`), so a standalone run
 * and a supervised run cannot drift apart: same upstream, same bearer read out of
 * the gateway's `config.json`, same `conversation_id=auto`.
 *
 * Usage
 *   node bin/serve.mjs [--port 7864] [--gateway http://127.0.0.1:7863]
 *                      [--gateway-dir <dir>] [--allow a,b,c]
 *
 * Env equivalents
 *   CCB_PORT / CCB_UPSTREAM / CCB_GATEWAY_DIR / CCB_MODEL_ALLOWLIST
 *
 * Anything else (CCB_API_KEY, CCB_CONVERSATION_ID, ...) is passed straight
 * through to the bridge when set explicitly, so this stays usable as a thin
 * wrapper rather than a second configuration surface.
 */
import { spawn } from 'node:child_process';
import { BRIDGE_ENTRY, bridgeLaunchSpec, readGatewayApiKey } from '../lib/supervisor.js';

const argv = process.argv.slice(2);

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Run the bundled Responses bridge standalone.

Options
  --port <n>           Listen port (default 7864, env CCB_PORT)
  --gateway <url>      Gateway base URL (default http://127.0.0.1:7863, env CCB_UPSTREAM)
  --gateway-dir <dir>  Directory holding the gateway config.json (env CCB_GATEWAY_DIR)
  --allow <a,b,c>      Model allowlist (env CCB_MODEL_ALLOWLIST)
  -h, --help           Show this help

The bearer is read from <gateway-dir>/config.json unless CCB_API_KEY is set.`);
  process.exit(0);
}

const port = flag('port', process.env.CCB_PORT || '7864');
const gateway = flag('gateway', process.env.CCB_UPSTREAM || 'http://127.0.0.1:7863');
const gatewayDir =
  flag('gateway-dir', process.env.CCB_GATEWAY_DIR) ||
  '~/Documents/deepseek-harness/default-workspace/workbuddy2api-panel';
const allow = flag('allow', process.env.CCB_MODEL_ALLOWLIST || '');

// `bridgeLaunchSpec` reads `config.gateway.baseURL` and `config.bridge.*`, and
// resolves the key itself; building a minimal config here keeps this entry from
// growing its own copy of that logic.
const spec = bridgeLaunchSpec(
  {
    gatewayDir,
    gateway: { baseURL: gateway },
    bridge: {
      baseURL: `http://127.0.0.1:${port}`,
      command: '',
      args: [],
      env: {},
      upstream: '',
      apiKey: process.env.CCB_API_KEY || '',
      conversationId: process.env.CCB_CONVERSATION_ID ?? 'auto',
      modelAllowlist: allow ? allow.split(',').map((s) => s.trim()).filter(Boolean) : [],
    },
  },
  {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
  },
);

if (!spec.env.CCB_API_KEY) {
  // Not fatal: a gateway with auth disabled is a legitimate setup. But say what
  // will happen, because the usual failure is a bare 401 with no explanation.
  const found = readGatewayApiKey(gatewayDir);
  console.warn(
    `no api key — the gateway will answer 401 to every request ` +
      `(looked in ${found.path}: ${found.error}; or set CCB_API_KEY)`,
  );
}

console.log(`bridge ${BRIDGE_ENTRY}`);
console.log(`  listening : http://127.0.0.1:${port}`);
console.log(`  upstream  : ${spec.env.CCB_UPSTREAM}`);
console.log(`  gatewayDir: ${gatewayDir}`);

const child = spawn(spec.command, spec.args, {
  env: { ...process.env, ...spec.env },
  stdio: 'inherit',
  windowsHide: true,
});

// Forward the signals a service manager actually sends; the bridge has no
// graceful drain of its own, so a plain forward is the honest thing to do.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
child.on('exit', (code) => process.exit(code ?? 0));
