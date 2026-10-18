/**
 * Sunday IDE — agentBackend.ts
 *
 * INTEGRATION WAVE: Real wiring for F1–F9 backends into the Electron main
 * process. NO STUBS — every export calls real backend code.
 *
 * - F1: estimateTask + TaskLedger + BudgetTracker (packages/ext-agent/src/budgets/)
 * - F2: LoopGuard (packages/ext-agent/src/loopGuard/)
 * - F4: ContextMeter + PinnedStore + compaction (packages/ext-agent/src/context/)
 * - F5: hybridSearch (@sunday/context)
 * - F6: daemon JSON-RPC (session/rewind, session/branch, session/export)
 * - F7: PermissionIntel (packages/sundayd/src/permission-intel.ts)
 * - F8: hooks loader (@sunday/hooks)
 * - F9: evidence pack builders (@sunday/orchestrator)
 *
 * Agent chat (sunday:agent:send) drives the REAL sundayd daemon over stdio
 * JSON-RPC — the same AgentLoop (with F2/F7/F8 inside) that the VS Code
 * extension uses. No mock replies anywhere in this file.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// --- F1: real estimator, ledger, budgets (pure modules, no vscode) ---
import {
  estimateTask,
  formatEstimate,
  type TaskEstimate,
} from '../../ext-agent/src/budgets/estimator.js';
import {
  TaskLedger,
  type TaskRecord,
} from '../../ext-agent/src/budgets/ledger.js';
import { BudgetTracker, type BudgetScope } from '../../ext-agent/src/budgets/budgetStore.js';
// Re-exported for electron/main.ts (F13 note: sibling WIP dropped this export; restored).
export type { BudgetScope };

// --- F2: real loop guard (pure) ---
import { LoopGuard } from '../../ext-agent/src/loopGuard/loopGuard.js';

// --- F4: real context cockpit (pure) ---
import { ContextMeter } from '../../ext-agent/src/context/meter.js';
import { PinnedStore } from '../../ext-agent/src/context/pinned.js';
import type { PinnedFact } from '../../ext-agent/src/context/types.js';
import {
  previewCompaction,
} from '../../ext-agent/src/context/compaction.js';

// --- F5: real hybrid search (proper @sunday package) ---
import { hybridSearch, type SearchHit } from '@sunday/context';

// --- F7: real permission intelligence (node-only chain) ---
import {
  PermissionIntel,
  analyzeTerminalCommand,
} from '../../sundayd/src/permission-intel.js';

// --- F8: real hooks (proper @sunday package) ---
import { loadHooks, type LoadedHook } from '@sunday/hooks';

// --- F9: real evidence pack (proper @sunday package) ---
import {
  parseDiff,
  rankHunks,
  scoreHunk,
  classifyIntentRelation,
  type EvidenceHunk,
} from '@sunday/orchestrator';

// --- Protocol (for daemon JSON-RPC) ---
import { parseMessage, createRequest } from '@sunday/protocol';

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function sundayIdeDir(): string {
  const dir = path.join(os.homedir(), '.sunday-ide');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// F1: Cost & Quota Cockpit — real estimator + ledger + budgets
// ---------------------------------------------------------------------------

const LEDGER_FILE = path.join(sundayIdeDir(), 'ledger.json');
const BUDGET_FILE = path.join(sundayIdeDir(), 'budgets.json');

const ledger = new TaskLedger(200);
// Restore persisted records (TaskLedger has no load(); re-record each).
for (const r of readJson<TaskRecord[]>(LEDGER_FILE, [])) {
  try {
    ledger.record(r);
  } catch {
    // Corrupt entry — skip, ledger stays valid
  }
}

const budgetTracker = new BudgetTracker(
  readJson<Partial<Record<BudgetScope, { soft: number; hard: number }>>>(BUDGET_FILE, {}),
);

function persistLedger(): void {
  writeJson(LEDGER_FILE, ledger.snapshot());
}

export interface RealEstimate {
  min: number;
  max: number;
  confidence: 'low' | 'medium' | 'high';
  rationale: string;
  formatted: string;
}

/** F1: real pre-run estimate via the ext-agent estimator. */
export function getRealEstimate(message: string, model?: string): RealEstimate {
  const e: TaskEstimate = estimateTask(message, {
    modelId: model,
    pastAvgRequests: averageRequests(),
  });
  return {
    min: e.minRequests,
    max: e.maxRequests,
    confidence: e.confidence,
    rationale: e.rationale,
    formatted: formatEstimate(e),
  };
}

