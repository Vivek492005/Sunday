/**
 * Memory service (renderer) — typed access to the `window.sunday.memory`
 * bridge (electron/memoryService.ts in the main process, over the real
 * @sunday/skills MemoryStore at ~/.sunday/memory/memories.jsonl).
 *
 * Follows the bridge() pattern from opsService.ts. Errors are NOT swallowed:
 * a SecretRefusedError from the store (secret-looking text) must reach the
 * panel verbatim so the user sees exactly why a save was refused.
 */

export interface MemoryRecordOut {
  id: string;
  text: string;
  /** Save time, ISO 8601 UTC. */
  timestamp: string;
  project: string;
  tags: string[];
  source: 'auto' | 'manual';
}

export interface SaveMemoryInput {
  text: string;
  tags?: string[];
}

interface MemoryBridge {
  list(limit?: number): Promise<MemoryRecordOut[]>;
  search(query: string, limit?: number): Promise<MemoryRecordOut[]>;
  save(input: SaveMemoryInput): Promise<MemoryRecordOut>;
  remove(id: string): Promise<boolean>;
}

function memoryBridge(): MemoryBridge {
  const api = (window as unknown as { sunday?: { memory?: MemoryBridge } }).sunday;
  if (!api?.memory) {
    throw new Error(
      'Sunday bridge unavailable — the Sunday IDE renderer must run inside the Electron shell (`pnpm dev`).',
    );
  }
  return api.memory;
}

export const memoryService = {
  /** Newest-first listing (main process caps the page size). */
  list: (limit = 100): Promise<MemoryRecordOut[]> => memoryBridge().list(limit),
  /** Keyword search over memory text + tags; newest-first on ties. */
  search: (query: string, limit = 50): Promise<MemoryRecordOut[]> =>
    memoryBridge().search(query, limit),
  /** Save a manual memory. Rejects with the store's real error (e.g. secret refusal). */
  save: (input: SaveMemoryInput): Promise<MemoryRecordOut> => memoryBridge().save(input),
  /** Delete by id; resolves true when a record was actually removed. */
  remove: (id: string): Promise<boolean> => memoryBridge().remove(id),
};
