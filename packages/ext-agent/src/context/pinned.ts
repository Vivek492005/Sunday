// sunday-agent — F4 Context Cockpit: pinned facts store.
//
// Pinned facts ("never touch X", API decisions, constraints) are NEVER
// compacted, never dropped, and always re-injected ahead of the model.
// Pure, no vscode import. Unit-tested.

import type { PinnedFact } from './types.js';

let idCounter = 0;

function nextId(): string {
  idCounter += 1;
  return `pin-${Date.now()}-${idCounter}`;
}

/**
 * PinnedStore: pin/unpin/list facts. Persist via the injected store
 * (globalState wrapper); in-memory by default.
 */
export class PinnedStore {
  private facts = new Map<string, PinnedFact>();
  private persist?: (facts: PinnedFact[]) => void | Promise<void>;

  constructor(opts: { persist?: (facts: PinnedFact[]) => void | Promise<void> } = {}) {
    this.persist = opts.persist;
  }

  /** Pin a fact. Returns the created fact (with id). */
  pinFact(text: string, pinnedBy: 'user' | 'agent' = 'user'): PinnedFact {
    const t = text.trim();
    if (!t) throw new Error('Cannot pin an empty fact.');
    const fact: PinnedFact = { id: nextId(), text: t, pinnedBy, createdAt: Date.now() };
    this.facts.set(fact.id, fact);
    void this.save();
    return fact;
  }

  /** Remove a pin. Returns true when the id existed. */
  unpinFact(id: string): boolean {
    const ok = this.facts.delete(id);
    if (ok) void this.save();
    return ok;
  }

  /** All pinned facts, oldest first. */
  listPinned(): PinnedFact[] {
    return [...this.facts.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Load previously persisted facts (e.g. at activation). */
  load(facts: PinnedFact[]): void {
    this.facts.clear();
    for (const f of facts) this.facts.set(f.id, f);
  }

  /** Render pins as a context block injected ahead of the model. */
  renderPinnedBlock(): string {
    const facts = this.listPinned();
    if (facts.length === 0) return '';
    const lines = facts.map((f, i) => `${i + 1}. ${f.text}`);
    return `PINNED FACTS (never drop, never rewrite — these are hard constraints):\n${lines.join('\n')}`;
  }

  private save(): void {
    if (this.persist) {
      try {
        void this.persist(this.listPinned());
      } catch {
        // Persistence must never break pinning.
      }
    }
  }
}
