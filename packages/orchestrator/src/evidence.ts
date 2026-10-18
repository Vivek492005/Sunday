// @sunday/orchestrator — evidence.ts: F9 Evidence Pack + Risk-ranked Review.
//
// Every agent task ends with an Evidence Pack: a unified, per-change record of
// what the user asked, what changed, what ran, and what was NOT verified.
// Risk scoring is heuristic-first (path globs, keywords, size); an LLM second
// pass can be layered on later via `classifyIntentRelation` injection.
//
// Spec: docs Sunday___Competitor_Feedback_Research___Feature_Roadmap.md (F9).

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

export const riskTierSchema = z.enum(['low', 'medium', 'high', 'critical']);
export type RiskTier = z.infer<typeof riskTierSchema>;

export const intentRelationSchema = z.enum(['related', 'tangential', 'unrelated']);
export type IntentRelation = z.infer<typeof intentRelationSchema>;

export const evidenceHunkSchema = z.object({
  /** Repo-relative file path (b/ side). */
  file: z.string(),
  /** 1-based start line on the new side. */
  startLine: z.number(),
  /** New-side line count covered by the hunk. */
  lineCount: z.number(),
  addedLines: z.number(),
  removedLines: z.number(),
  /** Raw hunk body (the @@ block incl. +/- lines). */
  body: z.string(),
  /** True when every changed line is whitespace-only. */
  formattingOnly: z.boolean(),
  /** True for brand-new files. */
  isNewFile: z.boolean(),
  /** True for deleted files. */
  isDeletedFile: z.boolean(),
});
export type EvidenceHunk = z.infer<typeof evidenceHunkSchema>;

export const rankedHunkSchema = evidenceHunkSchema.extend({
  riskScore: z.number().min(0).max(100),
  riskTier: riskTierSchema,
  /** Human-readable reasons, e.g. "touches auth code", "dependency manifest". */
  riskReasons: z.array(z.string()),
  intentRelation: intentRelationSchema,
  /** One-line "kyun badla" — filled by the agent; heuristic default otherwise. */
  whyChanged: z.string(),
  /** Suggested default in review UI: unrelated hunks start unchecked. */
  defaultChecked: z.boolean(),
});
export type RankedHunk = z.infer<typeof rankedHunkSchema>;

export const checkRunSchema = z.object({
  kind: z.enum(['test', 'lint', 'typecheck', 'build']),
  command: z.string(),
  runner: z.string(),
  passed: z.boolean(),
  failedCount: z.number().default(0),
  passedCount: z.number().default(0),
  skippedCount: z.number().default(0),
  durationMs: z.number(),
  /** Coverage % if the runner reported one; delta needs a baseline (see below). */
  coveragePct: z.number().nullable(),
  coverageDeltaPct: z.number().nullable(),
  outputTail: z.string().max(4000),
});
export type CheckRun = z.infer<typeof checkRunSchema>;

export const visualProofSchema = z.object({
  kind: z.enum(['screenshot', 'walkthrough', 'none']),
  paths: z.array(z.string()),
});
export type VisualProof = z.infer<typeof visualProofSchema>;

export const evidencePackSchema = z.object({
  version: z.literal(1),
  taskId: z.string(),
  /** The user's original goal / intent, verbatim-ish. */
  goal: z.string(),
  generatedAt: z.string(),
  hunks: z.array(rankedHunkSchema),
  riskSummary: z.object({
    critical: z.number(),
    high: z.number(),
    medium: z.number(),
    low: z.number(),
  }),
  /** Files/hunks the heuristic judged unrelated to the goal. */
  unrelatedFiles: z.array(z.string()),
  checkRuns: z.array(checkRunSchema),
  /** What the agent explicitly did NOT verify. Never empty by accident. */
  unknowns: z.array(z.string()),
  visualProof: visualProofSchema,
  verdict: z.enum(['pass', 'pass-with-warnings', 'needs-review']),
  verdictReasons: z.array(z.string()),
});
export type EvidencePack = z.infer<typeof evidencePackSchema>;

