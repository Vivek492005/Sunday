import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { McpApproval, McpTransportKind } from './types.js';

/**
 * `~/.sunday/mcp.json` (user scope) and `<workspace>/.sunday/mcp.json`
 * (workspace scope, requires workspace trust).
 *
 * Secrets are NEVER inline in config. Supported references:
 *   - `${secret:KEY}` or whole-value `secret:KEY` → SecretResolver
 *   - `${env:NAME}` → process.env
 */

/** Per-server entry in mcp.json. */
export interface McpServerConfig {
  transport: McpTransportKind;
  /** stdio: argv, e.g. ["node", "server.js"]. */
  command?: string[];
  /** stdio: working directory for the child (optional). */
  cwd?: string;
  /** stdio: extra env for the child; values may use secret/env references. */
  env?: Record<string, string>;
  /** http: Streamable HTTP endpoint URL. */
  url?: string;
  /** http: request headers; values may use secret references. */
  headers?: Record<string, string>;
  /** Disabled servers are skipped by startAll and refuse explicit start. */
  enabled: boolean;
  /** Per-server default approval posture (risk class M). */
  defaultApproval: McpApproval;
  /** Optional per-tool enable toggles. Denylist wins over allowlist. */
  toolAllowlist?: string[];
  toolDenylist?: string[];
}

/** Top-level mcp.json shape. */
export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

/**
 * Resolves secret references. The extension injects a VS Code SecretStorage
 * backed implementation; sundayd/CLI get a stub that errors clearly.
 */
export interface SecretResolver {
  /** Resolve a secret key to its value. Rejects when unavailable. */
  resolve(key: string): Promise<string>;
}

/** Fallback resolver for environments without a secret store. */
export class NoSecretResolver implements SecretResolver {
  async resolve(key: string): Promise<string> {
    throw new Error(
      `secret "${key}" requested but no SecretResolver is configured ` +
        `(secrets are never stored inline in mcp.json)`,
    );
  }
}

const SECRET_KEY = '[A-Za-z0-9_.-]+';
const WHOLE_SECRET_REF = new RegExp(`^secret:(${SECRET_KEY})$`);

/**
 * Resolve `${secret:KEY}`, whole-value `secret:KEY`, and `${env:NAME}`
 * references in a string. Rejects on unknown env vars / unresolvable secrets.
 */
export async function resolveSecretRefs(
  value: string,
  resolver: SecretResolver,
): Promise<string> {
  const whole = WHOLE_SECRET_REF.exec(value.trim());
  if (whole) return resolver.resolve(whole[1]);

  const secretKeys = new Set<string>();
  const envKeys = new Set<string>();
  for (const m of value.matchAll(new RegExp(`\\$\\{secret:(${SECRET_KEY})\\}`, 'g'))) {
    secretKeys.add(m[1]);
  }
  for (const m of value.matchAll(new RegExp(`\\$\\{env:(${SECRET_KEY})\\}`, 'g'))) {
    envKeys.add(m[1]);
  }

  let out = value;
  for (const key of secretKeys) {
    const resolved = await resolver.resolve(key);
    out = out.split(`\${secret:${key}}`).join(resolved);
  }
  for (const key of envKeys) {
    const resolved = process.env[key];
    if (resolved === undefined) {
      throw new Error(`mcp.json: environment variable "${key}" is not set`);
    }
    out = out.split(`\${env:${key}}`).join(resolved);
  }
  return out;
}

