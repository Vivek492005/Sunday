#!/usr/bin/env node
import { homedir } from 'node:os';
import { SundayDaemon } from './daemon.js';
import { createContextHandlers } from '@sunday/context';
import { registerManagerMethods } from './manager.js';
import { registerOrchestrationMethods } from '@sunday/orchestrator';
import { BrowserdManager } from './browserd.js';
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
      // The hub always loads the workspace config; the trust decision lives
      // in the extension, which prompts (Allow/Deny) before starting a
      // workspace-scope server in an untrusted workspace.
      workspaceTrusted: true,
      secretResolver: new EnvSecretResolver(),
    },
  });

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

  // Phase 5: hierarchical orchestration (Orchestrator → Feature Agents →
  // Verifier, sequential-only v1). The adapter keeps the package edge
  // one-directional: daemon.ts never imports @sunday/orchestrator (not even
  // its types); structural typing checks the host shape instead.
  registerOrchestrationMethods({
    addMethod: (name, handler) => daemon.registerMethod(name, handler),
    getOrchestratorHost: () => daemon.getOrchestratorHost(),
  });

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