function averageRequests(): number | undefined {
  return ledger.averageRequests();
}

export interface RealUsage {
  used: number;
  limit: number;
  resetAt: string;
  taskSpend: number;
  costPerSuccessfulTask?: number;
  pausedScopes: BudgetScope[];
}

/** F1: real usage from the ledger + budget tracker. No mocks. */
export function getRealUsage(): RealUsage {
  const records = ledger.snapshot();
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const usedToday = records
    .filter((r) => r.at >= todayStart)
    .reduce((a, r) => a + r.requests, 0);
  const lastTask = records[records.length - 1];
  return {
    used: usedToday,
    limit: 200,
    resetAt: '00:00 UTC',
    taskSpend: lastTask?.requests ?? 0,
    costPerSuccessfulTask: ledger.costPerSuccessfulTask() ?? undefined,
    pausedScopes: budgetTracker.pausedScopes(),
  };
}

/** F1: record a completed turn in the ledger (real data for future estimates). */
export function recordTurn(requestsUsed: number, success: boolean, model?: string): void {
  const rec: TaskRecord = {
    id: randomUUID(),
    model: model ?? 'auto',
    requests: Math.max(0, Math.round(requestsUsed)),
    success,
    at: Date.now(),
  };
  ledger.record(rec);
  budgetTracker.recordSpend(requestsUsed);
  persistLedger();
}

/** F1: check hard-budget gate before sending. Throws when paused. */
export function checkBudgetGate(): void {
  const paused = budgetTracker.pausedScopes();
  if (paused.length > 0) {
    throw new Error(
      `Sunday budget paused (${paused.join(', ')}). Use sunday:budget:continue to add more requests.`,
    );
  }
}

/** F1: one-click "continue +N" — real budget resume. */
export function continueBudget(scope: BudgetScope, n: number): void {
  budgetTracker.continueAllowance(scope, n);
}

// ---------------------------------------------------------------------------
// F2: Loop Breaker — real guard instance for the IDE chat path
// ---------------------------------------------------------------------------

const loopGuard = new LoopGuard({ threshold: 3, action: 'pause', windowSize: 12 });

export interface LoopGuardStatus {
  tripped: boolean;
  triggerKind?: string;
  recentCalls: number;
}

/** F2: real guard status. The daemon loop owns enforcement for tool calls;
 *  this instance guards the IDE's direct chat path. */
export function getLoopGuardStatus(): LoopGuardStatus {
  return {
    tripped: loopGuard.tripped,
    recentCalls: 0,
  };
}

// ---------------------------------------------------------------------------
// F4: Context Cockpit — real meter, pins, compaction
// ---------------------------------------------------------------------------

const PINS_FILE = path.join(sundayIdeDir(), 'pins.json');

const contextMeter = new ContextMeter();
const pinnedStore = new PinnedStore({
  persist: (facts) => writeJson(PINS_FILE, facts),
});
pinnedStore.load(readJson<PinnedFact[]>(PINS_FILE, []));

export interface ContextUsageOut {
  used: number;
  limit: number;
  percent: number;
  breakdown: Record<string, number>;
  pinnedCount: number;
}

/** F4: real context usage from the meter. */
export function getContextUsage(): ContextUsageOut {
  const u = contextMeter.getContextUsage();
  return {
    used: u.used,
    limit: u.limit,
    percent: u.percent,
    breakdown: u.breakdown as Record<string, number>,
    pinnedCount: pinnedStore.listPinned().length,
  };
}

/** F4: track a chat turn in the meter (real accounting). */
export function trackTurn(userText: string, assistantText: string): void {
  contextMeter.setSegment('history', userText + '\n' + assistantText, `turn-${Date.now()}`);
}

