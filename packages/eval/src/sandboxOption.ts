// @sunday/eval — `--sandbox` CLI option parsing + availability validation.
//
// Trust model (F12): eval tasks are dev-authored scripts, and by default
// their `run_terminal` calls execute UNSANDBOXED on the host (mode 'off' —
// current behavior, unchanged). Contributed or otherwise untrusted tasks
// MUST run sandboxed (`--sandbox bubblewrap` on Linux, or `--sandbox
// docker` with a toolchain image) or be reviewed before running. Only
// `run_terminal` is sandboxed — the file/git/search tools in a task script
// still run on the host. Live (`--live`) runs do not use this option; the
// daemon applies its own `sunday.sandbox.*` config there.

import {
  checkSandboxAvailable,
  DEFAULT_DOCKER_IMAGE,
  SANDBOX_MODES,
  type SandboxConfig,
  type SandboxMode,
} from '@sunday/tools';

function flagValue(args: string[], name: string): string | undefined {
  const i = args.findIndex((a) => a === name || a.startsWith(name + '='));
  if (i === -1) return undefined;
  const a = args[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : args[i + 1];
}

/**
 * Parse `--sandbox <mode>` / `--sandbox-image <image>` out of an argv tail.
 * Default: mode 'off' (host execution, unchanged). Throws on an unknown
 * mode so a typo can never silently run unsandboxed.
 */
export function parseSandboxOption(args: string[]): SandboxConfig {
  const modeRaw = flagValue(args, '--sandbox');
  const mode = (modeRaw ?? 'off').trim();
  if (!(SANDBOX_MODES as readonly string[]).includes(mode)) {
    throw new Error(`--sandbox must be one of ${SANDBOX_MODES.join(', ')} (got "${mode}")`);
  }
  const dockerImage = flagValue(args, '--sandbox-image') ?? DEFAULT_DOCKER_IMAGE;
  return { mode: mode as SandboxMode, dockerImage };
}

/**
 * Fail fast when a requested sandbox backend is unavailable (docker CLI
 * missing, `bwrap` missing, bubblewrap on non-Linux). Throws with the
 * human-readable reason from the availability check — call before any
 * task runs so a missing backend never degrades to unsandboxed execution.
 */
export function assertSandboxAvailable(config: SandboxConfig): void {
  const avail = checkSandboxAvailable(config.mode);
  if (!avail.ok) throw new Error(`eval sandbox unavailable: ${avail.reason}`);
}
