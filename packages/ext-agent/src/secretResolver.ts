// sunday-agent — MCP secrets via VS Code SecretStorage (Part A).
//
// mcp.json never holds secrets inline: configs reference `secret:<KEY>` (or
// `${secret:KEY}`). The stdio JSON-RPC protocol is client→daemon only, so the
// daemon cannot ask the extension for secrets at server-start time. Instead,
// the extension pre-resolves every referenced key from SecretStorage when the
// sidecar spawns and hands the values to sundayd as `SUNDAY_MCP_SECRET_*` env
// vars (see SidecarManager `extraEnv`); sundayd's EnvSecretResolver reads them
// back. Adding/changing a secret therefore needs a sidecar restart.

import type { SecretResolver } from '@sunday/mcp';

/** Minimal structural view of vscode.SecretStorage (kept local for tests). */
export interface SecretStore {
  // Thenable, not Promise — vscode's SecretStorage returns Thenable.
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

/** SecretResolver backed by VS Code SecretStorage. */
export class VscodeSecretResolver implements SecretResolver {
  constructor(private readonly secrets: SecretStore) {}

  async resolve(key: string): Promise<string> {
    const value = await this.secrets.get(key);
    if (value === undefined) {
      throw new Error(
        `secret "${key}" is not in SecretStorage — store it with the "MCP: Store Secret" command`,
      );
    }
    return value;
  }
}

/**
 * Env var name carrying a pre-resolved secret into sundayd. Must stay in sync
 * with sundayd's `mcpSecretEnvName` (packages/sundayd/src/trust.ts).
 */
export function secretEnvName(key: string): string {
  return `SUNDAY_MCP_SECRET_${key.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

const SECRET_KEY = '[A-Za-z0-9_.-]+';
const SECRET_REF_RE = new RegExp(`\\$\\{secret:(${SECRET_KEY})\\}|secret:(${SECRET_KEY})`, 'g');

/**
 * Collect every `secret:<key>` / `${secret:<key>}` reference in an mcp.json
 * document (read as text — no need to parse). Order of first appearance,
 * deduplicated.
 */
export function collectSecretKeys(configText: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const m of configText.matchAll(SECRET_REF_RE)) {
    const key = m[1] ?? m[2];
    if (key && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Build the `SUNDAY_MCP_SECRET_*` env block for the sidecar spawn: read the
 * user + workspace mcp.json files, collect referenced keys, resolve each
 * from SecretStorage. Keys missing from storage are skipped (sundayd fails
 * loudly at server start with a clear message). Never throws — a broken
 * config file just yields no secrets.
 */
export async function buildSecretEnv(
  readFile: (path: string) => Promise<string | undefined>,
  userConfigPath: string,
  workspaceConfigPath: string | undefined,
  resolver: SecretResolver,
  log: (msg: string) => void = () => undefined,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  const texts: string[] = [];
  for (const p of [userConfigPath, workspaceConfigPath]) {
    if (!p) continue;
    try {
      const text = await readFile(p);
      if (text !== undefined) texts.push(text);
    } catch (e) {
      log(`MCP secrets: cannot read ${p}: ${(e as Error).message}`);
    }
  }
  const keys = [...new Set(texts.flatMap(collectSecretKeys))];
  for (const key of keys) {
    try {
      env[secretEnvName(key)] = await resolver.resolve(key);
    } catch {
      log(`MCP secrets: "${key}" is referenced by mcp.json but not stored — the server will fail to start until it is stored`);
    }
  }
  return env;
}
