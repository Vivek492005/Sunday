import * as fs from 'node:fs';
import * as path from 'node:path';

/** Files larger than this are listed as skipped, never mapped. */
export const MAX_MAP_FILE_BYTES = 5 * 1024 * 1024;

export interface RepoFileEntry {
  /** Posix-style path, relative to the workspace root. */
  path: string;
  size: number;
  lang: string;
}

export interface RepoMap {
  files: RepoFileEntry[];
  totalFiles: number;
  totalBytes: number;
  /** Relative paths skipped (too large). */
  skipped: string[];
}

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python',
  rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin',
  rb: 'ruby', php: 'php',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  cs: 'csharp', swift: 'swift', m: 'objc', mm: 'objc',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', bat: 'batch', cmd: 'batch',
  sql: 'sql', proto: 'proto', graphql: 'graphql', gql: 'graphql',
  vue: 'vue', svelte: 'svelte',
  tf: 'terraform', dockerfile: 'docker',
  gitignore: 'ignore', env: 'env',
  lua: 'lua', r: 'r', jl: 'julia', ex: 'elixir', exs: 'elixir', erl: 'erlang',
  hs: 'haskell', ml: 'ocaml', scala: 'scala', pl: 'perl', pm: 'perl',
};

const BASENAME_LANG: Record<string, string> = {
  Dockerfile: 'docker',
  Makefile: 'make',
  makefile: 'make',
  GNUmakefile: 'make',
};

/** Language guess from file name; `unknown` when nothing matches. */
export function detectLang(fileName: string): string {
  const base = fileName.split('/').pop() ?? fileName;
  const exact = BASENAME_LANG[base];
  if (exact) return exact;
  const dot = base.lastIndexOf('.');
  if (dot > 0 && dot < base.length - 1) {
    const lang = EXT_LANG[base.slice(dot + 1).toLowerCase()];
    if (lang) return lang;
  }
  return 'unknown';
}

interface IgnoreRule {
  regex: RegExp;
  negate: boolean;
}

/** Convert one glob to a regex source. `*` never crosses `/`; `**` does. */
function globToRegExpSource(glob: string): string {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === '*') {
      let j = i;
      while (glob[j] === '*') j++;
      if (j - i >= 2) {
        // `**/` matches zero or more path segments, so `a/**/b` also hits `a/b`.
        if (glob[j] === '/') {
          out += '(?:.*/)?';
          i = j + 1;
        } else {
          out += '.*';
          i = j;
        }
      } else {
        out += '[^/]*';
        i = j;
      }
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i++;
      continue;
    }
    if ('\\.+^${}()|[]'.includes(c)) out += '\\';
    out += c;
    i++;
  }
  return out;
}

/** Parse one .gitignore line into a rule. Supports `*`, `**`, `?`,
 *  trailing `/` (directories), and `!` negation. Returns null for
 *  blank lines and comments. */
export function parseIgnoreRule(line: string): IgnoreRule | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  let pat = trimmed;
  let negate = false;
  if (pat.startsWith('!')) {
    negate = true;
    pat = pat.slice(1);
  }
  if (!pat) return null;
  let dirOnly = false;
  if (pat.endsWith('/')) {
    dirOnly = true;
    pat = pat.slice(0, -1);
  }
  if (!pat) return null;
  // A pattern containing a slash (or starting with one) is anchored to the
  // .gitignore's directory; otherwise it matches the basename at any depth.
  const anchored = pat.includes('/');
  const src = globToRegExpSource(pat.startsWith('/') ? pat.slice(1) : pat);
  const body = anchored ? `^${src}` : `^(?:.*/)?${src}`;
  const end = dirOnly ? '(?:/.*)?$' : '$';
  return { regex: new RegExp(body + end), negate };
}

/** Load the workspace-root .gitignore (common case). Missing file → no rules. */
export function loadIgnoreRules(workspaceRoot: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(workspaceRoot, '.gitignore'), 'utf8');
  } catch {
    return rules;
  }
  for (const line of raw.split('\n')) {
    const rule = parseIgnoreRule(line);
    if (rule) rules.push(rule);
  }
  return rules;
}

/** True when the last matching rule marks `relPosix` ignored. `relPosix` is a
 *  posix-style path relative to the workspace root. */
export function isIgnored(relPosix: string, rules: IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.regex.test(relPosix)) ignored = !rule.negate;
  }
  return ignored;
}

/**
 * Walk a workspace root and list its files. Respects the root `.gitignore`
 * (last match wins, `!` re-includes), always skips `.git/` and
 * `node_modules/`, never follows symlinks, and skips files over 5MB
 * (recorded in `skipped`). Output is sorted by path for determinism.
 */
export function buildRepoMap(workspaceRoot: string): RepoMap {
  const root = path.resolve(workspaceRoot);
  let st: fs.Stats;
  try {
    st = fs.statSync(root);
  } catch {
    throw new Error(`workspace root not found: ${workspaceRoot}`);
  }
  if (!st.isDirectory()) throw new Error(`workspace root is not a directory: ${workspaceRoot}`);

  const rules = loadIgnoreRules(root);
  const files: RepoFileEntry[] = [];
  const skipped: string[] = [];
  let totalBytes = 0;

  const dirs: string[] = [root];
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    const relDir = path.relative(root, dir).split(path.sep).join('/');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — skip
    }
    for (const entry of entries) {
      const name = entry.name;
      if (name === '.git' || name === 'node_modules') continue; // always skipped
      if (entry.isSymbolicLink()) continue; // never follow symlinks
      const rel = relDir ? `${relDir}/${name}` : name;
      if (isIgnored(rel, rules)) continue; // prunes ignored directories too
      if (entry.isDirectory()) {
        dirs.push(path.join(dir, name));
        continue;
      }
      if (!entry.isFile()) continue;
      let size: number;
      try {
        size = fs.statSync(path.join(dir, name)).size;
      } catch {
        continue;
      }
      if (size > MAX_MAP_FILE_BYTES) {
        skipped.push(rel);
        continue;
      }
      files.push({ path: rel, size, lang: detectLang(name) });
      totalBytes += size;
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  skipped.sort();
  return { files, totalFiles: files.length, totalBytes, skipped };
}