/* ------------------------------------------------------------------ */
/* Unified-diff parsing                                                */
/* ------------------------------------------------------------------ */

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse `git diff` (unified) output into per-file hunks.
 * Tolerates new/deleted files, renames (uses b/ side), and binary markers.
 */
export function parseDiff(diffText: string): EvidenceHunk[] {
  const hunks: EvidenceHunk[] = [];
  const lines = diffText.split('\n');
  let file = '';
  let isNewFile = false;
  let isDeletedFile = false;
  let cur: {
    startLine: number;
    lineCount: number;
    body: string[];
    added: number;
    removed: number;
  } | null = null;

  const flush = () => {
    if (!cur || !file) {
      cur = null;
      return;
    }
    const body = cur.body.join('\n');
    hunks.push({
      file,
      startLine: cur.startLine,
      lineCount: cur.lineCount,
      addedLines: cur.added,
      removedLines: cur.removed,
      body,
      formattingOnly: isFormattingOnly(cur.body),
      isNewFile,
      isDeletedFile,
    });
    cur = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      const m = /^diff --git a\/(.+?) b\/(.+?)$/.exec(line);
      file = m ? m[2] : '';
      isNewFile = false;
      isDeletedFile = false;
      continue;
    }
    if (line.startsWith('new file mode')) {
      isNewFile = true;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      isDeletedFile = true;
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      // Binary: record a zero-line hunk so the file still shows up as risky-ish.
      flush();
      hunks.push({
        file,
        startLine: 0,
        lineCount: 0,
        addedLines: 0,
        removedLines: 0,
        body: line,
        formattingOnly: false,
        isNewFile,
        isDeletedFile,
      });
      continue;
    }
    const hm = HUNK_HEADER.exec(line);
    if (hm) {
      flush();
      cur = {
        startLine: Number(hm[2]),
        lineCount: hm[3] === undefined ? 1 : Number(hm[3]),
        body: [line],
        added: 0,
        removed: 0,
      };
      continue;
    }
    if (cur) {
      cur.body.push(line);
      if (line.startsWith('+') && !line.startsWith('+++')) cur.added += 1;
      else if (line.startsWith('-') && !line.startsWith('---')) cur.removed += 1;
    }
  }
  flush();
  return hunks;
}

/** True when the change is whitespace-only (normalized +/- lines are identical). */
function isFormattingOnly(bodyLines: string[]): boolean {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of bodyLines) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) added.push(line.slice(1).replace(/\s+/g, ''));
    else if (line.startsWith('-')) removed.push(line.slice(1).replace(/\s+/g, ''));
  }
  if (added.length === 0 && removed.length === 0) return false;
  return added.sort().join('\n') === removed.sort().join('\n');
}

/* ------------------------------------------------------------------ */
/* Risk scoring (heuristic rules)                                      */
/* ------------------------------------------------------------------ */

interface RiskRule {
  name: string;
  score: number;
  /** Path-based rules are skipped for test files (path reputation ≠ test risk). */
  pathBased: boolean;
  test: (hunk: EvidenceHunk) => boolean;
}

const AUTH_PATH_RE = /(^|\/)(auth|login|session|token|credential|secret|oauth|mfa|2fa|rbac)(s)?(\/|$|\.)/i;
const AUTH_BODY_RE = /(auth|login|logout|session|token|credential|secret|passwd|oauth|permission)/i;
const CRYPTO_PATH_RE = /(^|\/)(crypto|tls|ssl|jwt|keys?)(s)?(\/|$|\.)/i;
const CRYPTO_BODY_RE = /(crypto|bcrypt|scrypt|argon2|encrypt|decrypt|cipher|jwt|jwk|private[ _-]?key|hmac|sign(ature)?)/i;
const MIGRATION_RE = /(migrations?\/|\.sql$|schema\.prisma$|alembic|knex|typeorm)/i;
const DEPS_RE =
  /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|requirements(\.|-).+\.txt|requirements\.txt|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pyproject\.toml|poetry\.lock|Gemfile(\.lock)?)$/i;
