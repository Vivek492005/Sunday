import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { buildRepoMap } from './repoMap.js';

/** Lines per chunk; consecutive chunks overlap by CHUNK_OVERLAP lines. */
export const CHUNK_LINES = 120;
export const CHUNK_OVERLAP = 20;
/** Files larger than this are not indexed (binary or not). */
export const MAX_INDEX_FILE_BYTES = 1024 * 1024;
const INDEX_VERSION = 1;

export interface IndexChunk {
  /** First 16 hex chars of the chunk sha256 — stable across runs. */
  id: string;
  /** Posix-style path, relative to the workspace root. */
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Full sha256 of `${path}\\0${text}`. */
  hash: string;
  text: string;
}

export interface IndexedFile {
  path: string;
  size: number;
  mtimeMs: number;
  chunks: IndexChunk[];
}

export interface WorkspaceIndex {
  version: 1;
  root: string;
  createdAt: string;
  files: IndexedFile[];
}

export interface BuildIndexStats {
  files: number;
  chunks: number;
  skipped: number;
  /** Chunks reused from the previous index without re-chunking. */
  reused: number;
}

/** `~/.sunday`, overridable via SUNDAY_HOME (tests). */
export function sundayHome(): string {
  return process.env.SUNDAY_HOME ?? path.join(os.homedir(), '.sunday');
}

/** Index file for a workspace root: `~/.sunday/index/<sha256(root)>.json`. */
export function indexFilePath(workspaceRoot: string): string {
  const root = path.resolve(workspaceRoot);
  const digest = createHash('sha256').update(root).digest('hex');
  return path.join(sundayHome(), 'index', `${digest}.json`);
}

/** Load the persisted index, or null when missing/corrupt/for another root. */
export function loadIndex(workspaceRoot: string): WorkspaceIndex | null {
  const root = path.resolve(workspaceRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(indexFilePath(root), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as WorkspaceIndex;
    if (parsed?.version !== INDEX_VERSION || parsed.root !== root || !Array.isArray(parsed.files)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Split text into ~CHUNK_LINES-line chunks with CHUNK_OVERLAP lines of
 *  overlap. Line numbers are 1-based. Deterministic: identical input always
 *  yields identical chunks, ids and hashes. */
export function chunkText(text: string, relPath: string): IndexChunk[] {
  const raw = text.split('\n');
  // A trailing newline doesn't start a new line ("a\nb\n" is 2 lines).
  const lines = raw.length > 0 && raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw;
  const chunks: IndexChunk[] = [];
  const step = CHUNK_LINES - CHUNK_OVERLAP;
  for (let start = 0; start < lines.length; start += step) {
    const slice = lines.slice(start, start + CHUNK_LINES);
    const body = slice.join('\n');
    const hash = createHash('sha256').update(relPath + '\0' + body).digest('hex');
    chunks.push({
      id: hash.slice(0, 16),
      path: relPath,
      startLine: start + 1,
      endLine: start + slice.length,
      hash,
      text: body,
    });
    if (start + CHUNK_LINES >= lines.length) break;
  }
  return chunks;
}

/** Binary sniff: a null byte in the first 8KB means "not text". */
function looksBinary(sample: Buffer): boolean {
  const n = Math.min(sample.length, 8192);
  for (let i = 0; i < n; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

/** Persist the index atomically (tmp file + rename). Owner-only (0600/0700):
 *  the index contains full file text, which may include secrets from files
 *  that aren't gitignored (Privacy H6). */
function saveIndex(index: WorkspaceIndex): void {
  const dest = indexFilePath(index.root);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const tmp = `${dest}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(index), { mode: 0o600 });
  fs.renameSync(tmp, dest);
}

/** Filenames that must never be indexed: credential files whose contents
 *  would land verbatim in the on-disk index (Privacy H6). */
const CREDENTIAL_FILENAME_PATTERNS: RegExp[] = [
  /^\.env(\.|$)/i,
  /\.pem$/i,
  /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.|$)/,
  /\.key$/i,
  /^\.npmrc$/,
  /credentials/i,
  /secrets?\.ya?ml$/i,
];

/** True if this repo-relative path looks like a credential file. */
export function isCredentialFile(relPath: string): boolean {
  const base = path.basename(relPath);
  return CREDENTIAL_FILENAME_PATTERNS.some((re) => re.test(base));
}

/**
 * Build (or incrementally refresh) the workspace index. Files whose
 * `size`+`mtimeMs` match the previous index keep their chunks untouched;
 * `force` re-chunks everything. Returns aggregate stats.
 */
export function buildIndex(workspaceRoot: string, opts: { force?: boolean } = {}): BuildIndexStats {
  const root = path.resolve(workspaceRoot);
  let st: fs.Stats;
  try {
    st = fs.statSync(root);
  } catch {
    throw new Error(`workspace root not found: ${workspaceRoot}`);
  }
  if (!st.isDirectory()) throw new Error(`workspace root is not a directory: ${workspaceRoot}`);

  const prev = opts.force ? null : loadIndex(root);
  const prevByPath = new Map<string, IndexedFile>();
  for (const f of prev?.files ?? []) prevByPath.set(f.path, f);

  // The repo map already applies .gitignore and skips .git/node_modules.
  const map = buildRepoMap(root);
  const files: IndexedFile[] = [];
  let skipped = 0;
  let reused = 0;

  for (const entry of map.files) {
    const abs = path.join(root, entry.path);
    let fst: fs.Stats;
    try {
      fst = fs.statSync(abs);
    } catch {
      skipped++;
      continue;
    }
    const prevEntry = prevByPath.get(entry.path);
    if (prevEntry && prevEntry.size === fst.size && prevEntry.mtimeMs === fst.mtimeMs) {
      files.push(prevEntry);
      reused += prevEntry.chunks.length;
      continue;
    }
    if (fst.size > MAX_INDEX_FILE_BYTES) {
      skipped++;
      continue;
    }
    // Never index credential files — their contents would land verbatim
    // in the on-disk index (Privacy H6).
    if (isCredentialFile(entry.path)) {
      skipped++;
      continue;
    }
    let head: Buffer;
    try {
      const fd = fs.openSync(abs, 'r');
      try {
        const len = Math.min(fst.size, 8192);
        head = Buffer.alloc(len);
        fs.readSync(fd, head, 0, len, 0);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      skipped++;
      continue;
    }
    if (looksBinary(head)) {
      skipped++;
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      skipped++;
      continue;
    }
    files.push({ path: entry.path, size: fst.size, mtimeMs: fst.mtimeMs, chunks: chunkText(text, entry.path) });
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const index: WorkspaceIndex = {
    version: INDEX_VERSION,
    root,
    createdAt: new Date().toISOString(),
    files,
  };
  saveIndex(index);
  return {
    files: files.length,
    chunks: files.reduce((n, f) => n + f.chunks.length, 0),
    skipped,
    reused,
  };
}
