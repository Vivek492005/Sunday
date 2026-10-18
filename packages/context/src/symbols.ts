/**
 * F5 Hybrid Retrieval — symbol graph (definitions, references, imports, call edges).
 *
 * Uses tree-sitter WASM grammars (TypeScript/JavaScript, Python) to extract a
 * per-workspace symbol graph. The graph is persisted under
 * `~/.sunday/symbols/<sha256(root)>.json` and updated incrementally:
 * only files whose content hash changed are re-parsed (hash-based change
 * detection on save).
 *
 * tree-sitter is loaded LAZILY (dynamic import) so that importing
 * `@sunday/context` never fails when the WASM grammars are unavailable
 * (e.g. a minimal install). In that case every function degrades to an
 * empty graph instead of throwing.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'variable'
  | 'constant'
  | 'import'
  | 'file';

export interface CodeSymbol {
  /** `${path}::${kind}::${name}@${startLine}` — stable within a graph build. */
  id: string;
  name: string;
  kind: SymbolKind;
  /** Posix-style path, relative to the workspace root. */
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Name of the enclosing class/function, when nested. */
  container?: string;
  /** Extra detail: import source, or a short signature hint. */
  detail?: string;
}

export type EdgeKind = 'calls' | 'imports' | 'references';

export interface SymbolEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

/** A raw identifier occurrence (used for find-references). */
export interface SymbolRef {
  name: string;
  path: string;
  /** 1-based. */
  line: number;
  /** True when this occurrence is the symbol's own definition name. */
  isDefinition: boolean;
}

export interface SymbolFileEntry {
  /** sha256 of the file text at extraction time. */
  hash: string;
  symbols: CodeSymbol[];
  edges: SymbolEdge[];
  refs: SymbolRef[];
}

export interface SymbolGraph {
  version: 1;
  root: string;
  createdAt: string;
  files: Record<string, SymbolFileEntry>;
}

export const SYMBOL_GRAPH_VERSION = 1 as const;

type Lang = 'typescript' | 'javascript' | 'python';

/** Map a workspace-relative path to a supported tree-sitter language. */
export function supportedLanguageForPath(relPath: string): Lang | null {
  const lower = relPath.toLowerCase();
  if (/\.(ts|tsx|mts|cts)$/.test(lower)) return 'typescript';
  if (/\.(js|jsx|mjs|cjs)$/.test(lower)) return 'javascript';
  if (/\.py$/.test(lower)) return 'python';
  return null;
}

const WASM_FILE: Record<Lang, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
};

// ---------------------------------------------------------------------------
// Lazy tree-sitter loading
// ---------------------------------------------------------------------------

import type { Parser, Language, Query, Tree } from 'web-tree-sitter';

interface TsLib {
  Parser: typeof Parser;
  Language: typeof Language;
  Query: typeof Query;
}

let tsLib: TsLib | null = null;
let tsLibFailed = false;
const langCache = new Map<Lang, Language>();
let parserInstance: Parser | null = null;

async function loadTsLib(): Promise<TsLib | null> {
  if (tsLib) return tsLib;
  if (tsLibFailed) return null;
  try {
    const mod = await import('web-tree-sitter');
    await mod.Parser.init();
    tsLib = { Parser: mod.Parser, Language: mod.Language, Query: mod.Query };
    return tsLib;
  } catch {
    tsLibFailed = true;
    return null;
  }
}

function wasmPathFor(lang: Lang): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve('tree-sitter-wasms/package.json');
    const p = path.join(path.dirname(pkgJson), 'out', WASM_FILE[lang]);
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

async function loadLanguage(lang: Lang): Promise<Language | null> {
  const cached = langCache.get(lang);
  if (cached) return cached;
  const lib = await loadTsLib();
  if (!lib) return null;
  const wasmPath = wasmPathFor(lang);
  if (!wasmPath) return null;
  try {
    const language = await lib.Language.load(wasmPath);
    langCache.set(lang, language);
    return language;
  } catch {
    return null;
  }
}

