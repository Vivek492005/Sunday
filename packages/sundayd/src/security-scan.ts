/**
 * security-scan.ts — F10: pre-commit / pre-PR security step for the Verifier.
 *
 * Runs offline-first, config-driven:
 *  1. SECRET SCAN — gitleaks-style patterns over staged/changed content.
 *  2. DIFF ALERTS — flags newly introduced:
 *     - network calls (fetch/axios/http.get/curl in code),
 *     - new dependencies (package.json / requirements / go.mod additions),
 *     - new process execution (exec/spawn/system/popen).
 *  3. OSV ADVISORY CHECK — stubbed offline interface; when an OSV DB cache
 *     is present it is consulted, otherwise the check reports `skipped`.
 *
 * Pure functions operate on strings (file content / unified diffs) so the
 * step is trivially unit-testable and embeddable in CI or the IDE.
 */

export interface SecretHit {
  /** Stable rule id. */
  rule: string;
  /** e.g. 'aws-access-key', 'github-pat'. */
  label: string;
  /** File the secret was found in (if known). */
  file?: string;
  /** 1-based line number (if known). */
  line?: number;
  /** Redacted preview — never the secret itself. */
  preview: string;
}

interface SecretRule {
  rule: string;
  label: string;
  pattern: RegExp;
}

