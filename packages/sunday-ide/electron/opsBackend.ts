/**
 * Sunday IDE — opsBackend.ts
 *
 * UI WAVE: Real backends for the "Sunday Ops" view — one visible panel per
 * F that previously had working backend+IPC but no IDE UI surface.
 *
 * - F3: route policy table (real @sunday/gateway DEFAULT_ROUTE_POLICIES) +
 *       recent routing decisions (daemon RPC when available, honest "n/a")
 * - F6: session list + event log (real daemon session/list, session/log)
 * - F7: policy info — tier table, profile matrix, current profile (real
 *       permission-intel data)
 * - F8: hooks consent store (real ~/.sunday/hooks-consent.json)
 * - F10: security status — injection rules, sink tiers (real data)
 * - F11: browser visual-diff / a11y-scan / viewport-matrix (real daemon RPCs)
 * - F12: eval scoreboard (real docs/SCOREBOARD.md, parsed)
 *
 * NO STUBS — every export reads real backend data or reports honestly when
 * a piece is unavailable.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- F3: real route policies + routing log types ---
import {
  DEFAULT_ROUTE_POLICIES,
  type RoutePolicy,
  type RoutingLogEntry,
} from '@sunday/gateway';

// --- F7: real permission-intel data ---
import {
  TIER_ORDER,
  getProfileDefaults,
  PermissionIntel,
  type PolicyProfile,
  type RiskTier,
} from '../../sundayd/src/permission-intel.js';

// --- F10: real injection-firewall data ---
import {
  listInjectionRules,
  SINK_TIER,
  type InjectionRuleInfo,
} from '../../sundayd/src/injection-firewall.js';

// --- daemon JSON-RPC (lightweight client; avoids agentBackend's heavy import graph) ---
import { daemonRpc } from './daemonClient.js';

// ---------------------------------------------------------------------------
// F3: Honest Routing — policy table + recent decisions
// ---------------------------------------------------------------------------

export interface RoutePolicyOut {
  taskClass: string;
  primary: string;
  fallbacks: string[];
  downgrade: string;
}

/** F3: the real default route policy table from @sunday/gateway. */
export function getRoutePolicies(): RoutePolicyOut[] {
  const policies: RoutePolicy[] = DEFAULT_ROUTE_POLICIES;
  return policies.map((p) => ({
    taskClass: p.taskClass,
    primary: p.primary,
    fallbacks: [...p.fallbacks],
    downgrade: p.downgrade,
  }));
}

export interface RoutingRecentOut {
  available: boolean;
  entries: RoutingLogEntry[];
  note: string;
}

/**
 * F3: recent routing decisions. The RoutingLog lives in-memory inside the
 * gateway/sundayd process; the daemon does not (yet) expose a `routing/log`
 * RPC, so this reports honestly and the UI shows the policy table instead.
 */
export async function getRoutingRecent(): Promise<RoutingRecentOut> {
  try {
    const res = (await daemonRpc('routing/log', { limit: 50 }, 8000)) as {
      entries?: RoutingLogEntry[];
    };
    if (Array.isArray(res.entries)) {
      return {
        available: true,
        entries: res.entries,
        note: 'Live routing decisions from the daemon.',
      };
    }
  } catch {
    // No routing/log RPC on the daemon — honest fallback below.
  }
  return {
    available: false,
    entries: [],
    note:
      'Live routing decisions are not exposed by the daemon yet (no routing/log RPC). ' +
      'The policy table below is the real routing configuration every agent turn goes through.',
  };
}

// ---------------------------------------------------------------------------
// F6: Durable Sessions — list + event log
// ---------------------------------------------------------------------------

export interface SessionSummary {
  id: string;
  title?: string;
  cwd?: string;
  model?: string;
  createdAt?: number;
  updatedAt?: number;
}

/** F6: real session list from the daemon. */
export async function listSessions(): Promise<SessionSummary[]> {
  const res = (await daemonRpc('session/list', {})) as { sessions?: SessionSummary[] };
  return Array.isArray(res.sessions) ? res.sessions : [];
}

export interface SessionLogEntryOut {
  seq: number;
  id: string;
  ts: string;
  type: string;
  /** Truncated payload summary for display. */
  summary: string;
}

/** F6: real event log for a session (the rewind timeline). */
export async function sessionLogEntries(sessionId: string): Promise<SessionLogEntryOut[]> {
  const res = (await daemonRpc('session/log', { sessionId })) as {
    entries?: { seq: number; id: string; ts: string; type: string; payload?: unknown }[];
  };
  if (!Array.isArray(res.entries)) return [];
  return res.entries.map((e) => ({
    seq: e.seq,
    id: e.id,
    ts: e.ts,
    type: e.type,
    summary: summarizePayload(e.payload),
  }));
}

