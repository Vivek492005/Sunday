// @sunday/sundayd — the Sunday sidecar daemon (§6.3).
export * from './transport.js';
// Phase 8 Stage 1: shared NDJSON codec + socket server transport.
// (RpcError/RequestHandler/ServerTransport come via transport.js above;
// only the socket-specific names are re-exported here to avoid duplicates.)
export {
  SocketServerTransport,
  NdjsonFramer,
  encodeFrame,
  dispatchRequestLine,
  toErrorResponse,
} from './rpc-transport.js';
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
// Part A: Editor Intelligence — MCP hub + skills wiring.
export * from './trust.js';
export * from './system-prompt.js';
export * from './agent-tools.js';
export * from './mcp-methods.js';
// Parallel Agents phase: orchestration run persistence lifecycle (daemon setup).
export * from './orchestration-lifecycle.js';
