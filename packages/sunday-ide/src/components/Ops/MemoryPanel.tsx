/**
 * Memory Panel — the Second Brain store, visible (Sunday Ops).
 *
 * Reads/writes the REAL @sunday/skills MemoryStore via the memory bridge:
 * records live at ~/.sunday/memory/memories.jsonl. Search is debounced
 * (empty query = newest-first list). Adding a memory goes through the
 * store's secret scan — a SecretRefusedError is shown verbatim, never
 * hidden or paraphrased, because the refusal IS the feedback.
 *
 * Styling reuses the Ops classes from ops.css.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { memoryService, type MemoryRecordOut } from '../../services/memoryService';

const SEARCH_DEBOUNCE_MS = 250;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function savedLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function MemoryPanel() {
  const [memories, setMemories] = useState<MemoryRecordOut[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [saving, setSaving] = useState(false);
  /** Id currently in its inline "Sure?" delete-confirm state, or null. */
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(async (q: string): Promise<void> => {
    try {
      const rows = q.trim() ? await memoryService.search(q.trim()) : await memoryService.list();
      setMemories(rows);
    } catch (e) {
      setError(errText(e));
      setMemories((prev) => prev ?? []);
    }
  }, []);

  /* Debounced search: every keystroke restarts the timer; cleanup on
     unmount and on each change keeps at most one query in flight per pause. */
  useEffect(() => {
    const t = window.setTimeout(() => {
      void load(query);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query, load]);

  const save = useCallback(async () => {
    const clean = text.trim();
    if (!clean) {
      setError('Write the memory text first — empty memories are refused by the store.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const tags = tagsText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      await memoryService.save({ text: clean, tags });
      setText('');
      setTagsText('');
      setConfirmId(null);
      await load(query);
    } catch (e) {
      // Verbatim on purpose — includes the store's secret-refusal message.
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  }, [text, tagsText, query, load]);

  const remove = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await memoryService.remove(id);
        setConfirmId(null);
        await load(query);
      } catch (e) {
        setError(errText(e));
      }
    },
    [query, load],
  );

  return (
    <div className="ops-panel">
      <div className="ops-section">
        <h4>Add a memory</h4>
        <textarea
          className="ops-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Something Sunday should remember long-term… (secrets are refused automatically)"
          rows={3}
          maxLength={4000}
        />
        <div className="ops-row">
          <input
            className="ops-input"
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder="Tags (optional, comma-separated) — e.g. decision, preference"
          />
          <button className="sunday-btn ops-btn" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save memory'}
          </button>
        </div>
      </div>

      <div className="ops-row">
        <input
          className="ops-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search memories…"
          aria-label="Search memories"
        />
      </div>

      {error && <div className="ops-error">{error}</div>}

      {memories === null ? (
        <div className="ops-loading">Loading memories…</div>
      ) : memories.length === 0 ? (
        <div className="ops-empty">
          {query.trim()
            ? `No memories match "${query.trim()}".`
            : 'No memories yet. Sunday saves long-term memories here (~/.sunday/memory) — add your first one above.'}
        </div>
      ) : (
        <div className="ops-section">
          {memories.map((m) => (
            <div key={m.id} className="ops-result">
              <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.text}</div>
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
              >
                <span className="ops-chip">{m.project}</span>
                {m.tags.map((t) => (
                  <span key={t} className="ops-chip ok">
                    {t}
                  </span>
                ))}
                <span className="dim">{savedLabel(m.timestamp)}</span>
                <span className="dim">· {m.source}</span>
                {confirmId === m.id ? (
                  <button
                    className="ops-link"
                    style={{ color: 'var(--sunday-danger)' }}
                    title="Click again to permanently delete this memory"
                    onClick={() => void remove(m.id)}
                  >
                    Sure?
                  </button>
                ) : (
                  <button
                    className="ops-link"
                    title="Delete this memory"
                    onClick={() => setConfirmId(m.id)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="ops-note">
        Stored as JSONL at <span className="mono">~/.sunday/memory/memories.jsonl</span> by the real
        Second Brain store (@sunday/skills). Every save is scanned for secrets first — anything that
        looks like a credential is refused and nothing is written.
      </div>
    </div>
  );
}
