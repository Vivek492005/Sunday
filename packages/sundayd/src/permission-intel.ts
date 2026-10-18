/**
 * permission-intel.ts — F7 Permission Intelligence.
 *
 * Risk-tiered, profile-driven approval intelligence for agent tool calls.
 * The key security property: terminal commands are parsed with a REAL shell
 * parser (`shell-quote`), never regex, so chaining (`;`, `&&`, `|`), subshells
 * (`$(…)`, backticks), quoting/escaping tricks (`"rm"`, `r\m`) and env-var
 * expansion (`$VAR`, `${VAR}`) cannot smuggle a destructive action past an
 * allowlist entry. Deny always wins over allow.
 *
 * Tiers (ascending risk):
 *   read-only < edit-workspace < run-tests < install-deps < network < destructive
 *
 * Profiles (`sunday.policy.profile`, daemon side via SUNDAY_POLICY_PROFILE):
 *   cautious  — ask for everything except pure reads
 *   balanced  — allow reads/edits/tests, ask for installs/network, deny destructive
 *   autopilot — also allow installs; ask (not deny) destructive.
 *               Effective ONLY in a trusted workspace with the sandbox on,
 *               otherwise it degrades to balanced.
 *
 * Scoped "always allow" (approval dialog offers these; grant() enforces):
 *   exact     — this exact canonical command
 *   pattern   — glob over the canonical command (real parser output, not raw text)
 *   directory — this cwd subtree, this session only
 *   repo      — this repo root, persisted across sessions
 * Destructive classes (rm -rf, force-push, credential reads, network egress)
 * can NEVER be blanket-allowlisted — grant() throws for them. One-time
 * approvals go through approveOnce()/approvePlan() instead.
 */

import { parse as parseShell } from 'shell-quote';
import { isAbsolute, resolve } from 'node:path';
import { isCredentialFile } from './credential-gate.js';
import { isPathWithin, isWorkspaceTrusted } from './trust.js';
import { sandboxConfigFromEnv } from './sandbox.js';

/* ------------------------------------------------------------------ types */

export type RiskTier =
  | 'read-only'
  | 'edit-workspace'
  | 'run-tests'
  | 'install-deps'
  | 'network'
  | 'destructive';

/** Ascending risk order — index is the rank. */
export const TIER_ORDER: readonly RiskTier[] = [
  'read-only',
  'edit-workspace',
  'run-tests',
  'install-deps',
  'network',
  'destructive',
];

export function tierRank(t: RiskTier): number {
  return TIER_ORDER.indexOf(t);
}

export function maxTier(a: RiskTier, b: RiskTier): RiskTier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

export type PolicyProfile = 'cautious' | 'balanced' | 'autopilot';

export type AllowScope =
  | { kind: 'exact'; command: string }
  | { kind: 'pattern'; glob: string }
  | { kind: 'directory'; dir: string }
  | { kind: 'repo'; repoRoot: string };

export interface AllowEntry {
  id: string;
  tool: string;
  scope: AllowScope;
  tier: RiskTier;
  sessionId: string | null; // null = persisted across sessions
  createdAt: number;
  createdBy: string;
}

export interface DenyEntry {
  id: string;
  /** Canonical glob, e.g. `run_terminal(rm -rf *)`. */
  pattern: string;
  createdAt: number;
  createdBy: string;
  reason: string;
}

export interface ClassifiedAction {
  tool: string;
  /** Canonical form, e.g. `run_terminal(git push --force)`. */
  canonical: string;
  tier: RiskTier;
  notes: string[];
  /** Destructive classes (rm -rf, force-push, credential reads, network
   *  egress): may be one-time approved but never blanket-allowlisted. */
  neverAllowlist: boolean;
}

export type IntelDecision = 'allow' | 'deny' | 'ask';

export interface DecideResult {
  decision: IntelDecision;
  action: ClassifiedAction | null; // null = not classified (fall back to legacy gate)
  reason: string;
  /** How the decision was reached — for the audit log and approval UI. */
  via: 'deny-list' | 'allowlist' | 'plan' | 'one-time' | 'profile' | 'unclassified';
  /** Scopes the approval dialog may offer for an `ask` decision. */
  askScopes?: AllowScope[];
}

export interface PolicyContext {
  cwd: string;
  workspaceRoot?: string;
  sessionId?: string;
  principal?: string;
  sandboxOn?: boolean;
}

export interface AuditEntry {
  ts: number;
  principal: string;
  tool: string;
  canonical: string;
  tier: RiskTier;
  decision: IntelDecision;
  via: DecideResult['via'];
  scope?: string;
}

export interface PlanHandle {
  id: string;
  createdAt: number;
  createdBy: string;
  /** Remaining (unconsumed) canonical actions. */
  remaining: string[];
}

/* ------------------------------------------------- profile default matrix */

type TierPolicy = Record<RiskTier, IntelDecision>;

const PROFILE_DEFAULTS: Record<PolicyProfile, TierPolicy> = {
  cautious: {
    'read-only': 'allow',
    'edit-workspace': 'ask',
    'run-tests': 'ask',
    'install-deps': 'ask',
    network: 'ask',
    destructive: 'deny',
  },
  balanced: {
    'read-only': 'allow',
    'edit-workspace': 'allow',
    'run-tests': 'allow',
    'install-deps': 'ask',
    network: 'ask',
    destructive: 'deny',
  },
  autopilot: {
    'read-only': 'allow',
    'edit-workspace': 'allow',
    'run-tests': 'allow',
    'install-deps': 'allow',
    network: 'ask',
    destructive: 'ask',
  },
};

/* ------------------------------------------------------- shell AST helpers */

type ShellToken = string | { op: string; pattern?: string; comment?: string };

interface SimpleCommand {
  argv: string[];
  /** Redirect targets: { op: '>'|'>>'|'<'|..., target } */
  redirects: Array<{ op: string; target: string }>;
  envPrefix: boolean;
  /** An env-prefix assignment hijacks the child process (LD_PRELOAD=…). */
  dangerousEnvPrefix: boolean;
  /** Operator that followed this command in the source (`;`, `&&`, `|`, …). */
  follower: string | null;
  /** True when a `$(…)` subshell appeared in this command's arguments —
   *  code-execution sinks (eval, sh -c, source) with dynamic input. */
  subshellArg: boolean;
}

const CHAIN_OPS = new Set([';', '&&', '||', '|', '&']);
const REDIRECT_OPS = new Set(['>', '>>', '<', '<>', '>&', '&>', '>|', '1>', '2>', '1>>', '2>>']);

/**
 * Sentinel for unresolvable env-var expansions. shell-quote is given a Proxy
 * env that maps EVERY variable to this sentinel, so `$DIR` parses as a
 * visible `\0SUNDAY_UNRESOLVED\0` token instead of being silently swallowed
 * (the default empty-env behavior). The classifier treats sentinel-bearing
 * targets as unresolvable → fail closed. The sentinel never reaches logs:
 * canonical forms render it as `<unresolved>`.
 */
