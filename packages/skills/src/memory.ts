/**
 * Memory — opt-in persistent notes in `.sunday/memory.md` (workspace scope)
 * and `~/.sunday/memory.md` (user scope).
 *
 * `remember()` appends a dated entry but NEVER writes secrets: the text is
 * scanned for common secret patterns first, and the write is refused with a
 * `SecretRefusedError` when one matches. Approval-gating the call itself is
 * worker 3's job; this package just exposes the function.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface MemoryDiff {
  /** The exact entry that was appended. */
  appended: string;
  /** Human-readable old-tail → new-tail view of the memory file. */
  diff: string;
}

export type MemoryScope = 'workspace' | 'user';

export interface MemoryOptions {
  /** Workspace root. Defaults to `process.cwd()`. */
  workspaceDir?: string;
  /** Home dir whose `.sunday/memory.md` is the user scope. Defaults to `os.homedir()`. */
  userDir?: string;
  /**
   * Override "today" (ISO `YYYY-MM-DD`). Useful for tests; defaults to the
   * current UTC date.
   */
  date?: string;
}

/** Thrown by `remember()` when the text looks like it contains a secret. */
export class SecretRefusedError extends Error {
  /** The label of the secret pattern that matched (never the secret itself). */
  readonly pattern: string;

  constructor(pattern: string) {
    super(
      `Refusing to remember: text matches secret pattern "${pattern}". ` +
        'Memory must never store credentials or secrets.',
    );
    this.name = 'SecretRefusedError';
    this.pattern = pattern;
  }
}

interface SecretPattern {
  label: string;
  re: RegExp;
  /**
   * When true the pattern only matches the *label* of an assignment
   * (`password=`, `api_key:` …) — redaction then also swallows the value
   * that follows it.
   */
  includeValue?: boolean;
}

/**
 * Common secret shapes. Labels are safe to surface; the matched text never is.
 */
export const SECRET_PATTERNS: SecretPattern[] = [
  { label: 'openai-key', re: /\bsk-[A-Za-z0-9]{8,}\b/ },
  { label: 'github-pat', re: /\bghp_[A-Za-z0-9]{8,}\b/ },
  { label: 'github-oauth', re: /\bgho_[A-Za-z0-9]{8,}\b/ },
  { label: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{8,}\b/ },
  { label: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'aws-secret-key', re: /\baws_secret_access_key\s*[:=]/i, includeValue: true },
  { label: 'private-key-block', re: /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: 'password-assignment', re: /\bpassword\s*[:=]/i, includeValue: true },
  { label: 'passwd-assignment', re: /\bpasswd\s*[:=]/i, includeValue: true },
  { label: 'secret-assignment', re: /\bclient_secret\s*[:=]/i, includeValue: true },
  { label: 'api-key-assignment', re: /\bapi[_-]?key\s*[:=]/i, includeValue: true },
  { label: 'bearer-token', re: /\bbearer\s+[A-Za-z0-9\-._~+/]{16,}={0,3}\b/i },
  { label: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/ },
  { label: 'google-api-key', re: /\bAIza[0-9A-Za-z\-_]{20,}\b/ },
  { label: 'generic-token-assignment', re: /\btoken\s*[:=]\s*["']?[A-Za-z0-9\-._~+/]{16,}["']?/i },
];

/** Throw `SecretRefusedError` when `text` matches any known secret pattern. */
export function assertNoSecrets(text: string): void {
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(text)) throw new SecretRefusedError(p.label);
  }
}

/** Replacement marker used by {@link redactSecrets} — the label, never the value. */
export function redactionMarker(label: string): string {
  return `[REDACTED:${label}]`;
}

/** A full PEM private-key block (header … footer), redacted as one unit. */
const PEM_BLOCK_RE =
  /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/g;

/** Value tail appended to label-only assignment patterns during redaction. */
const ASSIGNMENT_VALUE_SUFFIX = '\\s*["\']?[^\\s"\']+["\']?';

function withGlobalFlags(re: RegExp): string {
  return re.flags.includes('g') ? re.flags : `${re.flags}g`;
}

/**
 * Redact every known secret shape in `text` (§15.4 "Secrets leakage to model
 * providers"). Each match is replaced with `[REDACTED:<label>]` — the label
 * is safe to surface (it names the pattern, not the value). Assignment-style
 * patterns (`password=…`) redact the value too, and PEM blocks are redacted
 * whole. Use before tool results, errors, or log lines reach a prompt or a
 * log sink.
 */
export function redactSecrets(text: string): string {
  let out = text.replace(PEM_BLOCK_RE, () => redactionMarker('private-key-block'));
  for (const p of SECRET_PATTERNS) {
    const source = p.includeValue === true ? `${p.re.source}${ASSIGNMENT_VALUE_SUFFIX}` : p.re.source;
    out = out.replace(new RegExp(source, withGlobalFlags(p.re)), () =>
      redactionMarker(p.label),
    );
  }
  return out;
}

const MEMORY_FILE = 'memory.md';
const TAIL_LINES = 5;

function memoryPath(scope: MemoryScope, workspaceDir: string, userDir: string): string {
  return scope === 'workspace'
    ? join(workspaceDir, '.sunday', MEMORY_FILE)
    : join(userDir, '.sunday', MEMORY_FILE);
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

function tail(text: string, lines: number): string {
  const all = text.split('\n');
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}

/**
 * Load memory files. Opt-in: scopes whose file does not exist are simply
 * omitted from the result.
 */
export async function loadMemory(
  opts: MemoryOptions = {},
): Promise<{ workspace?: string; user?: string }> {
  const workspaceDir = resolve(opts.workspaceDir ?? process.cwd());
  const userDir = resolve(opts.userDir ?? homedir());
  const out: { workspace?: string; user?: string } = {};
  const ws = await readIfExists(memoryPath('workspace', workspaceDir, userDir));
  if (ws !== undefined) out.workspace = ws;
  const user = await readIfExists(memoryPath('user', workspaceDir, userDir));
  if (user !== undefined) out.user = user;
  return out;
}

/**
 * Append a dated entry to the memory file for `scope`.
 *
 * Refuses (throws `SecretRefusedError`, writes nothing) when `text` matches
 * a known secret pattern. Returns `{ appended, diff }` where `diff` shows the
 * old tail → new tail of the file so the caller can show the user what changed.
 */
export async function remember(
  text: string,
  scope: MemoryScope,
  opts: MemoryOptions = {},
): Promise<MemoryDiff> {
  const clean = text.trim();
  if (clean.length === 0) throw new Error('Refusing to remember empty text.');
  assertNoSecrets(clean);

  const workspaceDir = resolve(opts.workspaceDir ?? process.cwd());
  const userDir = resolve(opts.userDir ?? homedir());
  const path = memoryPath(scope, workspaceDir, userDir);
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const appended = `- ${date}: ${clean.replace(/\s+/g, ' ')}`;

  const before = (await readIfExists(path)) ?? '';
  const next = before.length === 0 ? `${appended}\n` : `${before.replace(/\n+$/, '\n')}${appended}\n`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next, 'utf8');

  const beforeTail = tail(before.replace(/\n+$/, ''), TAIL_LINES);
  const afterTail = tail(next.replace(/\n+$/, ''), TAIL_LINES);
  const diff =
    `--- ${scope} memory (before, last ${TAIL_LINES} lines)\n` +
    (beforeTail.length > 0 ? beforeTail + '\n' : '(empty)\n') +
    `+++ ${scope} memory (after, last ${TAIL_LINES} lines)\n` +
    afterTail +
    '\n';
  return { appended, diff };
}
