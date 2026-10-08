import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildRepoMap } from './repoMap.js';
import { buildIndex } from './indexer.js';
import { searchWorkspaceIndex } from './search.js';

/**
 * JSON-RPC handlers for `context/*`. NOTE: @sunday/context is intentionally
 * dependency-free (node builtins only), so it cannot import the zod schemas
 * from @sunday/protocol. The validators below mirror CONTEXT_METHODS in
 * packages/protocol/src/context.ts field-for-field — keep them in sync.
 */

export interface ContextMapResult {
  files: { path: string; size: number; lang: string }[];
  totalFiles: number;
  totalBytes: number;
}

export interface ContextIndexResult {
  files: number;
  chunks: number;
  skipped: number;
  /** True when indexing stopped at the byte cap (partial index by design). */
  capped: boolean;
}

export interface ContextSearchResult {
  hits: { path: string; startLine: number; endLine: number; score: number; snippet: string }[];
}

export interface ContextHandlers {
  'context/map': (params: unknown) => Promise<ContextMapResult>;
  'context/index': (params: unknown) => Promise<ContextIndexResult>;
  'context/search': (params: unknown) => Promise<ContextSearchResult>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function reqString(params: Record<string, unknown>, name: string): string {
  const v = params[name];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`invalid params: ${name} must be a non-empty string`);
  }
  return v;
}

function optBoolean(params: Record<string, unknown>, name: string): boolean | undefined {
  const v = params[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new Error(`invalid params: ${name} must be a boolean`);
  return v;
}

function optBoundedInt(
  params: Record<string, unknown>,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const v = params[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new Error(`invalid params: ${name} must be an integer in [${min}, ${max}]`);
  }
  return v;
}

/**
 * Create the `context/*` handler table bound to a workspace root. An explicit
 * `workspaceRoot` param must resolve inside the bound root — requests that
 * escape it are rejected.
 */
export function createContextHandlers(workspaceRoot: string = process.cwd()): ContextHandlers {
  const bound = path.resolve(workspaceRoot);

  const resolveRoot = (requested: string | undefined, name: string): string => {
    const abs = path.resolve(requested ?? bound);
    const rel = path.relative(bound, abs);
    if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
      throw new Error(`invalid params: ${name} escapes the workspace root`);
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      throw new Error(`workspace root not found: ${abs}`);
    }
    if (!st.isDirectory()) throw new Error(`workspace root is not a directory: ${abs}`);
    return abs;
  };

  const asRecord = (params: unknown): Record<string, unknown> => {
    if (!isRecord(params)) throw new Error('invalid params: expected an object');
    return params;
  };

  return {
    'context/map': async (params: unknown): Promise<ContextMapResult> => {
      const p = asRecord(params);
      const ws = resolveRoot(reqString(p, 'workspaceRoot'), 'workspaceRoot');
      const map = buildRepoMap(ws);
      return {
        files: map.files.map((f) => ({ path: f.path, size: f.size, lang: f.lang })),
        totalFiles: map.totalFiles,
        totalBytes: map.totalBytes,
      };
    },
    'context/index': async (params: unknown): Promise<ContextIndexResult> => {
      const p = asRecord(params);
      const ws = resolveRoot(reqString(p, 'workspaceRoot'), 'workspaceRoot');
      const force = optBoolean(p, 'force') ?? false;
      // Task 7: entitlement-aware callers pass their plan's byte cap; the
      // indexer defaults to 100 MB when it's absent.
      const maxBytes = optBoundedInt(p, 'maxBytes', 1, Number.MAX_SAFE_INTEGER);
      const stats = buildIndex(ws, { force, ...(maxBytes === undefined ? {} : { maxBytes }) });
      return { files: stats.files, chunks: stats.chunks, skipped: stats.skipped, capped: stats.capped };
    },
    'context/search': async (params: unknown): Promise<ContextSearchResult> => {
      const p = asRecord(params);
      const rawRoot = p['workspaceRoot'];
      const ws =
        rawRoot === undefined
          ? bound
          : resolveRoot(reqString(p, 'workspaceRoot'), 'workspaceRoot');
      const query = reqString(p, 'query');
      const k = optBoundedInt(p, 'k', 1, 50) ?? 5;
      const maxChars = optBoundedInt(p, 'maxChars', 1, 100_000) ?? 8000;
      return { hits: searchWorkspaceIndex(ws, query, { k, maxChars }) };
    },
  };
}
