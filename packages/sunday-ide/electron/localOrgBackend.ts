/**
 * Sunday IDE — localOrgBackend.ts
 *
 * INTEGRATION WAVE (F14 + F15): Real wiring for Local-first Chat (Ollama)
 * and Team Governance (org policy bundles) into the Electron main process.
 * NO STUBS — every export calls real backend code.
 *
 * - F14: @sunday/gateway local-chat.ts (OllamaProvider, probeOllama, config)
 * - F15: @sunday/org (findOrgBundle, loadOrgPolicy, isLocked, mergePolicies,
 *   getAuditLog)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- F14: real local-chat backend (proper @sunday package) ---
import {
  OllamaProvider,
  probeOllama,
  getLocalChatConfig,
  type CapabilityProbeResult,
  type ModelEntry,
} from '@sunday/gateway';

// --- F15: real org governance (proper @sunday package) ---
import {
  findOrgBundle,
  loadOrgPolicy,
  isLocked,
  mergePolicies,
  getAuditLog,
  type EffectivePolicy,
} from '@sunday/org';

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
// F14: Local-first Chat Mode (Ollama)
// ---------------------------------------------------------------------------

const ollamaProvider = new OllamaProvider();

export interface LocalChatStatusOut {
  /** Master switch (SUNDAY_LOCAL_CHAT=1 to opt in). */
  enabled: boolean;
  /** True when the Ollama daemon answers /api/tags. */
  available: boolean;
  /** Capability probe outcome: null = not probed yet. */
  agentCapable: boolean | null;
  probedAt?: string;
  /** Configured "ollama:<model>" ref. */
  model: string;
  host: string;
}

/** F14: real status — hits the live Ollama daemon, reads real module config. */
export async function getLocalChatStatus(): Promise<LocalChatStatusOut> {
  const cfg = getLocalChatConfig();
  const available = await ollamaProvider.isAvailable();
  return {
    enabled: cfg.enabled,
    available,
    agentCapable: cfg.agentCapable,
    probedAt: cfg.probedAt,
    model: cfg.model,
    host: ollamaProvider.ollamaHost(),
  };
}

export interface LocalModelOut {
  /** "ollama:<bare-id>" ref the router understands. */
  id: string;
  label: string;
  contextWindow: number;
  supportsTools: boolean;
}

/** F14: real model discovery — live /api/tags when Ollama is up, static
 *  fallback list when down (provider's own graceful degradation). */
export async function listLocalModels(): Promise<LocalModelOut[]> {
  const models: ModelEntry[] = await ollamaProvider.listModels();
  return models.map((m) => ({
    id: `ollama:${m.id}`,
    label: m.label,
    contextWindow: m.contextWindow,
    supportsTools: m.supportsTools,
  }));
}

/**
 * F14: real capability probe against the live Ollama server.
 * Never throws for model misbehaviour — returns { agentCapable: false }
 * with per-check details. Records the outcome into the module config.
 * NOTE: can take ~30-90s (3 model calls); the IPC caller should allow a
 * generous timeout and the UI should show progress.
 */
export async function probeLocalChat(): Promise<CapabilityProbeResult> {
  return probeOllama(ollamaProvider);
}

const LOCAL_PREFS_FILE = path.join(sundayIdeDir(), 'local.json');

/** F14: IDE-persisted "local-only" privacy toggle (per-request privacy tier
 *  enforcement lives in the gateway router; the IDE enforces it at the UI
 *  level by offering only local models when on). */
export function getLocalOnlyMode(): boolean {
  // Audit L8: readJson returns parsed JSON unchecked — a local.json
  // containing the literal `null` (or any non-object) made `.localOnly`
  // throw. Validate the shape; anything unexpected means "off".
  const prefs: unknown = readJson<unknown>(LOCAL_PREFS_FILE, { localOnly: false });
  return (
    typeof prefs === 'object' &&
    prefs !== null &&
    (prefs as { localOnly?: unknown }).localOnly === true
  );
}

export function setLocalOnlyMode(on: boolean): boolean {
  writeJson(LOCAL_PREFS_FILE, { localOnly: !!on });
  return !!on;
}

// ---------------------------------------------------------------------------
// F15: Team Governance — org policy bundles + audit
// ---------------------------------------------------------------------------

/** Locate the active org bundle: workspace walk-up, then ~/.sunday/, then
 *  home walk-up. Returns null when this IDE is unmanaged. */
function findActiveOrgBundle(workspaceDir?: string): string | null {
  if (workspaceDir) {
    const found = findOrgBundle(workspaceDir);
    if (found) return found;
  }
  const homeBundle = path.join(os.homedir(), '.sunday', 'sunday-org.json');
  if (fs.existsSync(homeBundle)) return homeBundle;
  return findOrgBundle(os.homedir());
}

export interface OrgPolicySummaryOut {
  found: boolean;
  path?: string;
  orgId?: string;
  orgName?: string;
  verifiedKeyId: string | null;
  /** Locked setting keys (exact or prefix.* patterns). */
  locked: string[];
  policyProfile: string;
  allowedModels: string[] | null;
  allowedProviders: string[] | null;
  budgets: EffectivePolicy['budgets'];
  error?: string;
}

const EMPTY_SUMMARY: OrgPolicySummaryOut = {
  found: false,
  verifiedKeyId: null,
  locked: [],
  policyProfile: 'balanced',
  allowedModels: null,
  allowedProviders: null,
  budgets: {} as EffectivePolicy['budgets'],
};

/**
 * F15: load + signature-verify the active org bundle, return the effective
 * policy summary. Real verification: unsigned bundles are rejected unless
 * SUNDAY_ORG_ALLOW_UNSIGNED=1 (dev only). Errors are reported honestly in
 * the summary — never thrown, so the UI can show "invalid bundle".
 */
export function loadOrgPolicySummary(workspaceDir?: string): OrgPolicySummaryOut {
  const bundlePath = findActiveOrgBundle(workspaceDir);
  if (!bundlePath) return { ...EMPTY_SUMMARY };
  try {
    const loaded = loadOrgPolicy(bundlePath, {
      allowUnsigned: process.env.SUNDAY_ORG_ALLOW_UNSIGNED === '1',
    });
    const effective = mergePolicies(loaded.bundle, null, null);
    return {
      found: true,
      path: bundlePath,
      orgId: loaded.bundle.org.id,
      orgName: loaded.bundle.org.name,
      verifiedKeyId: loaded.verifiedKeyId,
      locked: [...effective.locked],
      policyProfile: effective.policyProfile,
      allowedModels: effective.allowedModels,
      allowedProviders: effective.allowedProviders,
      budgets: effective.budgets,
    };
  } catch (e) {
    return {
      ...EMPTY_SUMMARY,
      found: true,
      path: bundlePath,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** F15: is this setting key org-locked? Real pattern matching. */
export function isOrgSettingLocked(key: string, workspaceDir?: string): boolean {
  const summary = loadOrgPolicySummary(workspaceDir);
  if (!summary.found || summary.error) return false;
  return isLocked(key, summary.locked);
}

export interface OrgAuditEventOut {
  id: string;
  ts: string;
  type: string;
  actor: string;
  summary: string;
}

/** F15: recent audit events (newest first). Real JSONL audit trail. */
export function getOrgAuditEvents(limit = 20): OrgAuditEventOut[] {
  try {
    const events = getAuditLog().exportParsed();
    return events
      .slice(-Math.max(1, limit))
      .reverse()
      .map((e) => ({
        id: e.id,
        ts: e.ts,
        type: e.type,
        actor: e.actor,
        summary: e.summary,
      }));
  } catch {
    return [];
  }
}
