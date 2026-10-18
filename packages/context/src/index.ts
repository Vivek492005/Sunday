// @sunday/context — repo map, code indexer and retrieval for the Sunday sidecar.
// Core (repoMap/indexer/search TF-IDF) is node-builtins only. F5 modules are
// additive: symbols.ts lazily loads tree-sitter WASM (graceful degradation
// when grammars are unavailable); embeddings.ts is local-only by default.
// The JSON-RPC schemas for `context/*` live in @sunday/protocol
// (CONTEXT_METHODS); the handler table is wired into sundayd via dependency
// injection (DaemonOptions.contextHandlers).
export * from './repoMap.js';
export * from './indexer.js';
export * from './search.js';
export * from './handlers.js';
export * from './agents-md.js';
export * from './style-infer.js';
export * from './symbols.js';
export * from './embeddings.js';
