/**
 * F5 Hybrid Retrieval — agent tools over the tree-sitter symbol graph:
 * `find_references`, `symbol_outline`, `impact_of_change`.
 *
 * All three are READ-ONLY (allowed in reviewer mode). They load the persisted
 * symbol graph for the workspace (`~/.sunday/symbols/`); when no graph exists
 * yet they build one on the fly from workspace files and persist it, so the
 * first call is slower but subsequent calls are instant.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildSymbolGraph,
  findReferences,
  impactOfChange,
  loadSymbolGraph,
  saveSymbolGraph,
  supportedLanguageForPath,
  symbolOutline,
  type SymbolGraph,
} from '@sunday/context';
import { resolveWithinRoot } from './paths.js';
import { err, type Tool, type ToolResult } from './types.js';

const MAX_SCAN_BYTES = 1_000_000;
const SKIPPED_DIRS = new Set(['.git', 'node_modules', 'dist', '__pycache__', '.venv', 'venv']);

/** Collect supported source files under root (posix rel paths + text). */
async function collectWorkspaceFiles(
  root: string,
  maxFiles = 2000,
): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= maxFiles) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (SKIPPED_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        const rel = path.relative(root, abs).split(path.sep).join(path.posix.sep);
        if (!supportedLanguageForPath(rel)) continue;
        const st = await fs.stat(abs).catch(() => null);
        if (!st || st.size > MAX_SCAN_BYTES) continue;
        const text = await fs.readFile(abs, 'utf8').catch(() => null);
        if (text === null || text.includes('\0')) continue;
        out.push({ path: rel, text });
      }
    }
  }
  await walk(root);
  return out;
}

async function getGraph(cwd: string): Promise<SymbolGraph> {
  const root = path.resolve(cwd);
  const cached = loadSymbolGraph(root);
  if (cached) return cached;
  const files = await collectWorkspaceFiles(root);
  const graph = await buildSymbolGraph(root, files);
  saveSymbolGraph(graph);
  return graph;
}

function fmtLoc(relPath: string, line: number): string {
  return `${relPath}:${line}`;
}

export const findReferencesTool: Tool = {
  definition: {
    name: 'find_references',
    description:
      'Find all references to a symbol (function, class, variable) across the workspace using the symbol graph. Includes the definition itself (marked). Read-only.',
    parameters: {
      type: 'object',
      required: ['symbol'],
      properties: {
        symbol: { type: 'string', description: 'Symbol name to find references for.' },
        path: {
          type: 'string',
          description: 'Workspace-relative file to scope the search (default: whole workspace).',
        },
      },
    },
  },
  async execute(rawArgs, ctx): Promise<ToolResult> {
    const args = rawArgs as { symbol: string; path?: string };
    const graph = await getGraph(ctx.cwd);
    const hits = findReferences(graph, args.symbol, args.path);
    if (hits.length === 0) {
      return { output: `no references to '${args.symbol}' found` };
    }
    const lines = hits.map(
      (h) => `${fmtLoc(h.path, h.line)}${h.isDefinition ? '  [definition]' : ''}`,
    );
    return {
      output: `${hits.length} reference(s) to '${args.symbol}':\n${lines.join('\n')}`,
      metadata: { count: hits.length },
    };
  },
};

export const symbolOutlineTool: Tool = {
  definition: {
    name: 'symbol_outline',
    description:
      'List all symbols (functions, classes, methods, variables) defined in a file, with line numbers and nesting. Read-only.',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
      },
    },
  },
  async execute(rawArgs, ctx): Promise<ToolResult> {
    const args = rawArgs as { path: string };
    let rel: string;
    try {
      const abs = resolveWithinRoot(ctx.cwd, args.path);
      rel = path.relative(path.resolve(ctx.cwd), abs).split(path.sep).join(path.posix.sep);
    } catch (e) {
      return err((e as Error).message);
    }
    const graph = await getGraph(ctx.cwd);
    const syms = symbolOutline(graph, rel);
    if (syms.length === 0) {
      return { output: `no symbols found in ${rel} (unsupported language or not indexed)` };
    }
    const depthOf = (s: { container?: string }): number => {
      let d = 0;
      let cur = s.container;
      const byName = new Map(syms.map((x) => [x.name, x]));
      while (cur) {
        d++;
        cur = byName.get(cur)?.container;
      }
      return d;
    };
    const lines = syms.map((s) => {
      const indent = '  '.repeat(Math.min(depthOf(s), 6));
      return `${indent}${s.kind} ${s.name}  (${fmtLoc(s.path, s.startLine)}${s.endLine !== s.startLine ? `-${s.endLine}` : ''})`;
    });
    return {
      output: `symbols in ${rel}:\n${lines.join('\n')}`,
      metadata: { count: syms.length },
    };
  },
};

export const impactOfChangeTool: Tool = {
  definition: {
    name: 'impact_of_change',
    description:
      'Show what would break if a symbol changed: transitive callers of the symbol (direct and indirect), up to a configurable depth. Read-only.',
    parameters: {
      type: 'object',
      required: ['symbol'],
      properties: {
        symbol: { type: 'string', description: 'Symbol name to analyze.' },
        path: {
          type: 'string',
          description: 'Workspace-relative file holding the symbol (disambiguates duplicates).',
        },
        maxDepth: {
          type: 'integer',
          description: 'How many caller hops to follow (default 3, max 6).',
          minimum: 1,
          maximum: 6,
        },
      },
    },
  },
  async execute(rawArgs, ctx): Promise<ToolResult> {
    const args = rawArgs as { symbol: string; path?: string; maxDepth?: number };
    const graph = await getGraph(ctx.cwd);
    // Resolve the symbol name to an id (prefer the given file).
    const candidates: { id: string; path: string; kind: string; line: number }[] = [];
    for (const [relPath, entry] of Object.entries(graph.files)) {
      if (args.path && relPath !== args.path) continue;
      for (const s of entry.symbols) {
        if (s.name === args.symbol && s.kind !== 'import' && s.kind !== 'file') {
          candidates.push({ id: s.id, path: relPath, kind: s.kind, line: s.startLine });
        }
      }
    }
    if (candidates.length === 0) {
      return { output: `symbol '${args.symbol}' not found in the workspace index` };
    }
    const target = candidates[0]!;
    const nodes = impactOfChange(graph, target.id, args.maxDepth ?? 3);
    const header = `impact of changing \`${args.symbol}\` (${target.kind} at ${fmtLoc(target.path, target.line)}):`;
    if (nodes.length === 0) {
      return { output: `${header}\nno callers found — safe to change` };
    }
    const lines = nodes.map(
      (n) =>
        `${'  '.repeat(n.depth)}${'↳ '.repeat(1)}${n.symbol.name} (${n.symbol.kind}) at ${fmtLoc(n.symbol.path, n.symbol.startLine)}`,
    );
    return {
      output: `${header}\n${nodes.length} caller(s):\n${lines.join('\n')}`,
      metadata: { count: nodes.length },
    };
  },
};

export const symbolTools: Tool[] = [findReferencesTool, symbolOutlineTool, impactOfChangeTool];