export const EXPANSION_SENTINEL = '\u0000SUNDAY_UNRESOLVED\u0000';
const sentinelEnv = new Proxy<Record<string, string>>(
  {},
  {
    get: () => EXPANSION_SENTINEL,
    has: () => true,
  },
);

function renderToken(t: string): string {
  return t.split(EXPANSION_SENTINEL).join('<unresolved>');
}

/** True when the value contains an unresolvable expansion. */
function hasUnresolved(v: string): boolean {
  return v.includes(EXPANSION_SENTINEL);
}

/** Split a raw command into simple commands using the real parser. */
function splitCommands(raw: string): {
  commands: SimpleCommand[];
  hasSubshell: boolean;
  hasPipe: boolean;
  parseError: boolean;
} {
  let tokens: ShellToken[];
  try {
    // Sentinel env: every $VAR expands to EXPANSION_SENTINEL instead of being
    // swallowed, so env tricks stay visible to the classifier.
    tokens = parseShell(raw, sentinelEnv) as ShellToken[];
  } catch {
    return { commands: [], hasSubshell: false, hasPipe: false, parseError: true };
  }
  const commands: SimpleCommand[] = [];
  let current: string[] = [];
  let redirects: SimpleCommand['redirects'] = [];
  let pendingRedirect: string | null = null;
  let hasSubshell = false;
  let hasPipe = false;

  const flush = (follower: string | null) => {
    if (current.length > 0 || redirects.length > 0) {
      // Strip leading VAR=… env assignments (kept as a note, not as the command).
      let envPrefix = false;
      let dangerousEnvPrefix = false;
      while (current.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(current[0])) {
        if (DANGEROUS_ENV_PREFIX.test(current[0])) dangerousEnvPrefix = true;
        current.shift();
        envPrefix = true;
      }
      commands.push({ argv: current, redirects, envPrefix, dangerousEnvPrefix, follower, subshellArg: follower === '(' });
    }
    current = [];
    redirects = [];
  };

  for (const tok of tokens) {
    if (typeof tok !== 'string') {
      if (tok.comment !== undefined) continue; // comments are inert
      const op = tok.op;
      if (op === 'glob' && tok.pattern !== undefined) {
        if (pendingRedirect) {
          redirects.push({ op: pendingRedirect, target: tok.pattern });
          pendingRedirect = null;
        } else {
          current.push(tok.pattern);
        }
        continue;
      }
      if (REDIRECT_OPS.has(op)) {
        pendingRedirect = op;
        continue;
      }
      if (op === '(') {
        hasSubshell = true;
        flush('(');
        continue;
      }
      if (op === ')') {
        flush(')');
        continue;
      }
      if (CHAIN_OPS.has(op)) {
        if (op === '|') hasPipe = true;
        flush(op);
        continue;
      }
      // Unknown op — fail closed: treat as a chain boundary.
      flush(op);
      continue;
    }
    if (pendingRedirect) {
      redirects.push({ op: pendingRedirect, target: tok });
      pendingRedirect = null;
    } else {
      current.push(tok);
    }
  }
  flush(null);
  // A dangling redirect op with no target: fail closed — the parse is
  // incomplete, treat as suspicious.
  if (pendingRedirect) {
    return { commands: [], hasSubshell, hasPipe, parseError: true };
  }
  return { commands, hasSubshell, hasPipe, parseError: false };
}

/** Raw-string scan for env-var / command-substitution tricks the parser
 *  swallows (shell-quote parses `$VAR` to an empty token). */