function summarizePayload(payload: unknown): string {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload.slice(0, 120);
  if (typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    const bits: string[] = [];
    for (const k of ['title', 'model', 'message', 'tool', 'entryId', 'label', 'reason']) {
      if (typeof p[k] === 'string' && p[k]) bits.push(`${k}: ${String(p[k]).slice(0, 60)}`);
    }
    if (bits.length > 0) return bits.join(' · ');
    try {
      return JSON.stringify(payload).slice(0, 120);
    } catch {
      return '';
    }
  }
  return String(payload).slice(0, 120);
}

// ---------------------------------------------------------------------------
// F7: Permission Intelligence — tier table, profile matrix, current profile
// ---------------------------------------------------------------------------

export interface PolicyInfoOut {
  tiers: RiskTier[];
  profiles: PolicyProfile[];
  matrix: Record<PolicyProfile, Record<RiskTier, string>>;
  currentProfile: PolicyProfile;
  profileSource: string;
}

/** F7: the real tier table + profile decision matrix + current profile. */
export function getPolicyInfo(): PolicyInfoOut {
  const matrix = getProfileDefaults();
  const intel = new PermissionIntel();
  const currentProfile = intel.getProfile();
  const envSet = (process.env.SUNDAY_POLICY_PROFILE ?? '').trim();
  return {
    tiers: [...TIER_ORDER],
    profiles: ['cautious', 'balanced', 'autopilot'],
    matrix: {
      cautious: { ...matrix.cautious },
      balanced: { ...matrix.balanced },
      autopilot: { ...matrix.autopilot },
    },
    currentProfile,
    profileSource: envSet
      ? `SUNDAY_POLICY_PROFILE=${envSet} (daemon may differ — it reads its own env)`
      : 'default (balanced) — set SUNDAY_POLICY_PROFILE to change',
  };
}

// ---------------------------------------------------------------------------
// F8: User Hooks — consent store
// ---------------------------------------------------------------------------

export interface HookConsentOut {
  hash: string;
  workspaceRoot: string;
  consentedAt: string;
}

/** F8: real hash-pinned consent entries from ~/.sunday/hooks-consent.json. */
export function getHooksConsent(): HookConsentOut[] {
  const file = path.join(os.homedir(), '.sunday', 'hooks-consent.json');
  try {
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
      string,
      { consentedAt?: number; workspaceRoot?: string }
    >;
    return Object.entries(raw)
      .filter(([, v]) => typeof v?.consentedAt === 'number')
      .map(([hash, v]) => ({
        hash: hash.slice(0, 16) + '…',
        workspaceRoot: v.workspaceRoot ?? '(unknown)',
        consentedAt: new Date(v.consentedAt as number).toISOString(),
      }));
  } catch {
    // Corrupt store = fail closed = no consent (matches backend semantics).
    return [];
  }
}

// ---------------------------------------------------------------------------
// F10: Security Gate — injection rules + sink tiers
// ---------------------------------------------------------------------------

export interface SecurityStatusOut {
  firewallRules: InjectionRuleInfo[];
  sinkTiers: { sink: string; tier: string }[];
  secretScan: {
    available: boolean;
    note: string;
  };
  mcpPins: {
    available: boolean;
    note: string;
  };
}

/** F10: real firewall config. Secret-scan and MCP pins run on-demand inside
 *  the agent loop / on diffs — there is no persistent "status" to report,
 *  so this says so honestly instead of inventing scan results. */
export function getSecurityStatus(): SecurityStatusOut {
  const rules = listInjectionRules();
  const sinkTiers = Object.entries(SINK_TIER).map(([sink, tier]) => ({ sink, tier }));
  return {
    firewallRules: rules,
    sinkTiers,
    secretScan: {
      available: true,
      note: 'Secret scan (11 patterns) + diff alerts run automatically on every agent turn and every reviewed diff. No stored results — scans are live, not cached.',
    },
    mcpPins: {
      available: true,
      note: 'MCP tool definitions are SHA-256 pinned; a changed definition requires re-approval before the tool can run again. Pins live per MCP server config.',
    },
  };
}

// ---------------------------------------------------------------------------
// F11: Browser-verified UI Loop — real daemon RPCs
// ---------------------------------------------------------------------------

export interface VisualDiffOut {
  diffPixels: number;
  totalPixels: number;
  diffRatio: number;
  diffPath?: string;
  width?: number;
  height?: number;
}

