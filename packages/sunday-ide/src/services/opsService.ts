/**
 * Sunday Ops service — typed access to the `window.sunday.ops` bridge.
 * Every call below hits real backend code (electron/opsBackend.ts).
 */
import type {
  SundayAPI,
  RoutePolicyOut,
  RoutingRecentOut,
  SessionSummary,
  SessionLogEntryOut,
  PolicyInfoOut,
  HookInfo,
  HookConsentOut,
  SecurityStatusOut,
  BrowserOpenOut,
  VisualDiffOut,
  A11yScanOut,
  ViewportShot,
  ScoreboardOut,
  PolicyEval,
  EvidenceSummary,
} from '../../electron/preload';

declare global {
  interface Window {
    sunday?: SundayAPI;
  }
}

function bridge(): SundayAPI {
  const api = window.sunday;
  if (!api) {
    throw new Error(
      'Sunday bridge unavailable — the Sunday IDE renderer must run inside the Electron shell (`pnpm dev`).',
    );
  }
  return api;
}

function ops() {
  return bridge().ops;
}

export const opsService = {
  routingPolicies: (): Promise<RoutePolicyOut[]> => ops().routingPolicies(),
  routingRecent: (): Promise<RoutingRecentOut> => ops().routingRecent(),
  sessions: (): Promise<SessionSummary[]> => ops().sessions(),
  sessionLog: (sessionId: string): Promise<SessionLogEntryOut[]> => ops().sessionLog(sessionId),
  policyInfo: (): Promise<PolicyInfoOut> => ops().policyInfo(),
  policyEvaluate: (command: string, cwd: string): Promise<PolicyEval> =>
    bridge().policy.evaluate(command, cwd),
  hooks: (workspaceDir?: string): Promise<HookInfo[]> => bridge().hooks.list(workspaceDir),
  hooksConsent: (): Promise<HookConsentOut[]> => ops().hooksConsent(),
  securityStatus: (): Promise<SecurityStatusOut> => ops().securityStatus(),
  evidenceForDiff: (diffText: string, goal: string): Promise<EvidenceSummary> =>
    bridge().evidence.get(diffText, goal),
  browserOpen: (url: string): Promise<BrowserOpenOut> => ops().browserOpen(url),
  browserScreenshot: (): Promise<string> => ops().browserScreenshot(),
  browserVisualDiff: (beforePng: string, afterPng: string, threshold?: number): Promise<VisualDiffOut> =>
    ops().browserVisualDiff(beforePng, afterPng, threshold),
  browserA11yScan: (): Promise<A11yScanOut> => ops().browserA11yScan(),
  browserViewportMatrix: (url: string): Promise<ViewportShot[]> => ops().browserViewportMatrix(url),
  scoreboard: (): Promise<ScoreboardOut> => ops().scoreboard(),
};

export type {
  RoutePolicyOut,
  RoutingRecentOut,
  SessionSummary,
  SessionLogEntryOut,
  PolicyInfoOut,
  HookInfo,
  HookConsentOut,
  SecurityStatusOut,
  BrowserOpenOut,
  VisualDiffOut,
  A11yScanOut,
  ViewportShot,
  ScoreboardOut,
  PolicyEval,
  EvidenceSummary,
};
