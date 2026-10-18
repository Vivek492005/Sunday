/**
 * Sunday bottom panel — terminal tabs.
 *
 * Renders standalone: `<Panel open onClose={...} />`
 * All tab sessions stay mounted (hidden) so shells survive tab switches;
 * closing a tab unmounts its Terminal, which kills that pty session.
 * The cwd for new terminals comes from the IDE store's rootFolder.
 */
import React, { useMemo, useState } from 'react';
import { useIde } from '../../state/ideStore';
import { Terminal } from './Terminal';
import './panel.css';

export interface PanelProps {
  open: boolean;
  onClose: () => void;
}

interface TermTab {
  id: string;
  label: string;
}

interface PanelState {
  tabs: TermTab[];
  activeId: string | null;
  /** ever-increasing so labels never repeat, even after closes */
  seq: number;
}

let termCounter = 0;

function makeTab(seq: number): TermTab {
  termCounter += 1;
  return { id: `sunday-term-${termCounter}`, label: `Terminal ${seq}` };
}

function initialPanelState(): PanelState {
  const tab = makeTab(1);
  return { tabs: [tab], activeId: tab.id, seq: 1 };
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function Panel({ open, onClose }: PanelProps) {
  const { state } = useIde();
  const [panel, setPanel] = useState<PanelState>(initialPanelState);

  // Renderer has no home-dir bridge (electron/ is owned elsewhere), so an
  // unset rootFolder passes '' and node-pty falls back to its default cwd.
  const cwd = useMemo(() => state.rootFolder ?? '', [state.rootFolder]);

  const newTab = (): void => {
    setPanel((p) => {
      const tab = makeTab(p.seq + 1);
      return { tabs: [...p.tabs, tab], activeId: tab.id, seq: p.seq + 1 };
    });
  };

  const closeTab = (id: string): void => {
    setPanel((p) => {
      const tabs = p.tabs.filter((t) => t.id !== id);
      const activeId =
        p.activeId === id ? (tabs[tabs.length - 1]?.id ?? null) : p.activeId;
      return { ...p, tabs, activeId };
    });
  };

  const selectTab = (id: string): void => {
    setPanel((p) => (p.activeId === id ? p : { ...p, activeId: id }));
  };

  return (
    <div
      className={`sunday-panel${open ? '' : ' sunday-panel-closed'}`}
      role="region"
      aria-label="Terminal panel"
    >
      <div className="sunday-panel-header">
        <span className="sunday-panel-title">Terminal</span>
        <span className="sunday-panel-hint" title="Keyboard shortcut to toggle the panel">
          <kbd>Ctrl</kbd>+<kbd>`</kbd>
        </span>
        <div className="sunday-panel-actions">
          <button
            type="button"
            className="sunday-icon-btn"
            onClick={newTab}
            title="New terminal"
            aria-label="New terminal"
          >
            <PlusIcon />
          </button>
          <button
            type="button"
            className="sunday-icon-btn"
            onClick={onClose}
            title="Close panel"
            aria-label="Close panel"
          >
            <CloseIcon />
          </button>
        </div>
      </div>

      <div className="sunday-panel-tabs" role="tablist" aria-label="Terminal sessions">
        {panel.tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === panel.activeId}
            className={`sunday-panel-tab${t.id === panel.activeId ? ' active' : ''}`}
            onClick={() => selectTab(t.id)}
            title={t.label}
          >
            <span className="sunday-panel-tab-label">{t.label}</span>
            <span
              className="sunday-panel-tab-close"
              role="button"
              aria-label={`Close ${t.label}`}
              title={`Close ${t.label}`}
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
            >
              <CloseIcon />
            </span>
          </button>
        ))}
        <button
          type="button"
          className="sunday-panel-newtab"
          onClick={newTab}
          title="New terminal"
          aria-label="New terminal"
        >
          <PlusIcon />
        </button>
      </div>

      <div className="sunday-panel-body">
        {panel.tabs.length === 0 ? (
          <div className="sunday-panel-empty">
            <p>No terminal sessions open.</p>
            <button type="button" className="sunday-btn" onClick={newTab}>
              New terminal
            </button>
          </div>
        ) : (
          panel.tabs.map((t) => (
            <div
              key={t.id}
              className="sunday-panel-term"
              style={{ display: t.id === panel.activeId ? 'flex' : 'none' }}
            >
              <Terminal id={t.id} cwd={cwd} active={t.id === panel.activeId && open} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
