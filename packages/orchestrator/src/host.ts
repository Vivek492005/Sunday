import type { Router } from '@sunday/gateway';
import type { ToolRegistry } from '@sunday/tools';
import type { ChatEvent, OrchestrationEvent } from '@sunday/protocol';
import { createOrchestrationHandlers } from './handlers.js';

/**
 * One sub-agent turn, executed by the daemon on the orchestrator's behalf.
 *
 * This is the dependency-inversion seam (§9.9): the orchestrator coordinates
 * (plan → delegate → verify → merge) but never constructs an AgentLoop or a
 * session itself. The daemon implements this with its real AgentLoop +
 * SessionStore; tests inject an equivalent executor over a mock provider.
 * Either way this package imports NOTHING from @sunday/sundayd — not even
 * types — so the package edge stays one-directional (sundayd → orchestrator
 * would be a cycle: the daemon's cli wires the orchestrator in).
 */
export interface SubAgentRunOptions {
  /** Session title, e.g. `SUNDAY feature: <unit-id> — <title>`. */
  title: string;
  /** Working directory the sub-agent is confined to (the unit's worktree). */
  cwd: string;
  model?: string;
  /** System prompt establishing the sub-agent's role (coder / verifier). */
  systemPrompt: string;
  /** The user prompt for this turn (task contract or fix evidence). */
  prompt: string;
  /** Tool registry the sub-agent may use: the FULL catalogue for Feature
   *  Agents, a read-only scoped registry for Verifiers. */
  tools: ToolRegistry;
  maxIterations: number;
  signal?: AbortSignal;
  /** Streamed chat events (text-delta / turn-end / turn-error …). */
  onEvent: (event: ChatEvent) => void;
}

/**
 * Everything the orchestrator needs from the daemon. The daemon constructs
 * this once and hands it to `registerOrchestrationMethods` — the
 * orchestrator never reaches past this interface (in particular it never
 * touches the daemon's private dispatch table or transport directly).
 */
export interface OrchestratorHost {
  /** Model router (with Relay failover); the planner calls it directly. */
  router: Router;
  /** Full tool catalogue — handed ONLY to Feature Agents (role=coder). */
  tools: ToolRegistry;
  /** Default model ref when the plan doesn't name one. */
  defaultModel: string;
  /**
   * Dispatch into the daemon's own method table. Used for the verbatim
   * orchestration primitives: `worktree/add`, `worktree/merge`,
   * `worktree/remove`, `checkpoint/create`.
   */
  dispatch(method: string, params: unknown): Promise<unknown>;
  /** Emit `orchestrate/event` notifications to connected clients. */
  notify(event: OrchestrationEvent): void;
  /** Run one sub-agent turn (Feature Agent or Verifier). */
  runSubAgent(opts: SubAgentRunOptions): Promise<void>;
}

export type OrchestrationMethodHandler = (params: unknown) => Promise<unknown>;

/**
 * Structural interface the daemon must satisfy for
 * `registerOrchestrationMethods`. The parent wires the real daemon to this:
 * `addMethod` inserts into the daemon's dispatch table, and
 * `getOrchestratorHost` builds the host. Structural typing (not an import)
 * keeps the edge one-directional.
 */
export interface OrchestrationCapableDaemon {
  addMethod(name: string, handler: OrchestrationMethodHandler): void;
  getOrchestratorHost(): OrchestratorHost;
}

/**
 * Register `orchestrate/plan` + `orchestrate/run` on the daemon.
 * The parent calls this during daemon setup; cli.ts itself is not touched
 * by this package.
 */
export function registerOrchestrationMethods(daemon: OrchestrationCapableDaemon): void {
  const handlers = createOrchestrationHandlers(daemon.getOrchestratorHost());
  for (const [name, handler] of Object.entries(handlers)) {
    daemon.addMethod(name, handler);
  }
}
