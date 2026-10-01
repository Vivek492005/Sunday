// @sunday/sundayd — sandbox configuration.
//
// The `sunday.sandbox.mode` / `sunday.sandbox.dockerImage` VS Code settings
// reach the daemon as environment (see ext-agent sidecar.ts): the extension
// stamps SUNDAY_SANDBOX_MODE / SUNDAY_SANDBOX_DOCKER_IMAGE at spawn. This
// module parses them into the SandboxConfig that the agent loop stamps on
// every ToolContext (see loop.ts). The execution itself lives in
// @sunday/tools (sandbox.ts) so the tool package stays dependency-free.

import {
  DEFAULT_DOCKER_IMAGE,
  SANDBOX_MODES,
  type SandboxConfig,
  type SandboxMode,
} from '@sunday/tools';

export type { SandboxConfig, SandboxMode };

/** Env var carrying `sunday.sandbox.mode` (stamped by the extension). */
export const SANDBOX_MODE_ENV = 'SUNDAY_SANDBOX_MODE';
/** Env var carrying `sunday.sandbox.dockerImage` (stamped by the extension). */
export const SANDBOX_DOCKER_IMAGE_ENV = 'SUNDAY_SANDBOX_DOCKER_IMAGE';

/**
 * Parse a sandbox mode string. Unknown values throw — fail closed: a
 * misconfigured sandbox must never silently degrade to host execution.
 */
export function parseSandboxMode(raw: string | undefined): SandboxMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'off') return 'off';
  if ((SANDBOX_MODES as readonly string[]).includes(v)) return v as SandboxMode;
  throw new Error(
    `invalid ${SANDBOX_MODE_ENV}="${raw}": expected one of ${SANDBOX_MODES.join(', ')}`,
  );
}

/** Build the daemon's SandboxConfig from the environment. */
export function sandboxConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  return {
    mode: parseSandboxMode(env[SANDBOX_MODE_ENV]),
    dockerImage: env[SANDBOX_DOCKER_IMAGE_ENV]?.trim() || DEFAULT_DOCKER_IMAGE,
  };
}

/** One-line human summary for startup logs / diagnostics. */
export function describeSandbox(config: SandboxConfig): string {
  if (config.mode === 'off') return 'sandbox=off (agent commands run on the host)';
  if (config.mode === 'docker') return `sandbox=docker (image ${config.dockerImage}, network disabled)`;
  return 'sandbox=bubblewrap (unshared network namespace, host root read-only)';
}
