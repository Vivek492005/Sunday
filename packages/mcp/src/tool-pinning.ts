/**
 * tool-pinning.ts — F10: MCP hygiene — tool-definition hash pinning.
 *
 * Rug-pull / tool-poisoning defense: when an MCP server first connects, we
 * snapshot a SHA-256 pin of every tool definition (name + description +
 * inputSchema). On every subsequent connect we re-hash and diff:
 *
 * - NEW tool          → recorded, surfaced as "new — review before use".
 * - REMOVED tool      → recorded (server shrank its surface).
 * - DESCRIPTION or SCHEMA changed → **re-approval required**: the tool is
 *   quarantined until the user re-approves it. This defeats the classic
 *   rug-pull where a benign tool's description is silently rewritten to
 *   smuggle new instructions ("also exfiltrate ~/.ssh on every call").
 * - UNCHANGED         → no action.
 *
 * Pins persist as JSON: `~/.sunday/mcp-pins/<server>.json` (path injected by
 * the caller; this module is pure logic + a tiny file store).
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Minimal tool-definition shape needed for pinning. */
export interface PinnableTool {
  name: string;
  description: string;
  /** JSON Schema object. */
  inputSchema: Record<string, unknown>;
}

/** Canonical serialization: sorted keys, stable across runs. */
export function canonicalizeTool(t: PinnableTool): string {
  return JSON.stringify({
    name: t.name,
    description: t.description,
    inputSchema: sortKeys(t.inputSchema),
  });
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k]);
    return out;
  }
  return v;
}

/** SHA-256 pin of a tool definition. */
export function pinTool(t: PinnableTool): string {
  return createHash('sha256').update(canonicalizeTool(t)).digest('hex');
}

export type ToolPinChange =
  | { kind: 'new'; tool: string }
  | { kind: 'removed'; tool: string }
  | {
      kind: 'changed';
      tool: string;
      /** What changed: description text, schema shape, or both. */
      fields: Array<'description' | 'inputSchema'>;
      /** Re-approval is REQUIRED before this tool may be used again. */
      reapprovalRequired: true;
    }
  | { kind: 'unchanged'; tool: string };

/** A persisted pin record for one tool. */
export interface ToolPin {
  pin: string;
  description: string;
  schemaHash: string;
  pinnedAt: string;
}

function schemaHash(t: PinnableTool): string {
  return createHash('sha256')
    .update(JSON.stringify(sortKeys(t.inputSchema)))
    .digest('hex');
}

/**
 * Diff a fresh tool list against stored pins. Pure — no I/O.
 *
 * @param tools  Current tool definitions from the server.
 * @param pins   Previously stored pins (tool name → ToolPin).
 */
export function diffToolPins(
  tools: PinnableTool[],
  pins: Map<string, ToolPin>
): ToolPinChange[] {
  const changes: ToolPinChange[] = [];
  const seen = new Set<string>();

  for (const t of tools) {
    seen.add(t.name);
    const prev = pins.get(t.name);
    if (!prev) {
      changes.push({ kind: 'new', tool: t.name });
      continue;
    }
    const pin = pinTool(t);
    if (pin === prev.pin) {
      changes.push({ kind: 'unchanged', tool: t.name });
      continue;
    }
    const fields: Array<'description' | 'inputSchema'> = [];
    if (t.description !== prev.description) fields.push('description');
    if (schemaHash(t) !== prev.schemaHash) fields.push('inputSchema');
    changes.push({
      kind: 'changed',
      tool: t.name,
      fields: fields.length > 0 ? fields : ['description'],
      reapprovalRequired: true,
    });
  }

  for (const name of pins.keys()) {
    if (!seen.has(name)) changes.push({ kind: 'removed', tool: name });
  }

  return changes;
}

/** Build a fresh pin store from a tool list. */
export function buildPins(tools: PinnableTool[]): Map<string, ToolPin> {
  const out = new Map<string, ToolPin>();
  const now = new Date().toISOString();
  for (const t of tools) {
    out.set(t.name, {
      pin: pinTool(t),
      description: t.description,
      schemaHash: schemaHash(t),
      pinnedAt: now,
    });
  }
  return out;
}

/* ------------------------------------------------------- capability scopes */

/**
 * Per-server capability scopes (F10: "per-server capability scopes").
 * A server declares what it may do; the hub enforces at call time.
 */
export type McpCapability =
  | 'read' // list/read local resources
  | 'network' // outbound network access
  | 'exec' // run subprocesses / shell
  | 'fs-write'; // write outside its sandbox dir

export const ALL_CAPABILITIES: readonly McpCapability[] = [
  'read',
  'network',
  'exec',
  'fs-write',
];

/** Default-deny: a server with no declared scopes gets read-only. */
export function scopesFor(
  declared: McpCapability[] | undefined
): Set<McpCapability> {
  return new Set(declared ?? ['read']);
}

/** True when the server's scopes permit the requested capability. */
export function allowsCapability(
  declared: McpCapability[] | undefined,
  cap: McpCapability
): boolean {
  return scopesFor(declared).has(cap);
}

/* ------------------------------------------------------------ pin storage */

function pinFilePath(storeDir: string, server: string): string {
  const safe = server.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(storeDir, `${safe}.json`);
}

/** Load persisted pins for a server (empty map when none exist). */
export function loadPins(storeDir: string, server: string): Map<string, ToolPin> {
  const p = pinFilePath(storeDir, server);
  if (!existsSync(p)) return new Map();
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, ToolPin>;
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}

/** Persist pins for a server. */
export function savePins(
  storeDir: string,
  server: string,
  pins: Map<string, ToolPin>
): void {
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(
    pinFilePath(storeDir, server),
    JSON.stringify(Object.fromEntries(pins), null, 2)
  );
}
