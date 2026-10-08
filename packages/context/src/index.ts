// @sunday/context — repo map, code indexer and retrieval for the Sunday sidecar.
// Dependency-free: node builtins only. The JSON-RPC schemas for `context/*`
// live in @sunday/protocol (CONTEXT_METHODS); the handler table is wired
// into sundayd via dependency injection (DaemonOptions.contextHandlers).
export * from './repoMap.js';
export * from './indexer.js';
export * from './search.js';
export * from './handlers.js';
export * from './agents-md.js';
