/**
 * Sunday's command palette — a centered overlay with its own backdrop.
 * Pure presentational component: it renders whatever the parent App has
 * registered via registerCommand(), filtered through fuzzyFilter().
 * Usage: <CommandPalette open={...} onClose={...} />
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import {
  fuzzyFilter,
  getCommands,
  matchTitleIndices,
  type SundayCommand,
} from '../services/commands';
import './palette.css';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

function HighlightedTitle({ title, query }: { title: string; query: string }) {
  const indices = matchTitleIndices(title, query);
  const hit = new Set(indices ?? []);
  return (
    <span className="sunday-palette-title">
      {title.split('').map((ch, i) =>
        hit.has(i) ? (
          <span key={i} className="sunday-palette-hl">
            {ch}
          </span>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </span>
  );
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeItemRef = useRef<HTMLButtonElement>(null);

  const commands = useMemo(() => getCommands(), [open]);
  const filtered = useMemo(() => fuzzyFilter(query, commands), [query, commands]);

  // Reset and auto-focus whenever the palette opens.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      const t = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  // Keep the selection inside bounds when the list shrinks.
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  // Keep the active item scrolled into view.
  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, filtered]);

  if (!open) return null;

  const runCommand = (cmd: SundayCommand) => {
    onClose();
    void Promise.resolve()
      .then(() => cmd.run())
      .catch((err: unknown) => {
        console.error(`command "${cmd.id}" failed`, err);
      });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (filtered.length === 0 ? 0 : (i + 1) % filtered.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) =>
        filtered.length === 0 ? 0 : (i - 1 + filtered.length) % filtered.length,
      );
    } else if (e.key === 'Enter') {
      const cmd = filtered[activeIndex];
      if (cmd) runCommand(cmd);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div
      className="sunday-palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sunday-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={inputRef}
          className="sunday-palette-input"
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Type a command…"
          aria-label="Command search"
        />
        <div className="sunday-palette-list" role="listbox">
          {filtered.length === 0 ? (
            <div className="sunday-palette-empty">No matching commands</div>
          ) : (
            filtered.map((cmd, i) => (
              <button
                key={cmd.id}
                ref={i === activeIndex ? activeItemRef : undefined}
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                className={`sunday-palette-item${i === activeIndex ? ' active' : ''}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => runCommand(cmd)}
              >
                <HighlightedTitle title={cmd.title} query={query} />
                {cmd.hint && <span className="sunday-palette-hint">{cmd.hint}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