/** F11: pixel-compare two screenshots via the real browserd RPC. */
export async function browserVisualDiff(
  beforePng: string,
  afterPng: string,
  threshold?: number,
): Promise<VisualDiffOut> {
  const res = (await daemonRpc(
    'browser/panel/visual-diff',
    { beforePng, afterPng, ...(typeof threshold === 'number' ? { threshold } : {}) },
    60000,
  )) as VisualDiffOut;
  return res;
}

/** F11: capture a screenshot of the current browser page (for diff input). */
export async function browserScreenshot(): Promise<string> {
  const res = (await daemonRpc('browser/panel/screenshot', {}, 30000)) as { data?: string };
  if (!res.data) throw new Error('browserd returned an empty screenshot');
  return res.data;
}

/** F11: open a URL in the agent browser (real RPC; approval policy enforced by browserd). */
export async function browserOpen(url: string): Promise<{ ok: boolean; needsApproval?: boolean; origin?: string }> {
  const res = (await daemonRpc('browser/panel/open', { url }, 30000)) as {
    ok: boolean;
    needsApproval?: boolean;
    origin?: string;
  };
  return res;
}

export interface A11yViolation {
  id: string;
  impact: string | null;
  description: string;
  nodes: number;
}

export interface A11yScanOut {
  url?: string;
  violations: A11yViolation[];
  passes: number;
}

/** F11: axe-core accessibility scan of the current page (real browserd RPC). */
export async function browserA11yScan(): Promise<A11yScanOut> {
  const res = (await daemonRpc('browser/panel/accessibility-scan', {}, 60000)) as {
    url?: string;
    violations?: A11yViolation[];
    passes?: number;
  };
  return {
    url: res.url,
    violations: Array.isArray(res.violations) ? res.violations : [],
    passes: res.passes ?? 0,
  };
}

export interface ViewportShot {
  name: string;
  width: number;
  height: number;
  path?: string;
  png?: string;
}

/** F11: capture a URL across the viewport matrix (real browserd RPC). */
export async function browserViewportMatrix(url: string): Promise<ViewportShot[]> {
  const res = (await daemonRpc('browser/panel/viewport-matrix', { url }, 120000)) as {
    shots?: ViewportShot[];
  };
  return Array.isArray(res.shots) ? res.shots : [];
}

// ---------------------------------------------------------------------------
// F12: Eval Scoreboard — parse the real generated markdown
// ---------------------------------------------------------------------------

export interface ScoreboardRow {
  model: string;
  runs: number;
  passRate: string;
  toolReliability: string;
  medianTime: string;
  costPerSuccess: string;
  loopTriggerRate: string;
}

export interface ScoreboardOut {
  found: boolean;
  generatedAt?: string;
  rows: ScoreboardRow[];
  note: string;
}

/** F12: read + parse the real docs/SCOREBOARD.md generated by sunday-eval. */
export function getScoreboard(): ScoreboardOut {
  // packages/sunday-ide/electron -> repo root docs/SCOREBOARD.md
  const file = path.resolve(__dirname, '..', '..', '..', 'docs', 'SCOREBOARD.md');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {
      found: false,
      rows: [],
      note: 'No scoreboard generated yet. Run the nightly eval CI (sunday-eval scoreboard) to populate docs/SCOREBOARD.md.',
    };
  }
  const genMatch = text.match(/Generated ([0-9T:.\-Z]+)/);
  const rows: ScoreboardRow[] = [];
  // Parse the Summary table rows: | model | runs | pass | reliability | median | cost | loop |
  const lines = text.split('\n');
  let inSummary = false;
  for (const line of lines) {
    if (line.startsWith('## Summary')) {
      inSummary = true;
      continue;
    }
    if (inSummary && line.startsWith('## ')) break;
    if (!inSummary || !line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (cells.length < 7) continue;
    if (/^-+$/.test(cells[0]) || cells[0].toLowerCase() === 'model') continue;
    rows.push({
      model: cells[0],
      runs: Number(cells[1]) || 0,
      passRate: cells[2],
      toolReliability: cells[3],
      medianTime: cells[4],
      costPerSuccess: cells[5],
      loopTriggerRate: cells[6],
    });
  }
  return {
    found: true,
    generatedAt: genMatch?.[1],
    rows,
    note:
      rows.length === 0
        ? 'Scoreboard file exists but has no model rows yet.'
        : 'Scores are pooled across repetitions; pass-rate range shows run-to-run variance.',
  };
}
