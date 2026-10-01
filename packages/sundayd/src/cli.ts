#!/usr/bin/env node
import { SundayDaemon } from './daemon.js';
import { createContextHandlers } from '@sunday/context';

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

const daemon = new SundayDaemon({
  contextHandlers: {
    'context/map': bindPerCall('context/map'),
    'context/index': bindPerCall('context/index'),
    'context/search': bindPerCall('context/search'),
  },
});
daemon.start().catch((e) => {
  console.error(`sundayd failed to start: ${(e as Error).message}`);
  process.exit(1);
});