/** Validate + normalize a parsed mcp.json document. Throws on invalid shape. */
export function parseMcpConfig(raw: unknown, source: string): McpConfig {
  const fail = (msg: string): Error => new Error(`mcp.json (${source}): ${msg}`);
  const check = (cond: boolean, msg: string): void => {
    if (!cond) throw fail(msg);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw fail('top level must be an object with a "servers" key');
  }
  const doc = raw as Record<string, unknown>;
  if (typeof doc.servers !== 'object' || doc.servers === null || Array.isArray(doc.servers)) {
    throw fail('"servers" must be an object');
  }

  const servers: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(doc.servers as Record<string, unknown>)) {
    const where = `servers["${name}"]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail(`${where} must be an object`);
    }
    const e = entry as Record<string, unknown>;
    const transport = e.transport;
    check(
      transport === 'stdio' || transport === 'http',
      `${where}.transport must be "stdio" or "http"`,
    );
    const cfg: McpServerConfig = {
      transport: transport as McpTransportKind,
      enabled: e.enabled === undefined ? true : e.enabled === true,
      defaultApproval: e.defaultApproval === 'allow' ? 'allow' : 'ask',
    };
    check(
      typeof e.enabled === 'undefined' || typeof e.enabled === 'boolean',
      `${where}.enabled must be a boolean`,
    );
    check(
      typeof e.defaultApproval === 'undefined' ||
        e.defaultApproval === 'allow' ||
        e.defaultApproval === 'ask',
      `${where}.defaultApproval must be "allow" or "ask"`,
    );
    if (transport === 'stdio') {
      const command = e.command;
      check(
        Array.isArray(command) &&
          command.length > 0 &&
          command.every((c) => typeof c === 'string'),
        `${where}.command must be a non-empty string array for stdio transport`,
      );
      cfg.command = [...(command as string[])];
      if (e.cwd !== undefined) {
        check(typeof e.cwd === 'string', `${where}.cwd must be a string`);
        cfg.cwd = e.cwd as string;
      }
      if (e.env !== undefined) {
        cfg.env = stringRecord(e.env, `${where}.env`, fail);
      }
    } else {
      const url = e.url;
      check(
        typeof url === 'string' && url.length > 0,
        `${where}.url must be a non-empty string for http transport`,
      );
      cfg.url = url as string;
      if (e.headers !== undefined) {
        cfg.headers = stringRecord(e.headers, `${where}.headers`, fail);
      }
    }
    if (e.toolAllowlist !== undefined) {
      cfg.toolAllowlist = stringArray(e.toolAllowlist, `${where}.toolAllowlist`, fail);
    }
    if (e.toolDenylist !== undefined) {
      cfg.toolDenylist = stringArray(e.toolDenylist, `${where}.toolDenylist`, fail);
    }
    servers[name] = cfg;
  }
  return { servers };
}

function stringRecord(
  v: unknown,
  where: string,
  fail: (msg: string) => Error,
): Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw fail(`${where} must be an object`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== 'string') throw fail(`${where}["${k}"] must be a string`);
    out[k] = val as string;
  }
  return out;
}

function stringArray(
  v: unknown,
  where: string,
  fail: (msg: string) => Error,
): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw fail(`${where} must be a string array`);
  }
  return [...(v as string[])];
}

/** Read + parse an mcp.json file. Returns null when the file does not exist. */
export async function loadConfigFile(filePath: string): Promise<McpConfig | null> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`mcp.json (${filePath}): invalid JSON`);
  }
  return parseMcpConfig(raw, filePath);
}

/**
 * Merge user + workspace configs. Workspace entries override user entries by
 * server name. When the workspace is untrusted the workspace config is
 * ignored entirely and `workspaceIgnored` is true.
 */
export function mergeConfigs(
  user: McpConfig | null,
  workspace: McpConfig | null,
  workspaceTrusted: boolean,
): { config: McpConfig; workspaceIgnored: boolean } {
  const workspaceIgnored = !workspaceTrusted && workspace !== null;
  const servers: Record<string, McpServerConfig> = { ...(user?.servers ?? {}) };
  if (workspaceTrusted && workspace) {
    Object.assign(servers, workspace.servers);
  }
  return { config: { servers }, workspaceIgnored };
}

export function defaultUserConfigPath(): string {
  return path.join(os.homedir(), '.sunday', 'mcp.json');
}

export function defaultWorkspaceConfigPath(workspaceRoot: string = process.cwd()): string {
  return path.join(workspaceRoot, '.sunday', 'mcp.json');
}