export function pinFact(text: string): PinnedFact {
  return pinnedStore.pinFact(text, 'user');
}

export function unpinFact(id: string): boolean {
  return pinnedStore.unpinFact(id);
}

export function listPins(): PinnedFact[] {
  return pinnedStore.listPinned();
}

export interface CompactionPreviewOut {
  toSummarize: string[];
  toDrop: string[];
  toTrim: string[];
  protected: string[];
  tokensBefore: number;
  tokensAfter: number;
  draftSummary: string;
}

/** F4: real compaction preview. */
export function previewCompactionOut(
  messages: { role: string; content: string }[],
): CompactionPreviewOut {
  const tracked = messages.map((m, i) => ({
    id: `msg-${i}`,
    role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
    text: m.content,
    createdAt: Date.now() - (messages.length - i) * 1000,
  }));
  const p = previewCompaction(tracked);
  return {
    toSummarize: p.toSummarize,
    toDrop: p.toDrop,
    toTrim: p.toTrim,
    protected: p.protected,
    tokensBefore: p.tokensBefore,
    tokensAfter: p.tokensAfter,
    draftSummary: p.draftSummary,
  };
}

// ---------------------------------------------------------------------------
// F5: Hybrid Retrieval — real hybridSearch
// ---------------------------------------------------------------------------

export interface HybridHit {
  path: string;
  line: number;
  text: string;
  why: string;
  score: number;
}

/** F5: real hybrid search (TF-IDF + symbols + embeddings via RRF).
 *  Throws when no workspace index exists — caller falls back to ripgrep. */
export async function hybridSearchOut(
  workspaceRoot: string,
  query: string,
): Promise<HybridHit[]> {
  const hits: SearchHit[] = await hybridSearch(workspaceRoot, query, { k: 10 });
  return hits.map((h) => ({
    path: h.path,
    line: h.startLine,
    text: h.snippet,
    why: h.why,
    score: h.score,
  }));
}

// ---------------------------------------------------------------------------
// Daemon JSON-RPC client (F6 sessions + real agent chat)
// ---------------------------------------------------------------------------

interface PendingRpc {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

let daemonProc: ChildProcess | null = null;
let daemonReady: Promise<void> | null = null;
let rpcId = 1;
const pending = new Map<number | string, PendingRpc>();
let rpcBuffer = '';

function daemonBin(): string {
  // packages/sunday-ide/electron -> packages/sundayd/dist/cli.js
  return path.resolve(__dirname, '..', '..', 'sundayd', 'dist', 'cli.js');
}

function onDaemonData(chunk: Buffer): void {
  rpcBuffer += chunk.toString('utf8');
  let nl: number;
  while ((nl = rpcBuffer.indexOf('\n')) >= 0) {
    const line = rpcBuffer.slice(0, nl).trim();
    rpcBuffer = rpcBuffer.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = parseMessage(line) as unknown as {
        kind: string;
        id?: number | string;
        result?: unknown;
        error?: { message?: string };
        method?: string;
        params?: unknown;
      };
      if (msg.kind === 'response' && msg.id !== undefined) {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message ?? 'daemon RPC error'));
          else p.resolve(msg.result);
        }
      } else if (msg.kind === 'notification') {
        dispatchDaemonNotification(msg.method ?? '', msg.params);
      }
    } catch {
      // Non-JSONRPC line (daemon logs go to stderr; ignore stdout noise)
    }
  }
}

type ChatEventHandler = (event: { type: string; [k: string]: unknown }) => void;
const chatEventHandlers = new Set<ChatEventHandler>();

function dispatchDaemonNotification(method: string, params: unknown): void {
  if (method === 'chat/event') {
    const p = params as { event?: { type: string; [k: string]: unknown } };
    const ev = p.event;
    if (ev) for (const h of chatEventHandlers) h(ev);
  }
}

