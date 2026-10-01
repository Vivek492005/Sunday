#!/usr/bin/env node
import { SundayDaemon } from './daemon.js';
import { createContextHandlers } from '@sunday/context';
import { registerManagerMethods } from './manager.js';
import { registerOrchestrationMethods } from '@sunday/orchestrator';
import { BrowserdManager } from './browserd.js';

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

// Phase 6: browserd stays a lazy child process — it only spawns on first
// browser_* tool use — and is stopped with the daemon (see gracefulExit).
const browserdManager = new BrowserdManager({
  log: (msg) => console.error(`[browserd] ${msg}`),
});

const daemon = new SundayDaemon({
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

// Phase 5: hierarchical orchestration (Orchestrator → Feature Agents →
// Verifier, sequential-only v1). The adapter keeps the package edge
// one-directional: daemon.ts never imports @sunday/orchestrator (not even
// its types); structural typing checks the host shape instead.
registerOrchestrationMethods({
  addMethod: (name, handler) => daemon.registerMethod(name, handler),
  getOrchestratorHost: () => daemon.getOrchestratorHost(),
});

daemon.start().catch((e) => {
  console.error(`sundayd failed to start: ${(e as Error).message}`);
  process.exit(1);
});
