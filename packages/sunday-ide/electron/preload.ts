/**
 * Sunday IDE — preload bridge. Exposes a minimal, typed `window.sunday` API
 * over context isolation. No Node access leaks into the renderer.
 */
import { contextBridge, ipcRenderer } from 'electron';

export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

/** F13 migration-layer shapes (mirrors @sunday/skills importers). */
export interface ImportDetectedSource {
  kind: string;
  path: string;
  label: string;
  scope: 'workspace' | 'user';
}
export interface ImportPlannedWrite {
  path: string;
  action: 'create' | 'append' | 'merge' | 'overwrite' | 'skip';
  summary: string;
  content: string;
  preview: string;
  skipReason?: string;
}
export interface ImportPlan {
  workspaceDir: string;
  detected: ImportDetectedSource[];
  writes: ImportPlannedWrite[];
  unconvertible: { source: string; item: string; reason: string }[];
  nothingToDo: boolean;
}
export interface ImportReport {
  appliedAt: string;
  converted: { source: string; target: string; detail: string }[];
  skipped: { source: string; target: string; reason: string }[];
  needsAttention: { source: string; item: string; reason: string }[];
}

export interface SundayAPI {
  window: {
    minimize(): Promise<void>;
    maximize(): Promise<void>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
  };
  dialog: {
    openFolder(): Promise<string | null>;
  };
  fs: {
    readDir(dirPath: string): Promise<FsEntry[]>;
    readFile(filePath: string): Promise<{ content: string; isBinary: boolean }>;
    writeFile(filePath: string, content: string): Promise<void>;
    createFile(filePath: string): Promise<void>;
    createDir(dirPath: string): Promise<void>;
    deletePath(targetPath: string): Promise<void>;
    renamePath(oldPath: string, newPath: string): Promise<void>;
  };
  watch: {
    start(dirPath: string): Promise<void>;
    stop(): Promise<void>;
    onChanged(cb: (info: { dirPath: string; filename: string }) => void): () => void;
  };
  git: {
    branch(dirPath: string): Promise<string | null>;
    status(dirPath: string): Promise<GitStatusResult>;
    stage(dirPath: string, paths: string[]): Promise<{ ok: boolean; error?: string }>;
    unstage(dirPath: string, paths: string[]): Promise<{ ok: boolean; error?: string }>;
    commit(dirPath: string, message: string): Promise<{ ok: boolean; error?: string }>;
    diff(dirPath: string, filePath: string, staged: boolean): Promise<string>;
  };
  settings: {
    get(): Promise<SundaySettings>;
    set(patch: Partial<SundaySettings>): Promise<SundaySettings>;
  };
  importer: {
    detect(workspaceDir: string): Promise<ImportDetectedSource[]>;
    plan(workspaceDir: string): Promise<ImportPlan>;
    apply(plan: ImportPlan): Promise<ImportReport>;
  };
  extensions: {
    search(query: string): Promise<OpenVsxExtension[]>;
    list(): Promise<InstalledExtension[]>;
    install(ext: OpenVsxExtension): Promise<{ ok: boolean; error?: string }>;
    uninstall(id: string): Promise<{ ok: boolean; error?: string }>;
    setEnabled(id: string, enabled: boolean): Promise<void>;
    hostScan(): Promise<unknown>;
    hostActivate(rootPath: string | null): Promise<Record<string, string> | { error: string }>;
    executeCommand(id: string, args?: unknown[]): Promise<unknown>;
    onMessage(cb: (info: { kind: string; message: string }) => void): () => void;
    onOutput(cb: (info: { method: string; name: string; value?: string }) => void): () => void;
  };
  debug: {
    launch(cwd: string, program: string, args: string[]): Promise<{ ok: boolean; error?: string }>;
    stop(): Promise<void>;
    onOutput(cb: (info: { stream: 'stdout' | 'stderr'; text: string }) => void): () => void;
    onExit(cb: (info: { exitCode: number; error?: string }) => void): () => void;
  };
  pty: {
    spawn(id: string, cwd: string, cols: number, rows: number): Promise<{ ok: boolean; error?: string }>;
    write(id: string, data: string): Promise<void>;
    resize(id: string, cols: number, rows: number): Promise<void>;
    kill(id: string): Promise<void>;
    onData(cb: (info: { id: string; data: string }) => void): () => void;
    onExit(cb: (info: { id: string; exitCode: number }) => void): () => void;
  };
  search: {
    text(query: string, dirPath: string): Promise<SearchResult[]>;
    hybrid(query: string, dirPath: string): Promise<HybridSearchResult[]>;
  };
  agent: {
    send(req: AgentRequest): Promise<AgentReply>;
    estimate(message: string, model?: string): Promise<AgentEstimate>;
    usage(): Promise<AgentUsage>;
    budgetContinue(scope: string, n: number): Promise<AgentUsage>;
  };
  loopguard: {
    status(): Promise<LoopGuardStatus>;
  };
  context: {
    meter(): Promise<ContextUsage>;
    pin(text: string): Promise<PinnedFact>;
    unpin(id: string): Promise<boolean>;
    pins(): Promise<PinnedFact[]>;
    compactPreview(messages: AgentMessage[]): Promise<CompactionPreview>;
    track(userText: string, assistantText: string): Promise<ContextUsage>;
  };
  session: {
    rewind(sessionId: string, entryId: string): Promise<unknown>;
    branch(sessionId: string, entryId?: string, title?: string): Promise<unknown>;
    export(sessionId: string, format: 'jsonl' | 'markdown'): Promise<unknown>;
  };
  policy: {
    evaluate(command: string, cwd: string): Promise<PolicyEval>;
  };
  hooks: {
    list(workspaceDir?: string): Promise<HookInfo[]>;
  };
  evidence: {
    get(diffText: string, goal: string): Promise<EvidenceSummary>;
  };
  local: {
    status(): Promise<LocalChatStatus>;
    models(): Promise<LocalModel[]>;
    probe(): Promise<LocalProbeResult>;
    privacy(): Promise<boolean>;
    setPrivacy(on: boolean): Promise<boolean>;
  };
  org: {
    load(workspaceDir?: string): Promise<OrgPolicySummary>;
    locked(key: string, workspaceDir?: string): Promise<boolean>;
    audit(limit?: number): Promise<OrgAuditEvent[]>;
  };
  ops: {
    routingPolicies(): Promise<RoutePolicyOut[]>;
    routingRecent(): Promise<RoutingRecentOut>;
    sessions(): Promise<SessionSummary[]>;
    sessionLog(sessionId: string): Promise<SessionLogEntryOut[]>;
    policyInfo(): Promise<PolicyInfoOut>;
    hooksConsent(): Promise<HookConsentOut[]>;
    securityStatus(): Promise<SecurityStatusOut>;
    browserOpen(url: string): Promise<BrowserOpenOut>;
    browserScreenshot(): Promise<string>;
    browserVisualDiff(beforePng: string, afterPng: string, threshold?: number): Promise<VisualDiffOut>;
    browserA11yScan(): Promise<A11yScanOut>;
    browserViewportMatrix(url: string): Promise<ViewportShot[]>;
    scoreboard(): Promise<ScoreboardOut>;
  };
}