const CONFIG_RE =
  /(\.config\.(js|ts|cjs|mjs|json)$|\.env(\.|$)|\.?eslintrc|Dockerfile|docker-compose.*\.ya?ml$|\.github\/workflows\/|^\.?gitlab-ci\.ya?ml$|terraform\/|\.tf$)/i;
const API_RE = /(^|\/)(api|routes|controllers|handlers|public|sdk|client)(\/|$)/i;
const TEST_RE = /(\.test\.|\.spec\.|__tests__|\/tests?\/)/i;
const DANGEROUS_CALL_RE =
  /\b(eval|exec|execSync|spawn|spawnSync|execFile|fork|child_process|vm\.run|Function\(|innerHTML|dangerouslySetInnerHTML|document\.write|shell_exec|passthru|os\.system|subprocess\.(call|run|Popen))\b/;

const RISK_RULES: RiskRule[] = [
  // --- path reputation (skipped for test-only files) ---
  { name: 'touches auth/session/secret code', score: 60, pathBased: true, test: (h) => AUTH_PATH_RE.test(h.file) },
  { name: 'touches crypto/signing code', score: 60, pathBased: true, test: (h) => CRYPTO_PATH_RE.test(h.file) },
  { name: 'database migration / schema change', score: 45, pathBased: true, test: (h) => MIGRATION_RE.test(h.file) },
  { name: 'dependency manifest change', score: 40, pathBased: true, test: (h) => DEPS_RE.test(h.file) },
  { name: 'config / CI / infra change', score: 35, pathBased: true, test: (h) => CONFIG_RE.test(h.file) },
  { name: 'public API / routes surface', score: 35, pathBased: true, test: (h) => API_RE.test(h.file) },
  // --- body signals (apply everywhere, incl. tests) ---
  { name: 'auth-related keywords in change', score: 30, pathBased: false, test: (h) => AUTH_BODY_RE.test(addedText(h)) },
  { name: 'crypto-related keywords in change', score: 30, pathBased: false, test: (h) => CRYPTO_BODY_RE.test(addedText(h)) },
  {
    name: 'dangerous sink (exec/eval/shell)',
    score: 45,
    pathBased: false,
    test: (h) => DANGEROUS_CALL_RE.test(addedText(h)),
  },
  {
    name: 'large diff (hard to review)',
    score: 15,
    pathBased: false,
    test: (h) => h.addedLines + h.removedLines > 200,
  },
  {
    name: 'very large diff',
    score: 10,
    pathBased: false,
    test: (h) => h.addedLines + h.removedLines > 500,
  },
  {
    name: 'deletion-heavy change',
    score: 10,
    pathBased: false,
    test: (h) => h.removedLines > 30 && h.removedLines > h.addedLines * 3,
  },
];

function addedText(hunk: EvidenceHunk): string {
  return hunk.body
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .join('\n');
}

export function scoreToTier(score: number): RiskTier {
  if (score >= 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 35) return 'medium';
  return 'low';
}

export interface RiskScore {
  score: number;
  tier: RiskTier;
  reasons: string[];
}

/** Heuristic risk score for one hunk. Test-only and formatting-only hunks are capped at low. */
export function scoreHunk(hunk: EvidenceHunk): RiskScore {
  const reasons: string[] = [];
  let score = 0;
  const isTestOnly = TEST_RE.test(hunk.file);
  for (const rule of RISK_RULES) {
    // A test file living under an auth/ directory isn't auth code — only its
    // body signals (dangerous sinks, crypto keywords) count.
    if (isTestOnly && rule.pathBased) continue;
    if (rule.test(hunk)) {
      score += rule.score;
      reasons.push(rule.name);
    }
  }
  score = Math.min(100, score);

  if (hunk.formattingOnly) {
    return { score: 5, tier: 'low', reasons: ['formatting-only change'] };
  }
  if (isTestOnly) {
    return {
      score,
      tier: score >= 60 ? 'high' : score >= 35 ? 'medium' : 'low',
      reasons: reasons.length ? reasons : ['test-only change'],
    };
  }
  return { score, tier: scoreToTier(score), reasons: reasons.length ? reasons : ['routine change'] };
}

/** Sort hunks riskiest-first (stable: ties keep diff order). */
export function rankHunks(hunks: EvidenceHunk[]): EvidenceHunk[] {
  return hunks
    .map((h, i) => ({ h, i, s: scoreHunk(h).score }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.h);
}

/* ------------------------------------------------------------------ */
/* Intent ↔ change check (heuristic v1; LLM second pass optional)     */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set(
  'the,a,an,and,or,but,for,with,from,that,this,these,those,into,over,under,when,then,than,also,just,will,should,could,would,have,has,had,are,was,were,been,being,its,it,to,of,in,on,at,by,as,is,be,do,does,did,not,no,yes,if,else,while,each,every,all,any,some,more,most,add,new,make,made,using,use,used,file,files,code,please,need,needs,want'.split(
    ',',
  ),
);

function keywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (tok.length >= 4 && !STOPWORDS.has(tok)) out.add(tok);
  }
  return out;
}