function detectExpansions(raw: string): { hasEnvExpansion: boolean; hasCommandSubst: boolean } {
  const hasCommandSubst = /\$\(/.test(raw) || /`/.test(raw);
  // $VAR, ${VAR}, $1, $@ — but not $$ (pid) alone… keep it simple: any $.
  const hasEnvExpansion = hasCommandSubst || /\$[A-Za-z_{(*#]/.test(raw);
  return { hasEnvExpansion, hasCommandSubst };
}

/** Recursively parse a nested command string (eval/sh -c/ssh …), depth-capped. */
function parseNested(arg: string, depth: number): SimpleCommand[] {
  if (depth > 3) return [];
  const { commands, parseError } = splitCommands(arg);
  if (parseError) return [];
  const out: SimpleCommand[] = [];
  for (const c of commands) {
    out.push(c);
    out.push(...expandNested(c, depth + 1));
  }
  return out;
}

/** Shell keywords that take commands as "arguments" (`then rm -rf /`,
 *  `do rm "$f"; done`). Their args are re-parsed as nested command lines so
 *  the real commands inside cannot hide. */
const SHELL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'function', 'select', '!', '{', '}',
]);

/** Find nested command strings inside eval/sh -c/ssh/xargs/find -exec/trap/alias. */
function expandNested(cmd: SimpleCommand, depth: number): SimpleCommand[] {
  const [name, ...args] = cmd.argv;
  const lower = (name ?? '').toLowerCase();
  const nested: SimpleCommand[] = [];
  if (SHELL_KEYWORDS.has(lower)) {
    // `then rm -rf /tmp/x` — re-parse the "arguments" as a command line.
    const body = args.join(' ').trim();
    if (body !== '') nested.push(...parseNested(body, depth));
    return nested;
  }
  if (lower === 'eval' || lower === 'trap' || lower === 'alias') {
    // trap 'cmd' EXIT and alias x='cmd' hide shell code in string args.
    // For alias the value rides in the same token (`x=rm -rf /`), so split
    // on the first `=` — the generic VAR= strip would eat the whole token.
    for (const a of args) {
      if (a === 'EXIT' || a === 'ERR' || a === 'RETURN' || a === 'DEBUG') continue;
      const body = lower === 'alias' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)
        ? a.slice(a.indexOf('=') + 1)
        : a;
      if (body.trim() !== '') nested.push(...parseNested(body, depth));
    }
  } else if ((lower === 'sh' || lower === 'bash' || lower === 'zsh' || lower === 'dash') && args[0] === '-c' && args[1]) {
    nested.push(...parseNested(args[1], depth));
  } else if (lower === 'ssh') {
    // ssh [flags] host [remote-command…] — remote command starts at the
    // first non-flag arg after the host.
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) i++;
    i++; // skip host
    if (i < args.length) nested.push(...parseNested(args.slice(i).join(' '), depth));
  } else if (lower === 'xargs') {
    let i = 0;
    while (i < args.length && args[i].startsWith('-') && args[i] !== '--') i++;
    if (args[i] === '--') i++;
    if (i < args.length) nested.push(...parseNested(args.slice(i).join(' '), depth));
  } else if (lower === 'find') {
    const ei = args.indexOf('-exec');
    if (ei >= 0) {
      const semi = args.indexOf(';', ei);
      const inner = args.slice(ei + 1, semi >= 0 ? semi : undefined).filter((a) => a !== '{}' && a !== '+');
      if (inner.length > 0) nested.push(...parseNested(inner.join(' '), depth));
    }
  }
  return nested;
}

/* ------------------------------------------------------- classification */

interface CommandVerdict {
  tier: RiskTier;
  notes: string[];
  neverAllowlist: boolean;
}

const READ_ONLY_BINS = new Set([
  'ls', 'dir', 'pwd', 'whoami', 'id', 'echo', 'printf', 'true', 'false', 'sleep',
  'date', 'uname', 'hostname', 'which', 'whereis', 'type', 'command', 'cat', 'head',
  'tail', 'less', 'more', 'wc', 'diff', 'grep', 'rg', 'ag', 'fd', 'find', 'jq',
  'yq', 'xxd', 'hexdump', 'file', 'stat', 'du', 'df', 'ps', 'tree', 'bat', 'sort',
  'uniq', 'cut', 'tr', 'env', 'printenv', 'history', 'set',
  'git', // refined below by subcommand
]);

// awk programs can shell out via system() — that is code execution.
function awkVerdict(args: string[], notes: string[]): CommandVerdict | null {
  if (args.some((a) => a.includes('system('))) {
    return { tier: 'destructive', notes: [...notes, 'awk-system'], neverAllowlist: true };
  }
  return null;
}

function resolveAgainstCwd(p: string, cwd: string): string {
  if (p.startsWith('~')) return p; // unresolvable without a home dir — handled as suspicious
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/** True when the path escapes the workspace, is unresolvable (`~`, sentinel),
 *  or otherwise suspicious — fail closed. */
function escapesWorkspace(p: string, cwd: string, workspaceRoot: string | undefined): boolean {
  if (p.startsWith('~')) return true;
  if (hasUnresolved(p)) return true;
  const abs = resolveAgainstCwd(p, cwd);
  const root = workspaceRoot ?? cwd;
  return !isPathWithin(abs, root);
}

function isSystemPath(p: string): boolean {
  const n = p.replace(/\\/g, '/');
  return (
    n === '/' || n.startsWith('/etc/') || n.startsWith('/sys/') || n.startsWith('/proc/') ||
    n.startsWith('/dev/') || n.startsWith('/boot/') || n === '/usr' || n.startsWith('/usr/') ||
    n === '/bin' || n === '/sbin' || n === '/lib' || n.startsWith('/var/')
  );
}

/** Extra credential-ish basenames the terminal classifier treats as secrets. */
function isTerminalCredentialPath(p: string): boolean {
  if (isCredentialFile(p)) return true;
  const n = p.replace(/\\/g, '/');
  if (/(^|\/)(shadow|gshadow)$/.test(n)) return true;
  const base = n.split('/').pop() ?? '';
  if (base === 'credentials' || base === '.npmrc' || base === '.pypirc') return true;
  return false;
}

/** Wrapper binaries that just exec their (non-flag) arguments. */
const WRAPPER_BINS = new Set(['command', 'env', 'nohup', 'timeout', 'nice', 'setsid', 'stdbuf', 'chroot', 'time', 'exec', 'coproc']);

/** First non-flag argument (skips `-x` and `-x value` pairs like git -c). */
function firstSubcommand(args: string[], valueFlags: string[] = []): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') return (args[i + 1] ?? '').toLowerCase();
    if (a.startsWith('-')) {
      if (valueFlags.includes(a)) i++; // skip its value
      continue;
    }
    return a.toLowerCase();
  }
  return '';
}

/** Env vars that hijack process behavior when prefixed to a command. */
const DANGEROUS_ENV_PREFIX = /^(LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|PYTHONPATH|NODE_OPTIONS|BASH_ENV|ENV|PERL5LIB|RUBYLIB)=/;

function classifySimple(
  cmd: SimpleCommand,
  cwd: string,
  workspaceRoot: string | undefined,
): CommandVerdict {
  const notes: string[] = [];
  if (cmd.envPrefix) notes.push('env-prefix');
  if (cmd.dangerousEnvPrefix) {
    // LD_PRELOAD-style prefixes hijack the child process itself.
    return { tier: 'destructive', notes: [...notes, 'dangerous-env-prefix'], neverAllowlist: true };
  }
  const [rawName, ...args] = cmd.argv;
  // Absolute/relative binary paths (`/bin/rm`, `./tool`) must not dodge the
  // command table — classify by basename.
  const name = (rawName ?? '').toLowerCase().split('/').pop() ?? '';
  if (!name) return { tier: 'read-only', notes, neverAllowlist: false };
  // An unresolvable command name (`${x:-rm}`) fails closed.
  if (hasUnresolved(rawName ?? '')) {
    return { tier: 'destructive', notes: [...notes, 'unresolvable-command'], neverAllowlist: true };
  }

  const destructive = (why: string): CommandVerdict => ({
    tier: 'destructive',
    notes: [...notes, why],
    neverAllowlist: true,
  });
  const network = (why: string): CommandVerdict => ({
    tier: 'network',
    notes: [...notes, why],
    neverAllowlist: true, // network egress: never blanket-allowlisted (§F7)
  });

  // --- privilege escalation wraps everything ---
  if (name === 'sudo' || name === 'doas' || name === 'su' || name === 'runas') {
    return destructive('privilege-escalation');
  }

  // --- wrapper binaries (`command rm …`, `env FOO=1 rm …`, `nohup … &`) ---
  if (WRAPPER_BINS.has(name)) {
    let i = 0;
    while (i < args.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i]) || /^-?\d+(\.\d+)?$/.test(args[i]) || args[i].startsWith('-'))) i++;
    if (i < args.length) {
      const inner = classifySimple(
        { argv: args.slice(i), redirects: cmd.redirects, envPrefix: cmd.envPrefix, dangerousEnvPrefix: cmd.dangerousEnvPrefix, follower: cmd.follower, subshellArg: cmd.subshellArg },
        cwd,
        workspaceRoot,
      );
      return { ...inner, notes: [...notes, `wrapper:${name}`, ...inner.notes] };
    }
    return { tier: 'read-only', notes: [...notes, `wrapper:${name}`], neverAllowlist: false };
  }

  // --- credential reads through terminal pagers ---
  if (['cat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'ag', 'strings'].includes(name)) {
    const hit = args.find((a) => !a.startsWith('-') && isTerminalCredentialPath(a));
    if (hit) return destructive(`credential-read:${renderToken(hit)}`);
  }

  // --- destructive binaries ---
  if (name === 'rm') {
    const flags = args.filter((a) => a.startsWith('-')).join(' ');
    const recursive = /r/i.test(flags.replace(/^-/, '')) || /--recursive/.test(flags);
    const targets = args.filter((a) => !a.startsWith('-') || a === '-');
    // Unresolvable targets (`rm -rf $DIR`) fail closed — the runtime value
    // could be `/`.
    if (targets.some((t) => hasUnresolved(t))) return destructive('unresolvable-target');
    const badTarget = targets.some(
      (t) => t === '' || t === '/' || t === '~' || t === '..' || t === '*' || t.includes('*') || escapesWorkspace(t, cwd, workspaceRoot),
    );
    if (recursive || /--force/.test(flags) || /f/.test(flags.replace(/^-/, '')) || badTarget) {
      return destructive('rm-rf-class');
    }
    return { tier: 'edit-workspace', notes: [...notes, 'file-delete'], neverAllowlist: false };
  }
  if (['dd', 'mkfs', 'mkfs.ext4', 'fdisk', 'parted'].includes(name)) return destructive('disk-destroy');
  if (name === 'find' && (args.includes('-delete') || args.includes('-exec'))) {
    return destructive('find-delete-exec');
  }
  if (['shutdown', 'reboot', 'halt', 'poweroff'].includes(name)) return destructive('host-power');
  if (['kill', 'pkill', 'killall', 'skill'].includes(name)) return destructive('process-kill');
  if (name === 'crontab' || name === 'systemctl' || name === 'service') return destructive('persistence');
  if (name === 'chmod' || name === 'chown') {
    const recursive = args.some((a) => a === '-R' || a === '--recursive');
    const targets = args.filter((a) => !a.startsWith('-'));
    if (recursive && targets.some((t) => t === '/' || isSystemPath(resolveAgainstCwd(t, cwd)))) {
      return destructive('perms-system');
    }
    return { tier: 'edit-workspace', notes, neverAllowlist: false };
  }

  // --- git subcommand refinement (skip global flags like -c) ---
  if (name === 'git') {
    const sub = firstSubcommand(args, ['-c', '--config']);
    if (sub === 'push' && args.some((a) => a === '-f' || a === '--force' || a === '--force-with-lease')) {
      return destructive('git-force-push');
    }
    if (['push', 'pull', 'fetch', 'clone', 'ls-remote'].includes(sub)) return network('git-network');
    if (sub === 'reset' && args.includes('--hard')) return destructive('git-reset-hard');
    if (sub === 'clean' && args.some((a) => a.startsWith('-') && a.includes('f'))) return destructive('git-clean-force');
    if ((sub === 'checkout' || sub === 'restore') && args.includes('--')) return destructive('git-discard-changes');
    if (sub === 'branch' && args.includes('-D')) return destructive('git-branch-delete-force');
    if (['status', 'diff', 'log', 'show', 'ls-files', 'rev-parse', 'branch', 'remote'].includes(sub)) {
      return { tier: 'read-only', notes, neverAllowlist: false };
    }
    if (['add', 'commit', 'stash', 'mv'].includes(sub)) {
      return { tier: 'edit-workspace', notes, neverAllowlist: false };
    }
    return network(`git-unknown-subcommand:${renderToken(sub || '(none)')}`);
  }

  // --- docker ---
  if (name === 'docker') {
    const sub = firstSubcommand(args);
    if (['rm', 'rmi', 'volume', 'network', 'system'].includes(sub)) return destructive(`docker-${sub}`);
    if (['run', 'exec', 'create'].includes(sub)) return destructive('docker-host-access');
    if (['ps', 'images', 'logs', 'inspect', 'stats'].includes(sub)) return { tier: 'read-only', notes, neverAllowlist: false };
    if (['pull', 'push', 'build'].includes(sub)) return network(`docker-${sub}`);
    return network(`docker-unknown:${renderToken(sub || '')}`);
  }

  // --- kubectl / terraform / aws ---
  if (name === 'kubectl') {
    const sub = firstSubcommand(args);
    if (sub === 'delete' || sub === 'exec') return destructive(`kubectl-${sub}`);
    if (['get', 'describe', 'logs', 'explain'].includes(sub)) return { tier: 'read-only', notes, neverAllowlist: false };
    return network(`kubectl-${renderToken(sub || 'unknown')}`);
  }
  if (name === 'terraform') {
    const sub = firstSubcommand(args);
    if (sub === 'apply' || sub === 'destroy') return destructive(`terraform-${sub}`);
    if (sub === 'plan' || sub === 'show' || sub === 'output') return { tier: 'read-only', notes, neverAllowlist: false };
    return network(`terraform-${renderToken(sub || 'unknown')}`);
  }
  if (name === 'aws') {
    const lowered = args.map((a) => a.toLowerCase());
    if (lowered.includes('s3') && lowered.some((a) => a === 'rm' || a === 'rb')) {
      return destructive('aws-s3-delete');
    }
    return network('aws-api');
  }

  // --- network egress ---
  if (name === 'curl' || name === 'wget') return network('http-egress');
  if (name === 'ssh') return network('ssh');
  if (['scp', 'sftp', 'rsync'].includes(name)) return network('file-transfer');
  if (name === 'nc' || name === 'ncat' || name === 'netcat' || name === 'socat') {
    if (args.includes('-l') || args.includes('--listen')) return destructive('net-listener');
    return network('netcat');
  }
  if (name === 'gh') return network('gh-api');

  // --- install deps ---
  if ((name === 'npm' || name === 'pnpm' || name === 'yarn') && ['install', 'add', 'ci', 'uninstall', 'remove'].includes(firstSubcommand(args, ['--prefix']))) {
    return { tier: 'install-deps', notes, neverAllowlist: false };
  }
  if (name === 'npm' && firstSubcommand(args, ['--prefix']) === 'publish') return network('npm-publish');
  if ((name === 'pip' || name === 'pip3') && ['install', 'uninstall'].includes(firstSubcommand(args))) {
    return { tier: 'install-deps', notes, neverAllowlist: false };
  }
  if (['apt-get', 'apt', 'yum', 'dnf', 'apk', 'brew'].includes(name)) {
    const sub = (args[0] ?? '').toLowerCase();
    if (sub === 'install' || sub === 'add' || sub === 'remove' || sub === 'uninstall') {
      return { tier: 'install-deps', notes, neverAllowlist: false };
    }
    return network(`${renderToken(name)}-${renderToken(sub || 'unknown')}`);
  }
  if (name === 'cargo' && ['add', 'install', 'uninstall'].includes(firstSubcommand(args))) {
    return { tier: 'install-deps', notes, neverAllowlist: false };
  }
  if (name === 'go' && ['get', 'install'].includes(firstSubcommand(args))) {
    return { tier: 'install-deps', notes, neverAllowlist: false };
  }

  // --- run tests / builds ---
  if (['pytest', 'vitest', 'jest', 'mocha', 'ava', 'tap'].includes(name)) {
    return { tier: 'run-tests', notes, neverAllowlist: false };
  }
  if ((name === 'npm' || name === 'pnpm' || name === 'yarn') && ['test', 'run', 'build', 'exec'].includes(firstSubcommand(args, ['--prefix']))) {
    return { tier: 'run-tests', notes, neverAllowlist: false };
  }
  if ((name === 'cargo' || name === 'go') && ['test', 'build'].includes(firstSubcommand(args))) {
    return { tier: 'run-tests', notes, neverAllowlist: false };
  }
  if (['tsc', 'make', 'cmake', 'gradle', 'mvn'].includes(name)) {
    return { tier: 'run-tests', notes, neverAllowlist: false };
  }
  if (['node', 'python', 'python3', 'deno', 'bun'].includes(name)) {
    const first = args.find((a) => !a.startsWith('-'));
    if (first === '-e' || args.includes('-e') || args.includes('-c')) {
      return { tier: 'run-tests', notes: [...notes, 'inline-code'], neverAllowlist: false };
    }
    return { tier: 'run-tests', notes, neverAllowlist: false };
  }
  if (name === 'source' || name === '.') {
    const dynamic = cmd.subshellArg || args.some((a) => hasUnresolved(a));
    if (dynamic) return destructive('dynamic-source');
    return { tier: 'run-tests', notes: [...notes, 'shell-source'], neverAllowlist: false };
  }

  // --- shells: recurse into -c, bare receiving pipe = remote code exec ---
  if (['sh', 'bash', 'zsh', 'dash', 'pwsh', 'powershell'].includes(name)) {
    if (cmd.follower === '|' || args.length === 0) {
      // This shell instance's stdin comes from a pipe (or it's bare) —
      // the classic `curl … | sh` remote-code-execution shape.
      return destructive('pipe-to-shell');
    }
    if (args[0] === '-c' && (cmd.subshellArg || args.slice(1).some((a) => hasUnresolved(a)))) {
      // The -c body is generated dynamically — static analysis is blind.
      return destructive('dynamic-shell-code');
    }
    // `-c` bodies were already expanded into nested commands by the caller.
    return { tier: 'run-tests', notes, neverAllowlist: false };
  }
  if (name === 'eval') {
    const dynamic = cmd.subshellArg || args.some((a) => hasUnresolved(a));
    if (dynamic) return destructive('dynamic-eval');
    return { tier: 'run-tests', notes: [...notes, 'eval'], neverAllowlist: false };
  }

  // --- file mutation in/out of workspace ---
  if (['mkdir', 'touch', 'cp', 'mv', 'ln', 'tar', 'unzip', 'zip'].includes(name)) {
    const targets = args.filter((a) => !a.startsWith('-'));
    if (targets.some((t) => escapesWorkspace(t, cwd, workspaceRoot))) return destructive('write-outside-workspace');
    return { tier: 'edit-workspace', notes, neverAllowlist: false };
  }

  // --- redirect targets are writes ---
  // (handled by the caller via cmd.redirects)

  // --- awk: system() inside the program is code execution ---
  if (name === 'awk' || name === 'gawk' || name === 'mawk') {
    const v = awkVerdict(args, notes);
    if (v) return v;
    return { tier: 'read-only', notes, neverAllowlist: false };
  }

  // --- sed -i edits in place; tee/install write files ---
  if (name === 'sed') {
    if (args.some((a) => a === '-i' || a.startsWith('-i'))) {
      return { tier: 'edit-workspace', notes: [...notes, 'sed-in-place'], neverAllowlist: false };
    }
    return { tier: 'read-only', notes, neverAllowlist: false };
  }
  if (name === 'tee' || name === 'install') {
    const targets = args.filter((a) => !a.startsWith('-'));
    if (targets.some((t) => escapesWorkspace(t, cwd, workspaceRoot))) return destructive('write-outside-workspace');
    return { tier: 'edit-workspace', notes, neverAllowlist: false };
  }

  // --- known read-only bins ---
  if (READ_ONLY_BINS.has(name)) return { tier: 'read-only', notes, neverAllowlist: false };

  // --- unknown binary: fail-safe direction, never blanket-allowlisted ---
  return { tier: 'network', notes: [...notes, `unknown-command:${renderToken(name)}`], neverAllowlist: true };
}

function classifyRedirect(
  op: string,
  target: string,
  cwd: string,
  workspaceRoot: string | undefined,
): CommandVerdict {
  if (op === '<') {
    if (isTerminalCredentialPath(target)) {
      return { tier: 'destructive', notes: [`credential-read-redirect:${renderToken(target)}`], neverAllowlist: true };
    }
    return { tier: 'read-only', notes: [], neverAllowlist: false };
  }
  // Output redirects are writes.
  if (target.startsWith('~') || isSystemPath(resolveAgainstCwd(target, cwd))) {
    return { tier: 'destructive', notes: [`redirect-system:${renderToken(target)}`], neverAllowlist: true };
  }
  if (escapesWorkspace(target, cwd, workspaceRoot)) {
    return { tier: 'destructive', notes: [`redirect-outside-workspace:${renderToken(target)}`], neverAllowlist: true };
  }
  return { tier: 'edit-workspace', notes: [], neverAllowlist: false };
}

/** Serialize a simple command back to a normalized string (parser output,
 *  not raw text — defeats quoting/whitespace/comment tricks). Unresolvable
 *  expansions render as `<unresolved>` so no env values leak into logs. */
function serializeCommand(cmd: SimpleCommand): string {
  const parts = [...cmd.argv.map(renderToken)];
  for (const r of cmd.redirects) parts.push(r.op, renderToken(r.target));
  return parts.join(' ');
}

export interface TerminalAnalysis {
  commands: SimpleCommand[];
  canonicalBody: string;
  tier: RiskTier;
  notes: string[];
  neverAllowlist: boolean;
  parseError: boolean;
}

/** Split raw command text into lines on newline separators that are NOT
 *  inside quotes. Bash executes newlines as command separators, but
 *  shell-quote treats them as whitespace — without this split,
 *  `ls\nrm -rf /` would parse as one benign-looking command. */
function splitLines(raw: string): string[] {
  const lines: string[] = [];
  let cur = '';
  let sq = false;
  let dq = false;
  let esc = false;
  for (const ch of raw) {
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (ch === '\\') {
      cur += ch;
      esc = true;
      continue;
    }
    if (ch === "'" && !dq) {
      sq = !sq;
      cur += ch;
      continue;
    }
    if (ch === '"' && !sq) {
      dq = !dq;
      cur += ch;
      continue;
    }
    if ((ch === '\n' || ch === '\r') && !sq && !dq) {
      if (cur.trim() !== '') lines.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== '') lines.push(cur);
  return lines;
}

/** Extract `backtick` command-substitution bodies (quote-aware: backticks are
 *  literal inside single quotes, substitutions inside double quotes).
 *  shell-quote does not split these out, so without this `echo \`rm -rf /\``
 *  would look like a harmless echo. */
function extractBackticks(line: string): string[] {
  const bodies: string[] = [];
  let sq = false;
  let dq = false;
  let esc = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (esc) {
      esc = false;
      i++;
      continue;
    }
    if (ch === '\\') {
      esc = true;
      i++;
      continue;
    }
    if (ch === "'" && !dq) {
      sq = !sq;
      i++;
      continue;
    }
    if (ch === '"' && !sq) {
      dq = !dq;
      i++;
      continue;
    }
    if (ch === '`' && !sq) {
      // Find the closing backtick.
      let j = i + 1;
      let innerEsc = false;
      while (j < line.length) {
        const c2 = line[j];
        if (innerEsc) {
          innerEsc = false;
          j++;
          continue;
        }
        if (c2 === '\\') {
          innerEsc = true;
          j++;
          continue;
        }
        if (c2 === '`') break;
        j++;
      }
      if (j < line.length) {
        bodies.push(line.slice(i + 1, j));
        i = j + 1;
        continue;
      }
      // Unclosed backtick: leave it — the shell parse will fail closed.
      i++;
      continue;
    }
    i++;
  }
  return bodies;
}

/** Extract `name(){ …; }` function-definition bodies (quote/brace-aware).
 *  Returns the body plus whether it looks like a fork bomb: the classic
 *  `:(){ :|:& };:` shape — the body re-invokes its own name through a pipe
 *  into the background. Normal functions (`f(){ npm test; }`) are unaffected. */
function extractFunctionBodies(line: string): Array<{ name: string; body: string; forkBomb: boolean }> {
  const out: Array<{ name: string; body: string; forkBomb: boolean }> = [];
  const re = /([A-Za-z_:][A-Za-z0-9_:]*)\s*\(\s*\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const name = m[1];
    let depth = 0;
    let j = m.index + m[0].length - 1; // at the opening {
    let inS = false;
    let inD = false;
    let esc = false;
    for (; j < line.length; j++) {
      const ch = line[j];
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === '\\') {
        esc = true;
        continue;
      }
      if (ch === "'" && !inD) {
        inS = !inS;
        continue;
      }
      if (ch === '"' && !inS) {
        inD = !inD;
        continue;
      }
      if (inS || inD) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (j >= line.length) continue; // unclosed — shell parse fails closed anyway
    const body = line.slice(m.index + m[0].length, j);
    const forkBomb = body.includes(name) && body.includes('|') && body.includes('&');
    out.push({ name, body, forkBomb });
  }
  return out;
}

/** Full analysis of a raw terminal command string. */
export function analyzeTerminalCommand(
  raw: string,
  cwd: string,
  workspaceRoot?: string,
): TerminalAnalysis {
  // Parse line-by-line: newlines are command separators in bash.
  const lines = splitLines(raw);
  const commands: SimpleCommand[] = [];
  let hasSubshell = false;
  let hasPipe = false;
  let forkBomb = false;
  for (const line of lines) {
    const s = splitCommands(line);
    if (s.parseError) {
      return {
        commands: [],
        canonicalBody: raw.trim().slice(0, 120),
        tier: 'destructive',
        notes: ['unparseable-command'],
        neverAllowlist: true,
        parseError: true,
      };
    }
    commands.push(...s.commands);
    // Backtick bodies are executed by the shell — analyze them as nested commands.
    for (const body of extractBackticks(line)) {
      hasSubshell = true;
      for (const nested of parseNested(body, 1)) {
        commands.push(nested);
      }
    }
    // Function-definition bodies execute when called — analyze them too.
    for (const fb of extractFunctionBodies(line)) {
      if (fb.forkBomb) forkBomb = true;
      for (const nested of parseNested(fb.body, 1)) {
        commands.push(nested);
      }
    }
    hasSubshell = hasSubshell || s.hasSubshell;
    hasPipe = hasPipe || s.hasPipe;
  }
  if (commands.length === 0) {
    // Empty input (or only comments/whitespace): fail closed.
    return {
      commands: [],
      canonicalBody: '',
      tier: 'destructive',
      notes: ['empty-command'],
      neverAllowlist: true,
      parseError: true,
    };
  }
  const { hasEnvExpansion } = detectExpansions(raw);
  let tier: RiskTier = 'read-only';
  const notes: string[] = [];
  let neverAllowlist = false;

  const all: SimpleCommand[] = [];
  for (const c of commands) {
    all.push(c);
    all.push(...expandNested(c, 1));
  }

  for (const cmd of all) {
    const v = classifySimple(cmd, cwd, workspaceRoot);
    tier = maxTier(tier, v.tier);
    notes.push(...v.notes);
    neverAllowlist = neverAllowlist || v.neverAllowlist;
    for (const r of cmd.redirects) {
      const rv = classifyRedirect(r.op, r.target, cwd, workspaceRoot);
      tier = maxTier(tier, rv.tier);
      notes.push(...rv.notes);
      neverAllowlist = neverAllowlist || rv.neverAllowlist;
    }
  }

  if (hasSubshell) notes.push('subshell');
  if (hasPipe) notes.push('pipe');
  if (forkBomb) {
    tier = 'destructive';
    notes.push('fork-bomb-shape');
    neverAllowlist = true;
  }
  if (hasEnvExpansion) {
    notes.push('env-expansion');
    // Env-var tricks in a destructive-shaped command: the parser cannot see
    // the real values, so the action can never be blanket-allowlisted and a
    // destructive reading stays destructive.
    if (tierRank(tier) >= tierRank('install-deps')) neverAllowlist = true;
  }

  const canonicalBody = commands
    .map((c, i) => serializeCommand(c) + (c.follower && i < commands.length - 1 ? ` ${c.follower}` : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { commands: all, canonicalBody, tier, notes: [...new Set(notes)], neverAllowlist, parseError: false };
}

/* ------------------------------------------------------- tiny glob match */

/** Minimal glob → RegExp: `*` never crosses whitespace, `**` crosses anything. */
export function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^\\s]*';
      }
    } else if (c === '?') {
      re += '[^\\s]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(re + '$');
}

