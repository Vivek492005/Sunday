/**
 * Sunday IDE — memoryService.ts (Piece 3: Second Brain memory panel)
 *
 * Main-process wrapper over the REAL structured long-term memory store:
 * `MemoryStore` from @sunday/skills (packages/skills/src/second-brain.ts),
 * persisted as JSONL at ~/.sunday/memory/memories.jsonl.
 *
 * Unlike streaks (fire-and-forget telemetry), memory errors are
 * USER-ACTIONABLE and must surface honestly: a secret-looking text makes
 * MemoryStore.save() throw SecretRefusedError, and that refusal is shown
 * verbatim in the panel. So these functions deliberately do NOT swallow
 * errors — the IPC boundary turns a throw into a rejected promise, which
 * the renderer catches and displays. Nothing here can crash the IDE.
 */
import { MemoryStore, type LongTermMemory } from '@sunday/skills';

export type { LongTermMemory };

/** Hard cap on a single memory's text — the store is a second brain, not a dump. */
export const MAX_MEMORY_TEXT_CHARS = 4000;
/** Absolute ceiling for list/search page sizes, whatever the caller asks. */
const MAX_LIMIT = 500;
const MAX_TAGS = 10;
const MAX_TAG_CHARS = 40;

export interface SaveMemoryInput {
  text: string;
  tags?: string[];
}

export interface MemoryService {
  listMemories(limit?: number): Promise<LongTermMemory[]>;
  searchMemories(query: string, limit?: number): Promise<LongTermMemory[]>;
  saveMemory(input: SaveMemoryInput): Promise<LongTermMemory>;
  deleteMemory(id: string): Promise<boolean>;
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return fallback;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function cleanTags(tags: string[] | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const clean = t.trim().slice(0, MAX_TAG_CHARS);
    if (clean && !out.includes(clean)) out.push(clean);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * Build the service over a given store. Production uses the module
 * singleton below (default home dir); tests inject a MemoryStore pointed
 * at a temp homeDir.
 */
export function createMemoryService(store: MemoryStore): MemoryService {
  return {
    async listMemories(limit = 100): Promise<LongTermMemory[]> {
      return store.list({ limit: clampLimit(limit, 100) });
    },

    async searchMemories(query: string, limit = 50): Promise<LongTermMemory[]> {
      return store.search(typeof query === 'string' ? query : '', {
        limit: clampLimit(limit, 50),
      });
    },

    async saveMemory(input: SaveMemoryInput): Promise<LongTermMemory> {
      const text = typeof input?.text === 'string' ? input.text : '';
      if (text.length > MAX_MEMORY_TEXT_CHARS) {
        throw new Error(
          `Memory text is too long (${text.length} characters; max ${MAX_MEMORY_TEXT_CHARS}). ` +
            'Shorten it and save again — nothing was stored.',
        );
      }
      // Manual entries from the panel are global (not tied to a workspace).
      // SecretRefusedError from the store propagates to the caller verbatim.
      return store.save({
        text,
        project: 'global',
        tags: cleanTags(input?.tags),
        source: 'manual',
      });
    },

    async deleteMemory(id: string): Promise<boolean> {
      if (typeof id !== 'string' || id.length === 0) return false;
      return store.delete(id);
    },
  };
}

/** Production singleton — one MemoryStore for the whole main process. */
const singleton = createMemoryService(new MemoryStore());

export const listMemories: MemoryService['listMemories'] = singleton.listMemories;
export const searchMemories: MemoryService['searchMemories'] = singleton.searchMemories;
export const saveMemory: MemoryService['saveMemory'] = singleton.saveMemory;
export const deleteMemory: MemoryService['deleteMemory'] = singleton.deleteMemory;