/** Tokens from the file path: dir names + basename without extension. */
function fileKeywords(file: string): Set<string> {
  const parts = file.toLowerCase().split(/[\/\\._-]+/).filter((p) => p.length >= 3);
  return new Set(parts);
}

export interface IntentClassification {
  relation: IntentRelation;
  /** Shared keyword evidence, for the review UI. */
  evidence: string[];
}

/**
 * Heuristic v1 of (user prompt, hunk) → related|tangential|unrelated.
 * A cheap-model second pass can override this later; the signature is
 * injectable so callers can plug one in (see collectEvidencePack options).
 */
export function classifyIntentRelation(goal: string, hunk: EvidenceHunk): IntentClassification {
  const goalKw = keywords(goal);
  const hunkKw = keywords(addedText(hunk));
  const pathKw = fileKeywords(hunk.file);
  const evidence: string[] = [];

  for (const k of goalKw) {
    if (hunkKw.has(k) || pathKw.has(k)) evidence.push(k);
  }
  // Direct file mention in the goal is strong evidence of relatedness.
  const base = basename(hunk.file).toLowerCase();
  const goalLower = goal.toLowerCase();
  const mentioned = base.length >= 4 && goalLower.includes(base);

  if (mentioned || evidence.length >= 2) return { relation: 'related', evidence };
  if (evidence.length === 1) return { relation: 'tangential', evidence };
  return { relation: 'unrelated', evidence };
}

/* ------------------------------------------------------------------ */
/* Test / lint / typecheck runner adapters (auto-detect)               */
/* ------------------------------------------------------------------ */

export interface DetectedCheck {
  kind: 'test' | 'lint' | 'typecheck' | 'build';
  command: string;
  runner: string;
}

/** Auto-detect available checks from the workspace layout (no execution). */
export function detectChecks(workspaceRoot: string): DetectedCheck[] {
  const checks: DetectedCheck[] = [];
  const pkgPath = join(workspaceRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        scripts?: Record<string, string>;
        devDependencies?: Record<string, string>;
        dependencies?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (scripts.test) {
        const runner = allDeps['vitest'] ? 'vitest' : allDeps['jest'] ? 'jest' : 'npm test';
        checks.push({ kind: 'test', command: scripts.test, runner });
      }
      if (scripts.lint) checks.push({ kind: 'lint', command: scripts.lint, runner: 'eslint' });
      if (scripts.typecheck) checks.push({ kind: 'typecheck', command: scripts.typecheck, runner: 'tsc' });
      else if (allDeps['typescript']) checks.push({ kind: 'typecheck', command: 'npx tsc --noEmit', runner: 'tsc' });
      if (scripts.build) checks.push({ kind: 'build', command: scripts.build, runner: 'build' });
    } catch {
      /* malformed package.json — ignore */
    }
  }
  if (existsSync(join(workspaceRoot, 'pytest.ini')) || existsSync(join(workspaceRoot, 'pyproject.toml'))) {
    checks.push({ kind: 'test', command: 'pytest -q', runner: 'pytest' });
  }
  if (existsSync(join(workspaceRoot, 'go.mod'))) {
    checks.push({ kind: 'test', command: 'go test ./...', runner: 'go test' });
  }
  if (existsSync(join(workspaceRoot, 'pom.xml'))) {
    checks.push({ kind: 'test', command: 'mvn -q test', runner: 'maven' });
  }
  return checks;
}