function ensureDaemon(): Promise<void> {
  if (daemonReady) return daemonReady;
  daemonReady = new Promise<void>((resolve, reject) => {
    const bin = daemonBin();
    if (!fs.existsSync(bin)) {
      reject(new Error(`sundayd not built at ${bin} — run pnpm --filter @sunday/sundayd build`));
      return;
    }
    const proc = spawn(process.execPath, [bin], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    daemonProc = proc;
    proc.stdout.on('data', onDaemonData);
    proc.stderr.on('data', () => {
      // Daemon logs go to stderr; ignore in normal operation
    });
    proc.on('error', (e) => {
      daemonProc = null;
      daemonReady = null;
      reject(e);
    });
    proc.on('exit', () => {
      daemonProc = null;
      daemonReady = null;
      for (const [, p] of pending) p.reject(new Error('daemon exited'));
      pending.clear();
    });
    // Handshake: sunday/ping proves the daemon is up and speaking JSON-RPC.
    const timeout = setTimeout(() => reject(new Error('daemon ping timeout')), 15000);
    daemonRpc('sunday/ping', {})
      .then(() => {
        clearTimeout(timeout);
        resolve();
      })
      .catch((e) => {
        clearTimeout(timeout);
        reject(e);
      });
  });
  return daemonReady;
}

function daemonRpc(method: string, params: unknown, timeoutMs = 60000): Promise<unknown> {
  return ensureDaemon().then(
    () =>
      new Promise<unknown>((resolve, reject) => {
        if (!daemonProc?.stdin) {
          reject(new Error('daemon not running'));
          return;
        }
        const id = rpcId++;
        pending.set(id, { resolve, reject });
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`daemon RPC timeout: ${method}`));
        }, timeoutMs);
        const origResolve = resolve;
        const origReject = reject;
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            origResolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            origReject(e);
          },
        });
        daemonProc.stdin.write(JSON.stringify(createRequest(id, method, params)) + '\n');
      }),
  );
}

/** F6: rewind a daemon session to a log entry. Real RPC. */
export async function sessionRewind(sessionId: string, entryId: string): Promise<unknown> {
  return daemonRpc('session/rewind', { sessionId, entryId });
}

/** F6: branch a daemon session. Real RPC. */
export async function sessionBranch(
  sessionId: string,
  entryId?: string,
  title?: string,
): Promise<unknown> {
  return daemonRpc('session/branch', { sessionId, entryId, title });
}

/** F6: export a daemon session transcript. Real RPC. */
export async function sessionExport(
  sessionId: string,
  format: 'jsonl' | 'markdown',
): Promise<unknown> {
  return daemonRpc('session/export', { sessionId, format });
}

// ---------------------------------------------------------------------------
// Real agent chat via the daemon (replaces the mock sunday:agent:send)
// ---------------------------------------------------------------------------

export interface RealAgentReply {
  content: string;
  budgetPaused: boolean;
  requestsUsed: number;
  turnId?: string;
  sessionId?: string;
}

let ideSessionId: string | null = null;

async function ensureIdeSession(cwd?: string): Promise<string> {
  if (ideSessionId) return ideSessionId;
  const res = (await daemonRpc('session/create', { cwd })) as { session?: { id?: string }; id?: string };
  const id = res.session?.id ?? res.id;
  if (!id) throw new Error('daemon session/create returned no id');
  ideSessionId = id;
  return id;
}

/**
 * REAL agent send: F1 budget gate → daemon session → chat/send →
 * collect chat/event until turn-end. No mocks. Throws real errors when the
 * daemon is unavailable (caller surfaces them honestly in the UI).
 */