export interface SearchResult {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface HybridSearchResult {
  path: string;
  line: number;
  text: string;
  why: string;
  score: number;
}

export interface SundaySettings {
  theme: 'sunday-dark' | 'sunday-light';
  editorFontSize: number;
  editorFontFamily: string;
  editorTabSize: number;
  editorWordWrap: boolean;
  terminalFontSize: number;
}

export interface GitFileChange {
  path: string;
  /** Porcelain status letter: M, A, D, R, ?, U … */
  status: string;
  staged: boolean;
}

export interface GitStatusResult {
  isRepo: boolean;
  branch: string | null;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  error?: string;
}

export interface OpenVsxExtension {
  id: string;
  namespace: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  downloadUrl: string;
  iconUrl: string | null;
}

export interface InstalledExtension extends OpenVsxExtension {
  enabled: boolean;
  installedAt: string;
}

export type AgentMode = 'auto' | 'architect' | 'implementer' | 'reviewer';

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentRequest {
  message: string;
  mode: AgentMode;
  model: string;
  history: AgentMessage[];
}

export interface AgentReply {
  content: string;
  /** When true, the hard budget was hit and the agent paused. */
  budgetPaused: boolean;
  /** Requests consumed by this turn (mock). */
  requestsUsed: number;
}

export interface AgentEstimate {
  min: number;
  max: number;
  confidence: 'low' | 'medium' | 'high';
  rationale: string;
}

export interface AgentUsage {
  used: number;
  limit: number;
  resetAt: string;
  taskSpend: number;
  costPerSuccessfulTask?: number;
  pausedScopes?: string[];
}

export interface LoopGuardStatus {
  tripped: boolean;
  triggerKind?: string;
  recentCalls: number;
}

export interface ContextUsage {
  used: number;
  limit: number;
  percent: number;
  breakdown: Record<string, number>;
  pinnedCount: number;
}

export interface PinnedFact {
  id: string;
  text: string;
  pinnedBy: string;
  createdAt: number;
}

export interface CompactionPreview {
  toSummarize: string[];
  toDrop: string[];
  toTrim: string[];
  protected: string[];
  tokensBefore: number;
  tokensAfter: number;
  draftSummary: string;
}

export interface PolicyEval {
  tier: string;
  decision: 'allow' | 'ask' | 'deny';
  reasons: string[];
}

export interface HookInfo {
  name: string;
  event: string;
  enabled: boolean;
  source: 'repo' | 'user';
}

export interface EvidenceSummary {
  hunks: number;
  highRisk: number;
  unrelated: number;
  topRisks: { path: string; tier: string; reason: string }[];
}

/** F14: Local-first Chat (Ollama) shapes — mirror @sunday/gateway local-chat. */
export interface LocalChatStatus {
  enabled: boolean;
  available: boolean;
  agentCapable: boolean | null;
  probedAt?: string;
  model: string;
  host: string;
}

export interface LocalModel {
  /** "ollama:<bare-id>" ref the router understands. */
  id: string;
  label: string;
  contextWindow: number;
  supportsTools: boolean;
}

export interface LocalProbeCheck {
  pass: boolean;
  detail: string;
}

export interface LocalProbeResult {
  model: string;
  agentCapable: boolean;
  checks: {
    toolCall: LocalProbeCheck;
    json: LocalProbeCheck;
    editApply: LocalProbeCheck;
  };
  probedAt: string;
}

/** F15: Team Governance shapes — mirror @sunday/org. */
export interface OrgPolicySummary {
  found: boolean;
  path?: string;
  orgId?: string;
  orgName?: string;
  verifiedKeyId: string | null;
  locked: string[];
  policyProfile: string;
  allowedModels: string[] | null;
  allowedProviders: string[] | null;
  budgets: Record<string, unknown>;
  error?: string;
}

export interface OrgAuditEvent {
  id: string;
  ts: string;
  type: string;
  actor: string;
  summary: string;
}

/** UI WAVE: Sunday Ops view shapes — mirror electron/opsBackend.ts. */
export interface RoutePolicyOut {
  taskClass: string;
  primary: string;
  fallbacks: string[];
  downgrade: string;
}

export interface RoutingLogEntryOut {
  seq: number;
  ts: string;
  kind: string;
  taskClass: string;
  requestedModel: string;
  primary?: string;
  chosen?: string;
  providerId?: string;
  ok?: boolean;
  reason?: string;
  error?: string;
  latencyMs?: number;
}

export interface RoutingRecentOut {
  available: boolean;
  entries: RoutingLogEntryOut[];
  note: string;
}

export interface SessionSummary {
  id: string;
  title?: string;
  cwd?: string;
  model?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface SessionLogEntryOut {
  seq: number;
  id: string;
  ts: string;
  type: string;
  summary: string;
}

export interface PolicyInfoOut {
  tiers: string[];
  profiles: string[];
  matrix: Record<string, Record<string, string>>;
  currentProfile: string;
  profileSource: string;
}

export interface HookConsentOut {
  hash: string;
  workspaceRoot: string;
  consentedAt: string;
}

export interface InjectionRuleInfoOut {
  rule: string;
  detail: string;
  severity: 'block' | 'ask';
}

export interface SecurityStatusOut {
  firewallRules: InjectionRuleInfoOut[];
  sinkTiers: { sink: string; tier: string }[];
  secretScan: { available: boolean; note: string };
  mcpPins: { available: boolean; note: string };
}

export interface BrowserOpenOut {
  ok: boolean;
  needsApproval?: boolean;
  origin?: string;
}

export interface VisualDiffOut {
  diffPixels: number;
  totalPixels: number;
  diffRatio: number;
  diffPath?: string;
  width?: number;
  height?: number;
}

export interface A11yViolationOut {
  id: string;
  impact: string | null;
  description: string;
  nodes: number;
}

export interface A11yScanOut {
  url?: string;
  violations: A11yViolationOut[];
  passes: number;
}

export interface ViewportShot {
  name: string;
  width: number;
  height: number;
  path?: string;
  png?: string;
}

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

const api: SundayAPI = {
  window: {
    minimize: () => ipcRenderer.invoke('sunday:window:minimize'),
    maximize: () => ipcRenderer.invoke('sunday:window:maximize'),
    close: () => ipcRenderer.invoke('sunday:window:close'),
    isMaximized: () => ipcRenderer.invoke('sunday:window:isMaximized'),
  },
  dialog: {
    openFolder: () => ipcRenderer.invoke('sunday:dialog:openFolder'),
  },
  fs: {
    readDir: (dirPath) => ipcRenderer.invoke('sunday:fs:readDir', dirPath),
    readFile: (filePath) => ipcRenderer.invoke('sunday:fs:readFile', filePath),
    writeFile: (filePath, content) => ipcRenderer.invoke('sunday:fs:writeFile', filePath, content),
    createFile: (filePath) => ipcRenderer.invoke('sunday:fs:createFile', filePath),
    createDir: (dirPath) => ipcRenderer.invoke('sunday:fs:createDir', dirPath),
    deletePath: (targetPath) => ipcRenderer.invoke('sunday:fs:deletePath', targetPath),
    renamePath: (oldPath, newPath) => ipcRenderer.invoke('sunday:fs:renamePath', oldPath, newPath),
  },
  watch: {
    start: (dirPath) => ipcRenderer.invoke('sunday:watch:start', dirPath),
    stop: () => ipcRenderer.invoke('sunday:watch:stop'),
    onChanged: (cb) => {
      const listener = (
        _e: unknown,
        info: { dirPath: string; filename: string },
      ): void => cb(info);
      ipcRenderer.on('sunday:fs-changed', listener);
      return () => ipcRenderer.removeListener('sunday:fs-changed', listener);
    },
  },
  git: {
    branch: (dirPath) => ipcRenderer.invoke('sunday:git:branch', dirPath),
    status: (dirPath) => ipcRenderer.invoke('sunday:git:status', dirPath),
    stage: (dirPath, paths) => ipcRenderer.invoke('sunday:git:stage', dirPath, paths),
    unstage: (dirPath, paths) => ipcRenderer.invoke('sunday:git:unstage', dirPath, paths),
    commit: (dirPath, message) => ipcRenderer.invoke('sunday:git:commit', dirPath, message),
    diff: (dirPath, filePath, staged) => ipcRenderer.invoke('sunday:git:diff', dirPath, filePath, staged),
  },
  settings: {
    get: () => ipcRenderer.invoke('sunday:settings:get'),
    set: (patch) => ipcRenderer.invoke('sunday:settings:set', patch),
  },
  importer: {
    detect: (workspaceDir) => ipcRenderer.invoke('sunday:import:detect', workspaceDir),
    plan: (workspaceDir) => ipcRenderer.invoke('sunday:import:plan', workspaceDir),
    apply: (plan) => ipcRenderer.invoke('sunday:import:apply', plan),
  },
  extensions: {
    search: (query) => ipcRenderer.invoke('sunday:extensions:search', query),
    list: () => ipcRenderer.invoke('sunday:extensions:list'),
    install: (ext) => ipcRenderer.invoke('sunday:extensions:install', ext),
    uninstall: (id) => ipcRenderer.invoke('sunday:extensions:uninstall', id),
    setEnabled: (id, enabled) => ipcRenderer.invoke('sunday:extensions:setEnabled', id, enabled),
    hostScan: () => ipcRenderer.invoke('sunday:extensions:hostScan'),
    hostActivate: (rootPath) => ipcRenderer.invoke('sunday:extensions:hostActivate', rootPath),
    executeCommand: (id, args) => ipcRenderer.invoke('sunday:extensions:executeCommand', id, args),
    onMessage: (cb) => {
      const listener = (_e: unknown, info: { kind: string; message: string }): void => cb(info);
      ipcRenderer.on('sunday:ext:message', listener);
      return () => ipcRenderer.removeListener('sunday:ext:message', listener);
    },
    onOutput: (cb) => {
      const listener = (_e: unknown, info: { method: string; name: string; value?: string }): void => cb(info);
      ipcRenderer.on('sunday:ext:output', listener);
      return () => ipcRenderer.removeListener('sunday:ext:output', listener);
    },
  },
  debug: {
    launch: (cwd, program, args) => ipcRenderer.invoke('sunday:debug:launch', cwd, program, args),
    stop: () => ipcRenderer.invoke('sunday:debug:stop'),
    onOutput: (cb) => {
      const listener = (_e: unknown, info: { stream: 'stdout' | 'stderr'; text: string }): void => cb(info);
      ipcRenderer.on('sunday:debug-output', listener);
      return () => ipcRenderer.removeListener('sunday:debug-output', listener);
    },
    onExit: (cb) => {
      const listener = (_e: unknown, info: { exitCode: number; error?: string }): void => cb(info);
      ipcRenderer.on('sunday:debug-exit', listener);
      return () => ipcRenderer.removeListener('sunday:debug-exit', listener);
    },
  },
  pty: {
    spawn: (id, cwd, cols, rows) => ipcRenderer.invoke('sunday:pty:spawn', id, cwd, cols, rows),
    write: (id, data) => ipcRenderer.invoke('sunday:pty:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke('sunday:pty:resize', id, cols, rows),
    kill: (id) => ipcRenderer.invoke('sunday:pty:kill', id),
    onData: (cb) => {
      const listener = (_e: unknown, info: { id: string; data: string }): void => cb(info);
      ipcRenderer.on('sunday:pty-data', listener);
      return () => ipcRenderer.removeListener('sunday:pty-data', listener);
    },
    onExit: (cb) => {
      const listener = (_e: unknown, info: { id: string; exitCode: number }): void => cb(info);
      ipcRenderer.on('sunday:pty-exit', listener);
      return () => ipcRenderer.removeListener('sunday:pty-exit', listener);
    },
  },
  search: {
    text: (query, dirPath) => ipcRenderer.invoke('sunday:search:text', query, dirPath),
    hybrid: (query, dirPath) => ipcRenderer.invoke('sunday:search:hybrid', query, dirPath),
  },
  agent: {
    send: (req) => ipcRenderer.invoke('sunday:agent:send', req),
    estimate: (message, model) => ipcRenderer.invoke('sunday:agent:estimate', message, model),
    usage: () => ipcRenderer.invoke('sunday:agent:usage'),
    budgetContinue: (scope, n) => ipcRenderer.invoke('sunday:budget:continue', scope, n),
  },
  loopguard: {
    status: () => ipcRenderer.invoke('sunday:loopguard:status'),
  },
  context: {
    meter: () => ipcRenderer.invoke('sunday:context:meter'),
    pin: (text) => ipcRenderer.invoke('sunday:context:pin', text),
    unpin: (id) => ipcRenderer.invoke('sunday:context:unpin', id),
    pins: () => ipcRenderer.invoke('sunday:context:pins'),
    compactPreview: (messages) => ipcRenderer.invoke('sunday:context:compact-preview', messages),
    track: (userText, assistantText) => ipcRenderer.invoke('sunday:context:track', userText, assistantText),
  },
  session: {
    rewind: (sessionId, entryId) => ipcRenderer.invoke('sunday:session:rewind', sessionId, entryId),
    branch: (sessionId, entryId, title) => ipcRenderer.invoke('sunday:session:branch', sessionId, entryId, title),
    export: (sessionId, format) => ipcRenderer.invoke('sunday:session:export', sessionId, format),
  },
  policy: {
    evaluate: (command, cwd) => ipcRenderer.invoke('sunday:policy:evaluate', command, cwd),
  },
  hooks: {
    list: (workspaceDir) => ipcRenderer.invoke('sunday:hooks:list', workspaceDir),
  },
  evidence: {
    get: (diffText, goal) => ipcRenderer.invoke('sunday:evidence:get', diffText, goal),
  },
  local: {
    status: () => ipcRenderer.invoke('sunday:local:status'),
    models: () => ipcRenderer.invoke('sunday:local:models'),
    probe: () => ipcRenderer.invoke('sunday:local:probe'),
    privacy: () => ipcRenderer.invoke('sunday:local:privacy'),
    setPrivacy: (on: boolean) => ipcRenderer.invoke('sunday:local:set-privacy', on),
  },
  org: {
    load: (workspaceDir?: string) => ipcRenderer.invoke('sunday:org:load', workspaceDir),
    locked: (key: string, workspaceDir?: string) => ipcRenderer.invoke('sunday:org:locked', key, workspaceDir),
    audit: (limit?: number) => ipcRenderer.invoke('sunday:org:audit', limit),
  },
  ops: {
    routingPolicies: () => ipcRenderer.invoke('sunday:routing:policies'),
    routingRecent: () => ipcRenderer.invoke('sunday:routing:recent'),
    sessions: () => ipcRenderer.invoke('sunday:session:list'),
    sessionLog: (sessionId: string) => ipcRenderer.invoke('sunday:session:log', sessionId),
    policyInfo: () => ipcRenderer.invoke('sunday:policy:info'),
    hooksConsent: () => ipcRenderer.invoke('sunday:hooks:consent'),
    securityStatus: () => ipcRenderer.invoke('sunday:security:status'),
    browserOpen: (url: string) => ipcRenderer.invoke('sunday:browser:open', url),
    browserScreenshot: () => ipcRenderer.invoke('sunday:browser:screenshot'),
    browserVisualDiff: (beforePng: string, afterPng: string, threshold?: number) =>
      ipcRenderer.invoke('sunday:browser:visual-diff', beforePng, afterPng, threshold),
    browserA11yScan: () => ipcRenderer.invoke('sunday:browser:a11y-scan'),
    browserViewportMatrix: (url: string) => ipcRenderer.invoke('sunday:browser:viewport-matrix', url),
    scoreboard: () => ipcRenderer.invoke('sunday:eval:scoreboard'),
  },
};

contextBridge.exposeInMainWorld('sunday', api);
