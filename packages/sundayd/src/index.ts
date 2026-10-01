// @sunday/sundayd — the Sunday sidecar daemon (§6.3).
export * from './transport.js';
export * from './sessions.js';
export * from './policy.js';
export * from './loop.js';
export * from './checkpoints.js';
export * from './worktrees.js';
export * from './manager.js';
export * from './daemon.js';
// Phase 6: browserd child-process manager + browser_* agent tools (§18).
// Opt-in: the host registers tools via registerBrowserTools(); the child
// spawns lazily on first tool use.
export * from './browserd.js';
export * from './browser-tools.js';
