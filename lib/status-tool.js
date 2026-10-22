/**
 * The model-facing `workbuddy_codex_status` tool.
 *
 * `tools.register()` rejects any definition that does not declare
 * `output { schema, render }`, and it validates the returned value against that
 * schema on every call — an undeclared field is a runtime failure, not a
 * nicety. The contract therefore lives here, in one place, rather than inline
 * at the registration site.
 *
 * The module deliberately imports nothing from the harness so plain
 * `node --test` can assert the shape without the DSH `node_modules`.
 * @module dsh-workbuddy-codex/status-tool
 */
import { PROVIDER } from './provider.js';
import { describeServices } from './supervisor.js';

/**
 * Output schema of the status tool.
 *
 * `additionalProperties: false` plus a matching `required` list is the whole
 * point: the detail rows ride inside `summary`, so the value stays exactly
 * `{ ok, summary }` and cannot drift out of the declared schema.
 */
export const STATUS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    summary: { type: 'string', required: true },
  },
};

/**
 * Build the status tool descriptor.
 *
 * @param {object} input
 * @param {Array<object>} input.services - supervised services from `buildServices`.
 * @param {number} input.probeTimeoutMs - per-probe timeout.
 * @param {{status?: string, baseURL?: string}} input.providerState - live provider state,
 *   read at call time so it reflects later mount decisions.
 * @returns {object} a `defineTool()`-compatible descriptor.
 */
export function statusToolDefinition({ services, probeTimeoutMs, providerState }) {
  return {
    name: 'workbuddy_codex_status',
    description:
      'Report whether the local WorkBuddy reverse-proxy gateway, the Codex Responses bridge and the WorkBuddy model provider are up. Probes each health endpoint live and includes the supervised child pid, so a down service is distinguishable from a misconfigured provider.',
    parameters: {},
    output: {
      schema: STATUS_OUTPUT_SCHEMA,
      render(_args, value) {
        return value.summary;
      },
    },
    async execute() {
      const rows = await describeServices(services, probeTimeoutMs);
      const provider = { ...providerState };
      const lines = rows.map(
        (r) =>
          `${r.service}: ${r.healthy ? 'up' : 'DOWN'} ` +
          `(${r.healthURL}${r.pid ? `, pid ${r.pid}` : ''}${r.autostart ? '' : ', autostart off'})` +
          (r.lastError ? ` — last error: ${r.lastError}` : ''),
      );
      lines.push(
        `provider ${PROVIDER}: ${
          provider.status === 'mounted'
            ? `registered at ${provider.baseURL}`
            : provider.status ?? 'pending'
        }`,
      );
      return { ok: rows.every((r) => r.healthy), summary: lines.join('\n') };
    },
  };
}