/** Gitleaks-style secret patterns (subset, high-precision). */
const SECRET_RULES: SecretRule[] = [
  {
    rule: 'aws-access-key',
    label: 'AWS access key ID',
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    rule: 'aws-secret-key',
    label: 'AWS secret access key assignment',
    pattern:
      /\baws_secret_access_key\b\s*[:=]\s*['"]?[A-Za-z0-9/+=]{20,}['"]?/i,
  },
  {
    rule: 'github-pat',
    label: 'GitHub personal access token',
    pattern: /\bghp_[A-Za-z0-9]{20,}\b/,
  },
  {
    rule: 'github-oauth',
    label: 'GitHub OAuth token',
    pattern: /\bgho_[A-Za-z0-9]{20,}\b/,
  },
  {
    rule: 'openai-key',
    label: 'OpenAI API key',
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/,
  },
  {
    rule: 'generic-api-key',
    label: 'Generic API key assignment',
    pattern:
      /\b(api[_-]?key|apikey)\b\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i,
  },
  {
    rule: 'private-key-block',
    label: 'PEM private key block',
    pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    rule: 'slack-token',
    label: 'Slack token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    rule: 'google-api-key',
    label: 'Google API key',
    pattern: /\bAIza[0-9A-Za-z\-_]{20,}\b/,
  },
  {
    rule: 'password-assign',
    label: 'Hardcoded password assignment',
    pattern: /\bpassword\b\s*[:=]\s*['"][^'"]{6,}['"]/i,
  },
  {
    rule: 'connection-string',
    label: 'DB connection string with credentials',
    pattern:
      /\b(mongodb|postgres|mysql):\/\/[^/\s:]+:[^/\s@]+@[^\s'"]+/i,
  },
];

/** Files that are expected to hold secrets — finding a *new* secret-shaped
 *  value in any other file is a hit; inside these, only key *blocks* count. */
const SECRET_BEARING_FILES = /\.(env|pem|key)$/i;

/**
 * Scan content for secrets. Returns hits with redacted previews.
 * Set `file`/`lineBase` for precise reporting.
 */
export function scanSecrets(
  content: string,
  file?: string,
  lineBase = 1
): SecretHit[] {
  const hits: SecretHit[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const r of SECRET_RULES) {
      if (!r.pattern.test(line)) continue;
      // Inside .env/.pem files, plain assignments are expected — only flag
      // key *blocks* there to avoid noise.
      if (
        file &&
        SECRET_BEARING_FILES.test(file) &&
        r.rule !== 'private-key-block'
      ) {
        continue;
      }
      hits.push({
        rule: r.rule,
        label: r.label,
        file,
        line: lineBase + i,
        preview: redactPreview(line),
      });
    }
  }
  return hits;
}

/** Keep first/last few chars, mask the middle — never leak the secret. */
function redactPreview(line: string): string {
  const t = line.trim().slice(0, 80);
  if (t.length <= 12) return '[redacted]';
  return `${t.slice(0, 6)}…[redacted]…${t.slice(-4)}`;
}

/* ------------------------------------------------------------ diff alerts */

export type DiffAlertKind = 'new-network-call' | 'new-dependency' | 'new-exec';

export interface DiffAlert {
  kind: DiffAlertKind;
  file: string;
  /** The added line that triggered the alert (trimmed, secrets redacted). */
  line: string;
  detail: string;
}

const NETWORK_CALL_RE = new RegExp(
  [
    /\bfetch\s*\(/.source,
    /\baxios\.(get|post|put|delete|request)\s*\(/.source,
    /\bhttp\.(get|request)\s*\(/.source,
    /\bhttps\.(get|request)\s*\(/.source,
    /\bcurl\b/.source,
    /\bWebSocket\s*\(/.source,
    /\bopenai\.\w+\s*\(/.source,
  ].join('|')
);

const EXEC_RE = new RegExp(
  [
    /\bexec\s*\(/.source,
    /\bexecSync\s*\(/.source,
    /\bspawn\s*\(/.source,
    /\bexecFile\s*\(/.source,
    /\bos\.system\s*\(/.source,
    /\bsubprocess\.(Popen|run|call)\s*\(/.source,
    /\beval\s*\(/.source,
    /\bnew\s+Function\s*\(/.source,
    /\bchild_process\b/.source,
  ].join('|')
);

/**
 * Parse a unified diff, returning per-file lists of ADDED lines.
 * Minimal parser — handles `diff --git`, `+++ b/path`, and `+` lines.
 */
export function addedLinesByFile(diff: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ b/')) {
      current = raw.slice(6);
      if (!out.has(current)) out.set(current, []);
    } else if (raw.startsWith('+') && !raw.startsWith('+++') && current) {
      out.get(current)!.push(raw.slice(1));
    }
  }
  return out;
}

function isDependencyFile(file: string): boolean {
  return /(^|\/)(package\.json|requirements(\.txt|\.in)?|Pipfile|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|composer\.json)$/.test(
    file
  );
}

/**
 * Scan a unified diff for newly introduced network calls, dependencies,
 * and process-execution primitives. Pure function — feed it `git diff`.
 */
export function scanDiff(diff: string): DiffAlert[] {
  const alerts: DiffAlert[] = [];
  for (const [file, added] of addedLinesByFile(diff)) {
    const depFile = isDependencyFile(file);
    for (const line of added) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#'))
        continue;
      if (!depFile && NETWORK_CALL_RE.test(line)) {
        alerts.push({
          kind: 'new-network-call',
          file,
          line: redactPreview(line),
          detail:
            'New network call introduced — verify the endpoint is expected.',
        });
      }
      if (EXEC_RE.test(line)) {
        alerts.push({
          kind: 'new-exec',
          file,
          line: redactPreview(line),
          detail:
            'New process-execution primitive introduced — verify it is necessary and sandboxed.',
        });
      }
      if (depFile && /^\+?\s*"/.test(line) && /["']\s*:\s*["'^~]/.test(line)) {
        alerts.push({
          kind: 'new-dependency',
          file,
          line: redactPreview(line),
          detail:
            'Dependency added/changed — advisory check (OSV) recommended.',
        });
      }
    }
  }
  return alerts;
}

/* ------------------------------------------------------- advisory (OSV stub) */

export interface AdvisoryResult {
  dependency: string;
  version: string;
  /** 'clean' | 'vulnerable' | 'skipped' (no offline DB available). */
  status: 'clean' | 'vulnerable' | 'skipped';
  advisories: string[];
}

/**
 * Offline-first OSV advisory check. Without a cached DB this reports
 * `skipped` per dependency so the pipeline stays honest about coverage.
 * Pass `db` (map of "name@version" → advisory ids) when a cache exists.
 */
export function checkAdvisories(
  deps: Array<{ name: string; version: string }>,
  db?: Map<string, string[]>
): AdvisoryResult[] {
  return deps.map((d) => {
    if (!db) {
      return { dependency: d.name, version: d.version, status: 'skipped', advisories: [] };
    }
    const key = `${d.name}@${d.version}`;
    const advisories = db.get(key) ?? [];
    return {
      dependency: d.name,
      version: d.version,
      status: advisories.length > 0 ? 'vulnerable' : 'clean',
      advisories,
    };
  });
}

/* ------------------------------------------------------------- step runner */

export interface SecurityScanReport {
  secrets: SecretHit[];
  diffAlerts: DiffAlert[];
  advisories: AdvisoryResult[];
  /** True when nothing blocking was found. */
  passed: boolean;
}

/**
 * Run the full pre-commit security step. `failOn` controls which findings
 * fail the gate: secrets always fail; diff alerts are advisory by default.
 */
export function runSecurityScan(opts: {
  /** Map of file path → full new content (staged files). */
  stagedFiles?: Map<string, string>;
  /** Unified diff of the change under review. */
  diff?: string;
  /** Dependencies being added with versions. */
  newDeps?: Array<{ name: string; version: string }>;
  /** Cached OSV DB (optional). */
  osvDb?: Map<string, string[]>;
  /** Treat diff alerts as failures too. Default false (advisory). */
  failOnDiffAlerts?: boolean;
}): SecurityScanReport {
  const secrets: SecretHit[] = [];
  for (const [file, content] of opts.stagedFiles ?? []) {
    secrets.push(...scanSecrets(content, file));
  }
  const diffAlerts = opts.diff ? scanDiff(opts.diff) : [];
  const advisories = checkAdvisories(opts.newDeps ?? [], opts.osvDb);
  const failed =
    secrets.length > 0 ||
    advisories.some((a) => a.status === 'vulnerable') ||
    (opts.failOnDiffAlerts === true && diffAlerts.length > 0);
  return { secrets, diffAlerts, advisories, passed: !failed };
}