function parseCounts(runner: string, output: string): { passed: number; failed: number; skipped: number } {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const pick = (re: RegExp): number => {
    const m = re.exec(output);
    return m ? Number(m[1]) : 0;
  };
  if (runner === 'vitest' || runner === 'jest' || runner === 'npm test') {
    // "Tests: 12 passed, 3 failed, 1 skipped" (jest) or "Tests  12 passed | 3 failed" (vitest)
    passed = pick(/(\d+)\s+passed/);
    failed = pick(/(\d+)\s+failed/);
    skipped = pick(/(\d+)\s+skipped/);
  } else if (runner === 'pytest') {
    // "12 passed, 3 failed, 1 skipped in 4.2s"
    passed = pick(/(\d+)\s+passed/);
    failed = pick(/(\d+)\s+failed/);
    skipped = pick(/(\d+)\s+skipped/);
  } else if (runner === 'go test') {
    passed = (output.match(/^ok\s+/gm) ?? []).length;
    failed = (output.match(/^FAIL\s+/gm) ?? []).length;
  } else if (runner === 'maven') {
    // "Tests run: 12, Failures: 3, Errors: 0, Skipped: 1"
    const m = /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/.exec(output);
    if (m) {
      failed = Number(m[2]) + Number(m[3]);
      skipped = Number(m[4]);
      passed = Number(m[1]) - failed - skipped;
    }
  }
  return { passed, failed, skipped };
}

function parseCoverage(runner: string, output: string): number | null {
  // jest: "All files | 87.5 | ..." ; pytest-cov: "TOTAL ... 87%"; vitest: similar table
  const m =
    /All files\s*\|\s*([\d.]+)/.exec(output) ??
    /TOTAL\s+\d+\s+\d+\s+([\d.]+)%/.exec(output) ??
    /coverage:\s*([\d.]+)%/i.exec(output);
  return m ? Number(m[1]) : null;
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ code: number; output: string; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const isWin = process.platform === 'win32';
    const child = execFile(isWin ? 'cmd.exe' : 'sh', isWin ? ['/c', command] : ['-c', command], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    let output = '';
    child.stdout?.on('data', (d) => {
      output += String(d);
    });
    child.stderr?.on('data', (d) => {
      output += String(d);
    });
    child.on('close', (code) => resolve({ code: code ?? 1, output, ms: Date.now() - started }));
    child.on('error', () => resolve({ code: 1, output: output || 'spawn failed', ms: Date.now() - started }));
  });
}

/**
 * Execute one detected check and normalize the result.
 * `baselineCoveragePct` enables the coverage-delta field; without it the
 * delta stays null (we report what ran, honestly).
 */
export async function runCheck(
  check: DetectedCheck,
  workspaceRoot: string,
  opts: { timeoutMs?: number; baselineCoveragePct?: number | null } = {},
): Promise<CheckRun> {
  const { code, output, ms } = await runShell(check.command, workspaceRoot, opts.timeoutMs ?? 300_000);
  const counts = parseCounts(check.runner, output);
  const coveragePct = parseCoverage(check.runner, output);
  const tail = output.split('\n').slice(-40).join('\n').slice(0, 4000);
  return {
    kind: check.kind,
    command: check.command,
    runner: check.runner,
    passed: code === 0,
    failedCount: counts.failed,
    passedCount: counts.passed,
    skippedCount: counts.skipped,
    durationMs: ms,
    coveragePct,
    coverageDeltaPct:
      coveragePct !== null && opts.baselineCoveragePct != null
        ? Math.round((coveragePct - opts.baselineCoveragePct) * 10) / 10
        : null,
    outputTail: tail,
  };
}

