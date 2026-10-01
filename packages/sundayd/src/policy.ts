/** Policy gate (§9.6): decides whether the agent may execute a tool call.
 *  Denied calls are NOT silent — the loop feeds the denial back to the model
 *  as a tool error so it can adapt, and the daemon surface exposes
 *  ErrorCode.PolicyDenied for client-initiated calls. */
import { READ_ONLY_TOOLS, WRITE_TOOLS } from '@sunday/tools';

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
}

export type PolicyDecision = { allow: true } | { allow: false; reason: string };

export class PolicyGate {
  private readonly mode: PolicyMode;
  private readonly allow: Set<string>;
  private readonly deny: Set<string>;

  constructor(opts: PolicyOptions = {}) {
    this.mode = opts.mode ?? 'allow-all';
    this.allow = new Set(opts.allow ?? []);
    this.deny = new Set(opts.deny ?? []);
  }

  evaluate(toolName: string): PolicyDecision {
    if (this.deny.has(toolName)) {
      return { allow: false, reason: `tool '${toolName}' is denied by policy` };
    }
    if (this.allow.has(toolName)) {
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
