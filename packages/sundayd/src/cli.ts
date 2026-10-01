#!/usr/bin/env node
import { homedir } from 'node:os';
import { SundayDaemon } from './daemon.js';
import { createContextHandlers } from '@sunday/context';
import { registerManagerMethods } from './manager.js';
import { registerOrchestrationMethods } from '@sunday/orchestrator';
import {
  setupOrchestrationPersistence,
  type OrchestrationPersistenceModule,
} from './orchestration-lifecycle.js';
import { BrowserdManager } from './browserd.js';
import { registerBrowserPanelMethods } from './browser-panel.js';
import { registerBrowserWalkthroughTools } from './browser-walkthrough.js';
import { EnvSecretResolver, createSundaydTools } from './agent-tools.js';
import { registerMcpMethods } from './mcp-methods.js';
import { isWorkspaceTrusted } from './trust.js';

// sundayd entrypoint: JSON-RPC over stdio. Logs go to stderr so the NDJSON
// frame stream on stdout stays clean.

// context/* methods take an explicit `workspaceRoot` per call (the same
// pattern as the session cwd that confines tools). Bind a fresh handler table
// per call so the daemon serves any workspace no matter where it was launched
// from — and on any drive (a single construction-time root could never cover
// that on Windows).
//
// Trust note: the requested root is the extension's explicit choice, exactly
// like the cwd accepted by `session/create`. The daemon and the extension run
// as the same user over local stdio — there is no privilege boundary between
// them. Model confinement stays at the tool layer (per-call session cwd),
// where it already is. If context/* is ever exposed to the model as tools,
// that wrapper must clamp workspaceRoot to the session cwd like tools do.
function bindPerCall<K extends 'context/map' | 'context/index' | 'context/search'>(method: K) {
  return (params: unknown): Promise<unknown> => {
    let root: string | undefined;
    if (typeof params === 'object' && params !== null) {
      const r = (params as Record<string, unknown>).workspaceRoot;
      if (typeof r === 'string' && r.length > 0) root = r;
    }
    const table = createContextHandlers(root);
    return table[method](params) as Promise<unknown>;
  };
}

async function main(): Promise<void> {
  // Part A: the daemon-level workspace (the extension stamps SUNDAY_WORKSPACE
  // at spawn; falls back to the process cwd). The MCP hub is daemon-global
  // and reads this workspace's .sunday/mcp.json; per-session tools
  // (load_skill, remember) and the system prompt use each session's own cwd.
  const workspaceDir = process.env.SUNDAY_WORKSPACE?.trim() || process.cwd();

  // Phase 6: browserd stays a lazy child process — it only spawns on first
  // browser_* tool use — and is stopped with the daemon (see gracefulExit).
  const browserdManager = new BrowserdManager({
    log: (msg) => console.error(`[browserd] ${msg}`),
  });

  // Part A: default tools + load_skill/tool_search/remember + McpHub +
  // approval-aware PolicyGate (shared instance with the daemon below).
  const agentTools = createSundaydTools({
    workspaceDir,
    userDir: homedir(),
    mcp: {
      // SEC-04: fail closed — the hub loads the workspace-scope mcp.json
      // only when the extension stamped SUNDAY_WORKSPACE_TRUSTED=1 at
      // spawn. The extension still prompts (Allow/Deny) before *starting*
      // a workspace-scope server.
      workspaceTrusted: isWorkspaceTrusted(),
      secretResolver: new EnvSecretResolver(),
    },
  });

  // Browser Agent UI phase: walkthrough artifact tool (markdown + screenshots).
  // Registered before the daemon so syncDangerousFlags picks up its dangerous flag.
  registerBrowserWalkthroughTools(agentTools.registry, browserdManager, { workspaceDir });

  const daemon = new SundayDaemon({
    tools: agentTools.registry,
    policyGate: agentTools.policy,
    userDir: homedir(),
    contextHandlers: {
      'context/map': bindPerCall('context/map'),
      'context/index': bindPerCall('context/index'),
      'context/search': bindPerCall('context/search'),
    },
    browserd: browserdManager,
  });

  // Phase 4: checkpoints + worktrees. Registered first — the orchestration
  // primitives (`worktree/*`, `checkpoint/*`) are consumed verbatim by Phase 5.
  registerManagerMethods(daemon);

  // Part A: mcp/* server lifecycle + policy/* approvals. The panel-visible
  // trust verdict is the daemon env verdict (SUNDAY_WORKSPACE_TRUSTED), not
  // the hub's always-true constructor flag (Design B').
  registerMcpMethods(daemon, agentTools.hub, agentTools.policy, {
    workspaceConfigPath: agentTools.workspaceConfigPath,
    workspaceTrusted: isWorkspaceTrusted(),
  });

  // Browser Agent UI phase: the Agent Browser panel (`browser/panel/*`).
  // Opt-in only — every handler returns a disabled error unless
  // SUNDAY_BROWSER_ENABLED=1 (set from the `sunday.browser.enabled` setting).
  registerBrowserPanelMethods(daemon, browserdManager);

  // Phase 5: hierarchical orchestration (Orchestrator → Feature Agents →
  // Verifier, sequential-only v1). The adapter keeps the package edge
  // one-directional: daemon.ts never imports @sunday/orchestrator (not even
  // its types); structural typing checks the host shape instead.
  registerOrchestrationMethods({
    addMethod: (name, handler) => daemon.registerMethod(name, handler),
    getOrchestratorHost: () => daemon.getOrchestratorHost(),
  });

  // Parallel Agents phase: durable run registry. The store +
  // reconcileOrchestrationRuns live in @sunday/orchestrator (Worker 1) and
  // are loaded dynamically so sundayd keeps building — and starting —
  // against an older orchestrator dist (persistence then degrades to a
  // logged warning instead of crashing the daemon). The store is not passed
  // into the handlers: Worker 1's registry is module-level and
  // getOrchestrationRunState falls back to the persisted file, so
  // stop/status/merge/resolveConflict work across restarts as-is.
  await setupOrchestrationPersistence(
    (await import('@sunday/orchestrator')) as unknown as OrchestrationPersistenceModule,
    (msg) => console.error(msg),
  );

  // MCP config load is additive — a failure is logged, never fatal.
  try {
    await agentTools.ready;
  } catch (e) {
    console.error(`[sundayd] MCP setup failed: ${(e as Error).message}`);
  }

  if (!isWorkspaceTrusted()) {
    console.error('[sundayd] workspace is not trusted: workspace skills with scripts are disabled until approved');
  }

  await daemon.start().catch((e) => {
    console.error(`sundayd failed to start: ${(e as Error).message}`);
    process.exit(1);
  });
}

void main();
