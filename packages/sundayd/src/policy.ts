/** Policy gate (§9.6): decides whether the agent may execute a tool call.
 *  Denied calls are NOT silent — the loop feeds the denial back to the model
 *  as a tool error so it can adapt, and the daemon surface exposes
 *  ErrorCode.PolicyDenied for client-initiated calls. */
import { READ_ONLY_TOOLS, WRITE_TOOLS, type ToolRegistry } from '@sunday/tools';
import type { PermissionIntel, PolicyContext } from './permission-intel.js';

// Re-exported here so `@sunday/sundayd` keeps its existing public surface;
// the canonical definitions live in @sunday/tools (tool mutability is a
// property of the catalogue, not the policy gate).
export { READ_ONLY_TOOLS, WRITE_TOOLS };

export type PolicyMode = 'allow-all' | 'read-only' | 'deny-all';

export interface PolicyOptions {
  /** Default posture. `allow-all` trusts the agent (local dev default);
   *  `read-only` blocks every mutating tool; `deny-all` blocks everything. */
  mode?: PolicyMode;
  /** Per-tool overrides — checked before the mode. */
  allow?: string[];
  deny?: string[];
  /** Dangerous tools pre-approved for the session (risk class M). */
  approvals?: string[];
}

export type PolicyDecision =
  | { allow: true }
  | {
      allow: false;
      reason: string;
      /** Present when the denial is an approval request (F7): the UI can
       *  render an approval card offering these blanket-allow scopes.
       *  Empty scopes = one-time approval only (destructive classes). */
      ask?: { canonical: string; tier: string; scopes: unknown[] };
    };

/**
 * Mark every tool whose definition carries `dangerous: true` on the gate.
 * Call after (re)registering tools — e.g. browser tools registered by the
 * daemon after the gate was built.
 */
export function syncDangerousFlags(policy: PolicyGate, tools: ToolRegistry): void {
  for (const def of tools.definitions()) {
    if (def.dangerous === true) policy.markDangerous(def.name);
  }
}

/**
 * Policy gate (§9.6) with risk-class-M approvals.
 *
 * Tools flagged `dangerous` (MCP tools, `remember`) are denied until
 * explicitly approved — via the `allow` overrides, the `approvals` option, or
 * `approve()` at runtime (e.g. through the `policy/approve` RPC method the
 * extension's MCP panel drives). Approval is per PolicyGate instance, i.e.
 * per daemon session lifetime.
 */
export class PolicyGate {
  private readonly mode: PolicyMode;
  private readonly allow: Set<string>;
  private readonly deny: Set<string>;
  /** Tools flagged dangerous (risk class M). */
  private readonly dangerous = new Set<string>();
  /** Per-session approvals for dangerous tools. */
  private readonly approved: Set<string>;
  /** F7 Permission Intelligence — when attached, arg-aware classification
   *  (risk tiers, profiles, scoped allowlists, batch plans) decides calls
   *  the intel understands; everything else falls back to evaluate(). */
  private intel: PermissionIntel | undefined;
  private intelPlanId: string | undefined;

  constructor(opts: PolicyOptions = {}) {
    this.mode = opts.mode ?? 'allow-all';
    this.allow = new Set(opts.allow ?? []);
    this.deny = new Set(opts.deny ?? []);
    this.approved = new Set(opts.approvals ?? []);
  }

  /** Attach F7 Permission Intelligence (risk tiers, profiles, allowlists). */
  attachIntel(intel: PermissionIntel, planId?: string): void {
    this.intel = intel;
    this.intelPlanId = planId;
  }

  /** Detach Permission Intelligence (revert to tool-name-only decisions). */
  detachIntel(): void {
    this.intel = undefined;
    this.intelPlanId = undefined;
  }

  /** Whether Permission Intelligence is attached. */
  hasIntel(): boolean {
    return this.intel !== undefined;
  }

  /** Flag a tool as requiring explicit user approval (risk class M). */
  markDangerous(toolName: string): void {
    this.dangerous.add(toolName);
  }

  /** Remove the dangerous flag (e.g. a tool definition changed). */
  unmarkDangerous(toolName: string): void {
    this.dangerous.delete(toolName);
  }

  /** Whether the tool is flagged dangerous. */
  isDangerous(toolName: string): boolean {
    return this.dangerous.has(toolName);
  }

  /** Approve a dangerous tool for the rest of the session. */
  approve(toolName: string): void {
    this.approved.add(toolName);
  }

  /** Revoke a previous approval. */
  revoke(toolName: string): void {
    this.approved.delete(toolName);
  }

  /** Whether the tool currently holds a session approval. */
  isApproved(toolName: string): boolean {
    return this.approved.has(toolName);
  }

  /** Sorted dangerous tool names (for the policy/list surface). */
  dangerousTools(): string[] {
    return [...this.dangerous].sort();
  }

  /** Sorted approved tool names (for the policy/list surface). */
  approvedTools(): string[] {
    return [...this.approved].sort();
  }

  /**
   * Arg-aware evaluation (F7). When Permission Intelligence is attached and
   * classifies the call, its decision wins — except the base `deny` list,
   * which always wins. Unclassified calls fall back to evaluate(toolName),
   * so behavior is unchanged when no intel is attached.
   */
  evaluateCall(
    toolName: string,
    args: Record<string, unknown> = {},
    cwd: string = process.cwd(),
    ctx: Partial<PolicyContext> = {},
  ): PolicyDecision {
    // Deny always wins over allow — checked before everything.
    if (this.deny.has(toolName)) {
      return { allow: false, reason: `tool '${toolName}' is denied by policy` };
    }
    if (this.intel) {
      const r = this.intel.decide(toolName, args, {
        cwd,
        sessionId: 'default',
        principal: 'agent',
        ...ctx,
      }, this.intelPlanId);
      if (r.action) {
        if (r.decision === 'allow') return { allow: true };
        if (r.decision === 'deny') return { allow: false, reason: r.reason };
        // 'ask' is surfaced as a denial carrying approval-card info: the
        // loop feeds it back to the model as a tool error so it can adapt,
        // and the client can render the approval UI from `ask`.
        return {
          allow: false,
          reason: `${r.reason} — ask the user to approve it (one-time or a scoped always-allow), then call it again`,
          ask: { canonical: r.action.canonical, tier: r.action.tier, scopes: r.askScopes ?? [] },
        };
      }
    }
    return this.evaluate(toolName);
  }

  evaluate(toolName: string): PolicyDecision {
    if (this.deny.has(toolName)) {
      return { allow: false, reason: `tool '${toolName}' is denied by policy` };
    }
    // Risk class M: dangerous tools need explicit approval. `allow`
    // overrides and session approvals both satisfy the requirement.
    if (
      this.dangerous.has(toolName) &&
      !this.allow.has(toolName) &&
      !this.approved.has(toolName)
    ) {
      return {
        allow: false,
        reason:
          `tool '${toolName}' is dangerous (risk class M) and requires explicit user approval ` +
          `before it can run — ask the user to approve it, then call it again`,
      };
    }
    if (this.allow.has(toolName) || this.approved.has(toolName)) {
      return { allow: true };
    }
    switch (this.mode) {
      case 'deny-all':
        return { allow: false, reason: `policy mode is 'deny-all'` };
      case 'read-only':
        if (WRITE_TOOLS.has(toolName)) {
          return { allow: false, reason: `tool '${toolName}' mutates state; policy mode is 'read-only'` };
        }
        return { allow: true };
      default:
        return { allow: true };
    }
  }
}