/* ------------------------------------------------------------------ */
/* Evidence Pack collector                                             */
/* ------------------------------------------------------------------ */

export interface CollectEvidenceOptions {
  taskId: string;
  /** The user's original goal / intent. */
  goal: string;
  /** Unified diff text (e.g. `git diff` of the task's changes). */
  diffText: string;
  workspaceRoot: string;
  /** Things the agent explicitly did NOT verify — always recorded. */
  unknowns?: string[];
  visualProof?: VisualProof;
  /** Per-hunk "kyun badla" notes from the agent, keyed by `${file}:${startLine}`. */
  whyChanged?: Record<string, string>;
  /** Skip executing checks (pure/static mode — for tests and dry runs). */
  skipExecution?: boolean;
  /** Only run these check kinds when executing (e.g. ['test']). */
  onlyKinds?: Array<CheckRun['kind']>;
  /** Baseline coverage % for the delta field. */
  baselineCoveragePct?: number | null;
  /** Optional cheap-model override for intent classification. */
  intentClassifier?: (goal: string, hunk: EvidenceHunk) => IntentClassification | Promise<IntentClassification>;
}

/**
 * Build a complete Evidence Pack for one finished agent task.
 * Never throws on bad diff input — worst case is an empty-hunk pack with
 * an "unknown" noting the diff could not be parsed.
 */