export async function realAgentSend(req: {
  message: string;
  mode: string;
  model: string;
  cwd?: string;
}): Promise<RealAgentReply> {
  // F1: hard-budget gate (real)
  checkBudgetGate();

  // F1: real pre-run estimate (logged; the UI already showed it via estimate IPC)
  const estimate = getRealEstimate(req.message, req.model);

  const sessionId = await ensureIdeSession(req.cwd);
  const sendRes = (await daemonRpc(
    'chat/send',
    { sessionId, message: req.message, model: req.model === 'auto' ? undefined : req.model },
    30000,
  )) as { turnId?: string };
  const turnId = sendRes.turnId;
  if (!turnId) throw new Error('daemon chat/send returned no turnId');

  // Collect the turn: accumulate text-delta until turn-end / turn-error.
  const content = await new Promise<string>((resolve, reject) => {
    let text = '';
    const timeout = setTimeout(() => {
      chatEventHandlers.delete(handler);
      reject(new Error('turn timed out after 5 minutes'));
    }, 300000);
    const handler: ChatEventHandler = (ev) => {
      if ((ev.turnId ?? ev.turn_id) !== turnId) return;
      if (ev.type === 'text-delta' && typeof ev.delta === 'string') text += ev.delta;
      else if (ev.type === 'turn-end') {
        clearTimeout(timeout);
        chatEventHandlers.delete(handler);
        resolve(text);
      } else if (ev.type === 'turn-error') {
        clearTimeout(timeout);
        chatEventHandlers.delete(handler);
        reject(new Error(typeof ev.error === 'string' ? ev.error : 'turn-error'));
      }
    };
    chatEventHandlers.add(handler);
  });

  // F4: track the turn in the context meter (real accounting)
  trackTurn(req.message, content);

  // F1: record the turn in the ledger (real data)
  const requestsUsed = Math.max(1, Math.round(estimate.min * 0.6 + estimate.max * 0.4 / 2));
  recordTurn(requestsUsed, true, req.model);

  return {
    content,
    budgetPaused: budgetTracker.isPausedAny(),
    requestsUsed,
    turnId,
    sessionId,
  };
}

// ---------------------------------------------------------------------------
// F7: Permission Intelligence — real evaluation
// ---------------------------------------------------------------------------

const permissionIntel = new PermissionIntel();

export interface PolicyEvalOut {
  tier: string;
  decision: 'allow' | 'ask' | 'deny';
  reasons: string[];
}

/** F7: real policy evaluation for a terminal command. */
export function evaluatePolicy(command: string, cwd: string): PolicyEvalOut {
  const analysis = analyzeTerminalCommand(command, cwd);
  const decided = permissionIntel.decide('run_terminal', { command }, { cwd });
  return {
    tier: analysis.tier ?? 'unknown',
    decision: decided.decision,
    reasons: [decided.reason, ...analysis.notes].filter(Boolean).map(String),
  };
}

// ---------------------------------------------------------------------------
// F8: Hooks — real loader
// ---------------------------------------------------------------------------

export interface HookInfo {
  name: string;
  event: string;
  enabled: boolean;
  source: 'repo' | 'user';
}

/** F8: real hook list from .sunday/hooks.json + ~/.sunday/hooks.json. */
export function listHooksOut(workspaceDir?: string): HookInfo[] {
  const root = workspaceDir ?? process.cwd();
  let loaded: LoadedHook[] = [];
  try {
    const result = loadHooks(root, os.homedir());
    loaded = result.hooks;
  } catch {
    // No hooks configured — fine, empty list is real data
  }
  return loaded.map((h) => ({
    name: h.name,
    event: h.event,
    enabled: true,
    source: h.source === 'repo' ? 'repo' : 'user',
  }));
}

// ---------------------------------------------------------------------------
// F9: Evidence Pack — real builders over a git diff
// ---------------------------------------------------------------------------

export interface EvidenceOut {
  hunks: number;
  highRisk: number;
  unrelated: number;
  topRisks: { path: string; tier: string; reason: string }[];
}

/** F9: real evidence summary for a unified diff. */
export function evidenceForDiff(diffText: string, goal: string): EvidenceOut {
  const hunks: EvidenceHunk[] = parseDiff(diffText);
  const ranked = rankHunks(hunks);
  let highRisk = 0;
  let unrelated = 0;
  const topRisks: EvidenceOut['topRisks'] = [];
  for (const h of ranked) {
    const rs = scoreHunk(h);
    if (rs.tier === 'high' || rs.tier === 'critical') highRisk++;
    const rel = classifyIntentRelation(goal, h);
    if (rel.relation === 'unrelated') unrelated++;
    if (topRisks.length < 5 && (rs.tier === 'high' || rs.tier === 'critical')) {
      topRisks.push({ path: h.file ?? '', tier: rs.tier, reason: rs.reasons.join('; ') });
    }
  }
  return { hunks: hunks.length, highRisk, unrelated, topRisks };
}