/* ------------------------------------------------------- PermissionIntel */

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

/** Normalize a canonical command into a pattern for weekly-summary grouping. */
function generalizeCanonical(canonical: string): string {
  return canonical
    .replace(/(['"])[^'"]*\1/g, '*') // quoted strings → *
    .replace(/\/[^\s)]+/g, '/*') // absolute-ish paths → /*
    .replace(/\b\d+(\.\d+)+\b/g, '*'); // versions → *
}

export class PermissionIntel {
  private profile: PolicyProfile;
  private readonly allowlist: AllowEntry[] = [];
  private readonly denylist: DenyEntry[] = [];
  private readonly plans = new Map<string, PlanHandle>();
  private readonly audit: AuditEntry[] = [];
  private sandboxOnOverride: boolean | undefined;

  constructor(opts: { profile?: PolicyProfile; sandboxOn?: boolean } = {}) {
    const envProfile = (process.env.SUNDAY_POLICY_PROFILE ?? '').trim().toLowerCase();
    this.profile =
      opts.profile ??
      (envProfile === 'cautious' || envProfile === 'balanced' || envProfile === 'autopilot'
        ? envProfile
        : 'balanced');
    this.sandboxOnOverride = opts.sandboxOn;
  }

  getProfile(): PolicyProfile {
    return this.profile;
  }

  setProfile(p: PolicyProfile): void {
    this.profile = p;
  }

  /** Autopilot is only effective in a trusted workspace with the sandbox on;
   *  otherwise it degrades to balanced (fail-safe). */
  effectiveProfile(ctx: PolicyContext): PolicyProfile {
    if (this.profile !== 'autopilot') return this.profile;
    const trusted = isWorkspaceTrusted(ctx.workspaceRoot ?? ctx.cwd);
    const sandboxOn =
      this.sandboxOnOverride ?? sandboxConfigFromEnv().mode !== 'off';
    if (trusted && sandboxOn) return 'autopilot';
    return 'balanced';
  }

  /* ------------------------------------------------- classification */

  /** Classify a tool call. Returns null when the tool is not classifiable
   *  (the caller should fall back to the legacy policy gate). */
  classify(
    tool: string,
    args: Record<string, unknown>,
    cwd: string,
    workspaceRoot?: string,
  ): ClassifiedAction | null {
    if (tool === 'run_terminal') {
      const command = args['command'];
      if (typeof command !== 'string' || command.trim() === '') return null;
      const dir = typeof args['cwd'] === 'string' && args['cwd'] !== '' ? (args['cwd'] as string) : cwd;
      const a = analyzeTerminalCommand(command, dir, workspaceRoot);
      return {
        tool,
        canonical: `run_terminal(${a.canonicalBody})`,
        tier: a.tier,
        notes: a.notes,
        neverAllowlist: a.neverAllowlist,
      };
    }
    const pathOf = (k: string): string | null => {
      const v = args[k];
      return typeof v === 'string' ? v : null;
    };
    if (tool === 'read_file' || tool === 'list_files' || tool === 'glob_files' || tool === 'search_files' || tool === 'read_directory') {
      const p = pathOf('path') ?? pathOf('dir') ?? '';
      if (p !== '' && isCredentialFile(p)) {
        return { tool, canonical: `${tool}(path=${p})`, tier: 'destructive', notes: ['credential-read'], neverAllowlist: true };
      }
      return { tool, canonical: `${tool}(path=${p})`, tier: 'read-only', notes: [], neverAllowlist: false };
    }
    if (tool === 'write_file' || tool === 'edit_file' || tool === 'create_directory' || tool === 'apply_patch') {
      const p = pathOf('path') ?? '';
      if (p !== '' && escapesWorkspace(p, cwd, workspaceRoot)) {
        return { tool, canonical: `${tool}(path=${p})`, tier: 'destructive', notes: ['write-outside-workspace'], neverAllowlist: true };
      }
      return { tool, canonical: `${tool}(path=${p})`, tier: 'edit-workspace', notes: [], neverAllowlist: false };
    }
    if (tool === 'delete_file') {
      const p = pathOf('path') ?? '';
      if (p !== '' && escapesWorkspace(p, cwd, workspaceRoot)) {
        return { tool, canonical: `${tool}(path=${p})`, tier: 'destructive', notes: ['delete-outside-workspace'], neverAllowlist: true };
      }
      return { tool, canonical: `${tool}(path=${p})`, tier: 'edit-workspace', notes: ['file-delete'], neverAllowlist: false };
    }
    return null;
  }

  /* ------------------------------------------------- allow/deny lists */

  /** Grant a scoped "always allow". Throws for destructive classes — they
   *  can never be blanket-allowlisted (one-time approvals only). */
  grant(entry: {
    tool: string;
    scope: AllowScope;
    tier: RiskTier;
    sessionId?: string;
    createdBy?: string;
  }): AllowEntry {
    if (tierRank(entry.tier) >= tierRank('destructive') || tierRank(entry.tier) >= tierRank('network')) {
      throw new Error(
        `permission-intel: cannot blanket-allow tier '${entry.tier}' — destructive classes ` +
          `(rm -rf, force-push, credential reads, network egress) are one-time-approval only`,
      );
    }
    if (entry.scope.kind === 'directory' && !entry.sessionId) {
      throw new Error('permission-intel: directory-scoped allows are session-bound (pass sessionId)');
    }
    const e: AllowEntry = {
      id: nextId('allow'),
      tool: entry.tool,
      scope: entry.scope,
      tier: entry.tier,
      sessionId: entry.sessionId ?? null,
      createdAt: Date.now(),
      createdBy: entry.createdBy ?? 'user',
    };
    this.allowlist.push(e);
    return e;
  }

  revokeAllow(id: string): boolean {
    const i = this.allowlist.findIndex((e) => e.id === id);
    if (i < 0) return false;
    this.allowlist.splice(i, 1);
    return true;
  }

  listAllow(): AllowEntry[] {
    return [...this.allowlist];
  }

  deny(pattern: string, reason: string, createdBy = 'user'): DenyEntry {
    const e: DenyEntry = { id: nextId('deny'), pattern, createdAt: Date.now(), createdBy, reason };
    this.denylist.push(e);
    return e;
  }

  revokeDeny(id: string): boolean {
    const i = this.denylist.findIndex((e) => e.id === id);
    if (i < 0) return false;
    this.denylist.splice(i, 1);
    return true;
  }

  private allowMatches(e: AllowEntry, action: ClassifiedAction, ctx: PolicyContext): boolean {
    if (e.tool !== action.tool) return false;
    if (tierRank(action.tier) > tierRank(e.tier)) return false; // entry covers ≤ its tier
    const s = e.scope;
    switch (s.kind) {
      case 'exact':
        return action.canonical === s.command;
      case 'pattern':
        return globToRegExp(s.glob).test(action.canonical);
      case 'directory': {
        if (e.sessionId !== (ctx.sessionId ?? 'default')) return false;
        return isPathWithin(resolve(ctx.cwd), resolve(s.dir));
      }
      case 'repo': {
        const root = ctx.workspaceRoot ?? ctx.cwd;
        return isPathWithin(resolve(root), resolve(s.repoRoot));
      }
    }
  }

  /* ------------------------------------------------- batch plan approval */

  /** Approve every predicted action of a plan at once. The agent going
   *  off-plan triggers a re-ask. Each entry is single-use. */
  approvePlan(
    actions: Array<{ tool: string; args: Record<string, unknown> }>,
    ctx: PolicyContext,
    createdBy = 'user',
  ): PlanHandle {
    const remaining: string[] = [];
    for (const a of actions) {
      const c = this.classify(a.tool, a.args, ctx.cwd, ctx.workspaceRoot);
      if (!c) {
        throw new Error(`permission-intel: cannot plan-approve unclassifiable tool '${a.tool}'`);
      }
      remaining.push(c.canonical);
    }
    const h: PlanHandle = {
      id: nextId('plan'),
      createdAt: Date.now(),
      createdBy,
      remaining,
    };
    this.plans.set(h.id, h);
    this.log({
      principal: createdBy,
      tool: '*plan*',
      canonical: `plan(${h.id}): ${remaining.length} actions`,
      tier: 'read-only',
      decision: 'allow',
      via: 'plan',
    });
    return h;
  }

  /** Consume one matching plan entry. Returns 'matched' | 'off-plan' | 'unknown-plan'.
   *  A fully-consumed plan is kept (not deleted) so any further action is
   *  still reported as 'off-plan' rather than silently unclassified. */
  checkPlan(planId: string, action: ClassifiedAction): 'matched' | 'off-plan' | 'unknown-plan' {
    const h = this.plans.get(planId);
    if (!h) return 'unknown-plan';
    const i = h.remaining.indexOf(action.canonical);
    if (i < 0) return 'off-plan';
    h.remaining.splice(i, 1);
    return 'matched';
  }

  /** One-time approval for a single action (the approval dialog's "Approve"). */
  approveOnce(
    tool: string,
    args: Record<string, unknown>,
    ctx: PolicyContext,
    createdBy = 'user',
  ): PlanHandle {
    return this.approvePlan([{ tool, args }], ctx, createdBy);
  }

  /* ------------------------------------------------- decision */

  decide(
    tool: string,
    args: Record<string, unknown>,
    ctx: PolicyContext,
    planId?: string,
  ): DecideResult {
    const principal = ctx.principal ?? 'agent';
    const action = this.classify(tool, args, ctx.cwd, ctx.workspaceRoot);
    if (!action) {
      return {
        decision: 'allow',
        action: null,
        reason: 'not classified by permission-intel',
        via: 'unclassified',
      };
    }

    const audit = (decision: IntelDecision, via: DecideResult['via'], scope?: string) => {
      this.log({ principal, tool, canonical: action.canonical, tier: action.tier, decision, via, scope });
    };

    // 1. Deny always wins.
    for (const d of this.denylist) {
      if (globToRegExp(d.pattern).test(action.canonical)) {
        audit('deny', 'deny-list');
        return { decision: 'deny', action, reason: `denied by policy: ${d.reason}`, via: 'deny-list' };
      }
    }

    // 2. Batch plan: a matching planned action is allowed (explicit, single-use).
    if (planId) {
      const r = this.checkPlan(planId, action);
      if (r === 'matched') {
        audit('allow', 'plan');
        return { decision: 'allow', action, reason: 'covered by approved plan', via: 'plan' };
      }
      if (r === 'off-plan') {
        audit('ask', 'plan');
        return {
          decision: 'ask',
          action,
          reason: `agent went off-plan — '${action.canonical}' was not in the approved plan; re-approval required`,
          via: 'plan',
          askScopes: this.askScopesFor(action, ctx),
        };
      }
    }

    // 3. Scoped allowlist (never for destructive classes).
    if (!action.neverAllowlist) {
      for (const e of this.allowlist) {
        if (this.allowMatches(e, action, ctx)) {
          audit('allow', 'allowlist', describeScope(e.scope));
          return { decision: 'allow', action, reason: `allowlisted (${describeScope(e.scope)})`, via: 'allowlist' };
        }
      }
    }

    // 4. Profile default.
    const effective = this.effectiveProfile(ctx);
    const d = PROFILE_DEFAULTS[effective][action.tier];
    audit(d, 'profile');
    if (d === 'allow') {
      return { decision: 'allow', action, reason: `profile '${effective}' allows ${action.tier}`, via: 'profile' };
    }
    if (d === 'deny') {
      return {
        decision: 'deny',
        action,
        reason:
          `profile '${effective}' denies ${action.tier} actions — '${action.canonical}' ` +
          (action.neverAllowlist ? '(destructive class: one-time approval only, never blanket-allowlisted)' : ''),
        via: 'profile',
      };
    }
    return {
      decision: 'ask',
      action,
      reason: `profile '${effective}' requires approval for ${action.tier} — '${action.canonical}'`,
      via: 'profile',
      askScopes: this.askScopesFor(action, ctx),
    };
  }

  /** Scopes the approval dialog may offer for an ask decision. */
  askScopesFor(action: ClassifiedAction, ctx: PolicyContext): AllowScope[] {
    if (action.neverAllowlist) return []; // one-time approval only — no blanket scopes
    const scopes: AllowScope[] = [
      { kind: 'exact', command: action.canonical },
      { kind: 'pattern', glob: generalizeCanonical(action.canonical) },
      { kind: 'directory', dir: ctx.cwd },
    ];
    if (ctx.workspaceRoot) scopes.push({ kind: 'repo', repoRoot: ctx.workspaceRoot });
    return scopes;
  }

  /* ------------------------------------------------- audit + summary */

  private log(e: Omit<AuditEntry, 'ts'>): void {
    this.audit.push({ ts: Date.now(), ...e });
    if (this.audit.length > 5000) this.audit.splice(0, this.audit.length - 5000);
  }

  auditEntries(): AuditEntry[] {
    return [...this.audit];
  }

  clearAudit(): void {
    this.audit.length = 0;
  }

  /**
   * Weekly summary: totals plus allowlist suggestions. Only suggests entries
   * for tiers that CAN be blanket-allowlisted — destructive/network classes
   * are never suggested.
   */
  weeklySummary(now: number = Date.now()): {
    total: number;
    byDecision: Record<IntelDecision, number>;
    byTier: Record<RiskTier, number>;
    suggestions: Array<{ pattern: string; count: number; tier: RiskTier; example: string }>;
  } {
    const weekAgo = now - 7 * 24 * 3600 * 1000;
    const recent = this.audit.filter((e) => e.ts >= weekAgo);
    const byDecision: Record<IntelDecision, number> = { allow: 0, deny: 0, ask: 0 };
    const byTier: Record<RiskTier, number> = {
      'read-only': 0,
      'edit-workspace': 0,
      'run-tests': 0,
      'install-deps': 0,
      network: 0,
      destructive: 0,
    };
    for (const e of recent) {
      byDecision[e.decision]++;
      byTier[e.tier]++;
    }
    // Group ask-decisions by generalized pattern; suggest when asked ≥3× and
    // the tier is allowlistable.
    const groups = new Map<string, { count: number; tier: RiskTier; example: string }>();
    for (const e of recent) {
      if (e.decision !== 'ask') continue;
      if (tierRank(e.tier) >= tierRank('network')) continue; // never blanket-allowlisted
      const key = `${e.tool} :: ${generalizeCanonical(e.canonical)}`;
      const g = groups.get(key) ?? { count: 0, tier: e.tier, example: e.canonical };
      g.count++;
      if (tierRank(e.tier) > tierRank(g.tier)) g.tier = e.tier;
      groups.set(key, g);
    }
    const suggestions = [...groups.entries()]
      .filter(([, g]) => g.count >= 3)
      .map(([key, g]) => ({
        pattern: key.split(' :: ')[1],
        count: g.count,
        tier: g.tier,
        example: g.example,
      }))
      .sort((a, b) => b.count - a.count);
    return { total: recent.length, byDecision, byTier, suggestions };
  }
}

function describeScope(s: AllowScope): string {
  switch (s.kind) {
    case 'exact':
      return `exact '${s.command}'`;
    case 'pattern':
      return `pattern '${s.glob}'`;
    case 'directory':
      return `directory '${s.dir}' (this session)`;
    case 'repo':
      return `repo '${s.repoRoot}'`;
  }
}

/** Daemon-side transport for the `sunday.policy.profile` VS Code setting. */
export const POLICY_PROFILE_ENV = 'SUNDAY_POLICY_PROFILE';