export async function collectEvidencePack(opts: CollectEvidenceOptions): Promise<EvidencePack> {
  const unknowns = [...(opts.unknowns ?? [])];
  let hunks: EvidenceHunk[] = [];
  try {
    hunks = parseDiff(opts.diffText);
  } catch (err) {
    unknowns.push(`diff could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (opts.diffText.trim() && hunks.length === 0) {
    unknowns.push('no hunks extracted from diff text — diff format may be unsupported');
  }

  const ranked: RankedHunk[] = [];
  for (const hunk of hunks) {
    const risk = scoreHunk(hunk);
    const intent = opts.intentClassifier
      ? await opts.intentClassifier(opts.goal, hunk)
      : classifyIntentRelation(opts.goal, hunk);
    const key = `${hunk.file}:${hunk.startLine}`;
    ranked.push({
      ...hunk,
      riskScore: risk.score,
      riskTier: risk.tier,
      riskReasons: risk.reasons,
      intentRelation: intent.relation,
      whyChanged:
        opts.whyChanged?.[key] ??
        (intent.relation === 'unrelated'
          ? 'no link to stated goal found — review before accepting'
          : `${intent.relation} to goal${intent.evidence.length ? ` (matched: ${intent.evidence.slice(0, 5).join(', ')})` : ''}`),
      // Unrelated hunks start unchecked in the review UI (F9 strategy §4).
      defaultChecked: intent.relation !== 'unrelated',
    });
  }
  ranked.sort((a, b) => b.riskScore - a.riskScore);

  const riskSummary = {
    critical: ranked.filter((h) => h.riskTier === 'critical').length,
    high: ranked.filter((h) => h.riskTier === 'high').length,
    medium: ranked.filter((h) => h.riskTier === 'medium').length,
    low: ranked.filter((h) => h.riskTier === 'low').length,
  };
  const unrelatedFiles = [...new Set(ranked.filter((h) => h.intentRelation === 'unrelated').map((h) => h.file))];

  // What ran.
  const checkRuns: CheckRun[] = [];
  if (!opts.skipExecution) {
    const detected = detectChecks(opts.workspaceRoot).filter(
      (c) => !opts.onlyKinds || opts.onlyKinds.includes(c.kind),
    );
    if (detected.length === 0) {
      unknowns.push('no test/lint/typecheck commands detected in workspace — nothing was executed');
    }
    for (const check of detected) {
      try {
        checkRuns.push(await runCheck(check, opts.workspaceRoot, { baselineCoveragePct: opts.baselineCoveragePct }));
      } catch (err) {
        unknowns.push(
          `check '${check.command}' could not run: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } else {
    unknowns.push('check execution skipped (static mode) — tests/lint/typecheck were not run');
  }

  // Verdict.
  const reasons: string[] = [];
  let verdict: EvidencePack['verdict'] = 'pass';
  const riskyHunks = riskSummary.critical + riskSummary.high;
  const anyTestPassed = checkRuns.some((r) => r.kind === 'test' && r.passed && r.failedCount === 0);
  if (riskyHunks > 0 && !anyTestPassed) {
    verdict = 'needs-review';
    reasons.push(
      `${riskyHunks} critical/high-risk hunk(s) with no passing test run — human review required before ship`,
    );
  }
  if (unrelatedFiles.length > 0) {
    if (verdict === 'pass') verdict = 'pass-with-warnings';
    reasons.push(`${unrelatedFiles.length} file(s) look unrelated to the stated goal and start unchecked in review`);
  }
  if (riskSummary.medium > 0 && verdict === 'pass') {
    verdict = 'pass-with-warnings';
    reasons.push(`${riskSummary.medium} medium-risk hunk(s) — skim before accepting`);
  }
  if (verdict === 'pass') reasons.push('no blockers: low-risk changes, checks green');

  const pack = {
    version: 1 as const,
    taskId: opts.taskId,
    goal: opts.goal,
    generatedAt: new Date().toISOString(),
    hunks: ranked,
    riskSummary,
    unrelatedFiles,
    checkRuns,
    unknowns,
    visualProof: opts.visualProof ?? { kind: 'none' as const, paths: [] },
    verdict,
    verdictReasons: reasons,
  };
  return evidencePackSchema.parse(pack);
}

/** One-line markdown summary of a pack, for PR descriptions / chat. */
export function summarizeEvidencePack(pack: EvidencePack): string {
  const lines: string[] = [
    `## Evidence Pack — ${pack.verdict}`,
    '',
    `**Goal:** ${pack.goal}`,
    `**Hunks:** ${pack.hunks.length} (critical ${pack.riskSummary.critical}, high ${pack.riskSummary.high}, medium ${pack.riskSummary.medium}, low ${pack.riskSummary.low})`,
  ];
  if (pack.hunks.length > 0) {
    lines.push('', '### Risk-ranked changes', '');
    for (const h of pack.hunks.slice(0, 10)) {
      const flag = h.intentRelation === 'unrelated' ? ' ⚠️ unrelated' : '';
      lines.push(
        `- [${h.riskTier.toUpperCase()} ${h.riskScore}] \`${h.file}:${h.startLine}\` — ${h.whyChanged}${flag}`,
      );
    }
    if (pack.hunks.length > 10) lines.push(`- …and ${pack.hunks.length - 10} more`);
  }
  if (pack.checkRuns.length > 0) {
    lines.push('', '### What ran', '');
    for (const r of pack.checkRuns) {
      const icon = r.passed ? '✅' : '❌';
      const cov = r.coverageDeltaPct !== null && r.coverageDeltaPct !== undefined ? ` (coverage Δ ${r.coverageDeltaPct > 0 ? '+' : ''}${r.coverageDeltaPct}%)` : '';
      lines.push(`- ${icon} \`${r.command}\` — ${r.passedCount} passed, ${r.failedCount} failed${cov}`);
    }
  }
  if (pack.unknowns.length > 0) {
    lines.push('', '### Not verified', '');
    for (const u of pack.unknowns) lines.push(`- ${u}`);
  }
  return lines.join('\n');
}