async function getParser(lang: Lang): Promise<Parser | null> {
  const lib = await loadTsLib();
  const language = await loadLanguage(lang);
  if (!lib || !language) return null;
  if (!parserInstance) parserInstance = new lib.Parser();
  parserInstance.setLanguage(language);
  return parserInstance;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const TS_QUERY = `
(variable_declarator name: (identifier) @def.fn value: (arrow_function)) @fn.node
(variable_declarator name: (identifier) @def.fn value: (function_expression)) @fn.node
(function_declaration name: (identifier) @def.fn) @fn.node
(function_signature name: (identifier) @def.fn)
(class_declaration name: (type_identifier) @def.class) @class.node
(method_definition name: (property_identifier) @def.method) @method.node
(method_signature name: (property_identifier) @def.method)
(interface_declaration name: (type_identifier) @def.interface)
(type_alias_declaration name: (type_identifier) @def.type)
(enum_declaration name: (identifier) @def.class)
(variable_declarator name: (identifier) @def.var)
(import_statement) @import.node
(call_expression function: (identifier) @call.fn)
(call_expression function: (member_expression property: (property_identifier) @call.method))
(identifier) @ref
`;

const PY_QUERY = `
(decorated_definition definition: (function_definition name: (identifier) @def.fn)) @fn.node
(decorated_definition definition: (class_definition name: (identifier) @def.class)) @class.node
(function_definition name: (identifier) @def.fn) @fn.node
(class_definition name: (identifier) @def.class) @class.node
(import_statement) @import.node
(import_from_statement) @import.node
(call function: (identifier) @call.fn)
(call function: (attribute attribute: (identifier) @call.method))
(assignment left: (identifier) @def.var)
(identifier) @ref
`;

function queryFor(lang: Lang): string {
  return lang === 'python' ? PY_QUERY : TS_QUERY;
}

const DEF_CAPTURE_KIND: Record<string, SymbolKind> = {
  'def.fn': 'function',
  'def.class': 'class',
  'def.method': 'method',
  'def.interface': 'interface',
  'def.type': 'type',
  'def.var': 'variable',
};

function makeId(relPath: string, kind: SymbolKind, name: string, startLine: number): string {
  return `${relPath}::${kind}::${name}@${startLine}`;
}

/** sha256 of file text — the incremental-update change key. */
export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

interface RawCapture {
  name: string;
  text: string;
  startRow: number;
  endRow: number;
  startIndex: number;
  endIndex: number;
}
/**
 * Extract symbols, call/import edges and identifier references from one file.
 * Returns empty collections (never throws) when the language is unsupported
 * or the WASM grammar cannot be loaded.
 */
export async function extractFileSymbols(
  relPath: string,
  text: string,
): Promise<{ symbols: CodeSymbol[]; edges: SymbolEdge[]; refs: SymbolRef[] }> {
  const empty = { symbols: [], edges: [], refs: [] as SymbolRef[] };
  const lang = supportedLanguageForPath(relPath);
  if (!lang) return empty;
  const lib = await loadTsLib();
  const language = await loadLanguage(lang);
  if (!lib || !language) return empty;

  let tree: Tree;
  try {
    const parser = await getParser(lang);
    if (!parser) return empty;
    const parsed = parser.parse(text);
    if (!parsed) return empty;
    tree = parsed;
  } catch {
    return empty;
  }

  let captures: RawCapture[];
  try {
    const q = new lib.Query(language, queryFor(lang));
    captures = q
      .captures(tree.rootNode)
      .map((c) => ({
        name: c.name,
        text: c.node.text,
        startRow: c.node.startPosition.row,
        endRow: c.node.endPosition.row,
        startIndex: c.node.startIndex,
        endIndex: c.node.endIndex,
      }));
  } catch {
    return empty;
  }

  const symbols: CodeSymbol[] = [];
  const edges: SymbolEdge[] = [];
  const refs: SymbolRef[] = [];
  const defNamePositions = new Set<string>(); // `${startIndex}:${endIndex}` of definition names

  // Container stack: enclosing definitions by source range. The `@*.node`
  // captures give us the full node range; def-name captures give the name.
  interface Frame {
    symbol: CodeSymbol;
    endIndex: number;
  }
  const stack: Frame[] = [];

  // Full ranges of function/class/method nodes, keyed by start index.
  const nodeRanges: { startIndex: number; endIndex: number; endRow: number }[] = [];
  for (const cap of captures) {
    if (cap.name === 'fn.node' || cap.name === 'class.node' || cap.name === 'method.node') {
      nodeRanges.push({ startIndex: cap.startIndex, endIndex: cap.endIndex, endRow: cap.endRow });
    }
  }
  /** Innermost node range end containing `index` (name captures sit inside theirs). */
  const nodeEndFor = (index: number): number => {
    let best = Number.POSITIVE_INFINITY;
    for (const r of nodeRanges) {
      if (r.startIndex <= index && index < r.endIndex && r.endIndex < best) best = r.endIndex;
    }
    return best === Number.POSITIVE_INFINITY ? index : best;
  };
  /** 0-based end row of the innermost node containing `index`. */
  const nodeEndRowFor = (index: number): number => {
    let bestRow = -1;
    let bestEnd = Number.POSITIVE_INFINITY;
    for (const r of nodeRanges) {
      if (r.startIndex <= index && index < r.endIndex && r.endIndex < bestEnd) {
        bestEnd = r.endIndex;
        bestRow = r.endRow;
      }
    }
    return bestRow;
  };

  const popFinished = (index: number): void => {
    while (stack.length > 0 && stack[stack.length - 1]!.endIndex <= index) stack.pop();
  };
  const currentContainer = (): CodeSymbol | null =>
    stack.length > 0 ? stack[stack.length - 1]!.symbol : null;

  // First pass: definitions (also build the container stack).
  // Dedupe: one source position yields at most one definition — the query
  // lists specific patterns first (arrow-fn declarator before plain var),
  // so the first capture at a position wins.
  const seenDefPos = new Set<number>();
  for (const cap of captures) {
    const kind = DEF_CAPTURE_KIND[cap.name];
    if (!kind) continue;
    if (seenDefPos.has(cap.startIndex)) continue;
    seenDefPos.add(cap.startIndex);
    popFinished(cap.startIndex);
    const container = currentContainer();
    const startLine = cap.startRow + 1;
    const nodeEndRow = nodeEndRowFor(cap.startIndex);
    const sym: CodeSymbol = {
      id: makeId(relPath, kind, cap.text, startLine),
      name: cap.text,
      kind,
      path: relPath,
      startLine,
      endLine: nodeEndRow >= 0 ? nodeEndRow + 1 : cap.endRow + 1,
      container: container?.name,
    };
    symbols.push(sym);
    defNamePositions.add(`${cap.startIndex}:${cap.endIndex}`);
    if (kind === 'function' || kind === 'method' || kind === 'class') {
      stack.push({ symbol: sym, endIndex: nodeEndFor(cap.startIndex) });
    }
  }

  // Promote functions nested directly inside a class to methods
  // (Python methods are function_definition nodes; TS uses method_definition).
  const classNames = new Set(
    symbols.filter((s) => s.kind === 'class').map((s) => s.name),
  );
  for (const s of symbols) {
    if (s.kind === 'function' && s.container && classNames.has(s.container)) {
      s.kind = 'method';
      s.id = makeId(relPath, 'method', s.name, s.startLine);
    }
  }

  // Second pass: calls, imports, refs.
  const fileSymbol: CodeSymbol = {
    id: makeId(relPath, 'file', path.posix.basename(relPath), 1),
    name: path.posix.basename(relPath),
    kind: 'file',
    path: relPath,
    startLine: 1,
    endLine: text.split('\n').length,
  };

  for (const cap of captures) {
    if (cap.name === 'import.node') {
      const stmt = cap.text;
      const m = /from\s+['"]([^'"]+)['"]/.exec(stmt) ?? /import\s+['"]([^'"]+)['"]/.exec(stmt);
      const source = m?.[1];
      const sym: CodeSymbol = {
        id: makeId(relPath, 'import', source ?? stmt.slice(0, 40), cap.startRow + 1),
        name: source ? `import ${source}` : 'import',
        kind: 'import',
        path: relPath,
        startLine: cap.startRow + 1,
        endLine: cap.endRow + 1,
        detail: source,
      };
      symbols.push(sym);
      if (source) edges.push({ from: fileSymbol.id, to: `external::${source}`, kind: 'imports' });
      continue;
    }
    if (cap.name === 'call.fn' || cap.name === 'call.method') {
      popFinished(cap.startIndex);
      const container = currentContainer();
      const from = container ? container.id : fileSymbol.id;
      edges.push({ from, to: `name::${cap.text}`, kind: 'calls' });
      continue;
    }
    if (cap.name === 'ref') {
      const key = `${cap.startIndex}:${cap.endIndex}`;
      refs.push({
        name: cap.text,
        path: relPath,
        line: cap.startRow + 1,
        isDefinition: defNamePositions.has(key),
      });
    }
  }

  // Call targets stay as `name::X` here — they are resolved against the
  // WHOLE graph by resolveCallTargets() (cross-file), not per file.
  // Dedupe refs (same name+line) keeping definition flag OR-ed.
  const refSeen = new Map<string, SymbolRef>();
  for (const r of refs) {
    const k = `${r.name}:${r.line}`;
    const prev = refSeen.get(k);
    if (!prev) refSeen.set(k, r);
    else if (r.isDefinition) prev.isDefinition = true;
  }

  return { symbols, edges, refs: [...refSeen.values()] };
}

/** Extract the called name from a call edge target (`name::X`, `external::X`, or a symbol id). */
function callTargetName(to: string): string | null {
  if (to.startsWith('external::')) return to.slice('external::'.length);
  if (to.startsWith('name::')) return to.slice('name::'.length);
  // Symbol id: `${path}::${kind}::${name}@${line}` — name is the last segment.
  const last = to.split('::').pop();
  if (!last) return null;
  return last.split('@')[0] ?? null;
}

/**
 * Resolve `calls` edge targets against the whole graph (cross-file).
 * Same-file definitions win; otherwise the first workspace-wide match;
 * unresolvable names become `external::name`. Idempotent — safe to re-run
 * after every incremental update.
 */
export function resolveCallTargets(graph: SymbolGraph): void {
  const byName = new Map<string, CodeSymbol[]>();
  for (const entry of Object.values(graph.files)) {
    for (const s of entry.symbols) {
      const list = byName.get(s.name) ?? [];
      list.push(s);
      byName.set(s.name, list);
    }
  }
  for (const entry of Object.values(graph.files)) {
    for (const e of entry.edges) {
      if (e.kind !== 'calls') continue;
      const name = callTargetName(e.to);
      if (!name) continue;
      const fromPath = e.from.split('::')[0]!;
      const cands = byName.get(name) ?? [];
      const target = cands.find((c) => c.path === fromPath) ?? cands[0];
      e.to = target ? target.id : `external::${name}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Graph build / incremental update / persistence
// ---------------------------------------------------------------------------

/** `~/.sunday/symbols/<sha256(root)>.json` — overridable via SUNDAY_HOME. */
export function symbolGraphPath(workspaceRoot: string): string {
  const root = path.resolve(workspaceRoot);
  const digest = createHash('sha256').update(root).digest('hex');
  const home = process.env.SUNDAY_HOME ?? path.join(os.homedir(), '.sunday');
  return path.join(home, 'symbols', `${digest}.json`);
}

export function loadSymbolGraph(workspaceRoot: string): SymbolGraph | null {
  const root = path.resolve(workspaceRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(symbolGraphPath(root), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as SymbolGraph;
    if (parsed?.version !== SYMBOL_GRAPH_VERSION || parsed.root !== root) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSymbolGraph(graph: SymbolGraph): void {
  const p = symbolGraphPath(graph.root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(graph));
}

export interface GraphFileInput {
  path: string;
  text: string;
}

/** Full build: parse every supported file. */
export async function buildSymbolGraph(
  workspaceRoot: string,
  files: GraphFileInput[],
): Promise<SymbolGraph> {
  const root = path.resolve(workspaceRoot);
  const graph: SymbolGraph = {
    version: SYMBOL_GRAPH_VERSION,
    root,
    createdAt: new Date().toISOString(),
    files: {},
  };
  for (const f of files) {
    if (!supportedLanguageForPath(f.path)) continue;
    const { symbols, edges, refs } = await extractFileSymbols(f.path, f.text);
    graph.files[f.path] = { hash: hashText(f.text), symbols, edges, refs };
  }
  resolveCallTargets(graph);
  return graph;
}

export interface GraphUpdateResult {
  graph: SymbolGraph;
  /** Relative paths that were (re-)parsed. */
  updated: string[];
  /** Relative paths removed from the graph. */
  removed: string[];
}

/**
 * Incremental update: only files whose content hash changed (or which are
 * new) are re-parsed; deleted paths are dropped. Hash-based, so it is safe
 * to call on every file save.
 */
export async function updateSymbolGraph(
  graph: SymbolGraph,
  changed: GraphFileInput[],
  deleted: string[] = [],
): Promise<GraphUpdateResult> {
  const updated: string[] = [];
  const removed: string[] = [];
  for (const d of deleted) {
    if (graph.files[d]) {
      delete graph.files[d];
      removed.push(d);
    }
  }
  for (const f of changed) {
    if (!supportedLanguageForPath(f.path)) continue;
    const hash = hashText(f.text);
    const prev = graph.files[f.path];
    if (prev && prev.hash === hash) continue; // unchanged — skip re-parse
    const { symbols, edges, refs } = await extractFileSymbols(f.path, f.text);
    graph.files[f.path] = { hash, symbols, edges, refs };
    updated.push(f.path);
  }
  if (updated.length > 0 || removed.length > 0) resolveCallTargets(graph);
  return { graph, updated, removed };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface ReferenceHit {
  symbol: CodeSymbol;
  path: string;
  line: number;
  isDefinition: boolean;
}

/**
 * Who references this symbol name? Searches identifier occurrences across
 * the graph; optionally scoped to one file. Includes the definition itself
 * (marked) — like "find usages" in an IDE.
 */
export function findReferences(
  graph: SymbolGraph,
  name: string,
  onlyPath?: string,
): ReferenceHit[] {
  const hits: ReferenceHit[] = [];
  for (const [relPath, entry] of Object.entries(graph.files)) {
    if (onlyPath && relPath !== onlyPath) continue;
    for (const r of entry.refs) {
      if (r.name !== name) continue;
      const sym = entry.symbols.find(
        (s) => s.name === name && s.startLine <= r.line && r.line <= s.endLine,
      );
      hits.push({
        symbol:
          sym ??
          ({
            id: makeId(relPath, 'variable', name, r.line),
            name,
            kind: 'variable',
            path: relPath,
            startLine: r.line,
            endLine: r.line,
          } satisfies CodeSymbol),
        path: relPath,
        line: r.line,
        isDefinition: r.isDefinition,
      });
    }
  }
  hits.sort((a, b) =>
    a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1,
  );
  return hits;
}

/** All symbols defined in one file (outline view). */
export function symbolOutline(graph: SymbolGraph, relPath: string): CodeSymbol[] {
  const entry = graph.files[relPath];
  if (!entry) return [];
  return [...entry.symbols]
    .filter((s) => s.kind !== 'import')
    .sort((a, b) => a.startLine - b.startLine);
}

/** Import statements of one file. */
export function fileImports(graph: SymbolGraph, relPath: string): CodeSymbol[] {
  const entry = graph.files[relPath];
  if (!entry) return [];
  return entry.symbols.filter((s) => s.kind === 'import');
}

export interface ImpactNode {
  symbol: CodeSymbol;
  /** 1 = direct caller, 2 = caller of caller, … */
  depth: number;
  via: string;
}

/**
 * What would break if this symbol changed? Follows `calls` edges backwards
 * (transitively, up to maxDepth) to find every caller, and also flags
 * symbols that merely REFERENCE the name (e.g. passed as a callback) —
 * those break too when a signature changes. Read-only.
 */
export function impactOfChange(
  graph: SymbolGraph,
  symbolId: string,
  maxDepth = 3,
): ImpactNode[] {
  // Reverse index: callee id -> [{callerId}]
  const callers = new Map<string, { from: string }[]>();
  const symbolById = new Map<string, CodeSymbol>();
  for (const entry of Object.values(graph.files)) {
    for (const s of entry.symbols) symbolById.set(s.id, s);
    for (const e of entry.edges) {
      if (e.kind !== 'calls') continue;
      const list = callers.get(e.to) ?? [];
      list.push({ from: e.from });
      callers.set(e.to, list);
    }
  }
  const target = symbolById.get(symbolId);
  const out: ImpactNode[] = [];
  const seen = new Set<string>([symbolId]);

  const pushNode = (id: string, depth: number, via: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const sym = symbolById.get(id);
    if (!sym) return false;
    out.push({ symbol: sym, depth, via });
    return true;
  };

  // Seed: direct callers + direct referencers (enclosing symbol of each
  // non-definition occurrence of the target's name).
  const seeds: { id: string; depth: number }[] = [];
  const seed = (id: string, via: string) => {
    if (pushNode(id, 1, via)) seeds.push({ id, depth: 1 });
  };
  for (const { from } of callers.get(symbolId) ?? []) seed(from, symbolId);
  if (target) {
    for (const entry of Object.values(graph.files)) {
      for (const r of entry.refs) {
        if (r.name !== target.name || r.isDefinition) continue;
        // Innermost enclosing symbol at this line.
        let best: CodeSymbol | null = null;
        for (const s of entry.symbols) {
          if (s.kind === 'import' || s.kind === 'file') continue;
          if (s.startLine <= r.line && r.line <= s.endLine) {
            if (!best || s.startLine >= best.startLine) best = s;
          }
        }
        if (best && best.id !== symbolId) seed(best.id, `${symbolId} (reference)`);
      }
    }
  }

  // Transitive closure through call edges.
  let frontier = seeds;
  while (frontier.length > 0) {
    const next: { id: string; depth: number }[] = [];
    for (const { id, depth } of frontier) {
      if (depth >= maxDepth) continue;
      for (const { from } of callers.get(id) ?? []) {
        if (pushNode(from, depth + 1, id)) next.push({ id: from, depth: depth + 1 });
      }
    }
    frontier = next;
  }
  out.sort((a, b) => a.depth - b.depth || (a.symbol.path < b.symbol.path ? -1 : 1));
  return out;
}

/** Counters for diagnostics / UI ("indexed N symbols in M files"). */
export function graphStats(graph: SymbolGraph): { files: number; symbols: number; edges: number } {
  let symbols = 0;
  let edges = 0;
  for (const e of Object.values(graph.files)) {
    symbols += e.symbols.length;
    edges += e.edges.length;
  }
  return { files: Object.keys(graph.files).length, symbols, edges };
}
