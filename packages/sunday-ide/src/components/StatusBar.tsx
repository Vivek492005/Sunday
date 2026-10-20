/**
 * Sunday status bar — signature yellow bar per the Sunday Dark theme.
 * Every item is actionable: folder → explorer, branch → source control,
 * cursor → go-to-line, language → palette, UTF-8 → encoding info.
 */
import React from 'react';
import { useIde } from '../state/ideStore';
import { baseName } from '../services/languageMap';
import { BranchIcon } from './icons';
import { UpdatePill } from './Update/UpdateDialog';
import { StreakPill, useStreakInfo } from './Streak/StreakPill';

export function StatusBar() {
  const { state, dispatch } = useIde();
  const activeFile = state.openFiles.find((f) => f.path === state.activePath);
  const streakInfo = useStreakInfo();

  const ev = (name: string, detail?: unknown) =>
    window.dispatchEvent(new CustomEvent(name, { detail }));

  return (
    <div className="sunday-statusbar">
      <button
        className="sb-item sb-btn"
        title={state.rootFolder ?? 'No folder open — click to open'}
        onClick={() => dispatch({ type: 'SET_RAIL_VIEW', view: 'explorer' })}
      >
        {state.rootFolder ? baseName(state.rootFolder) : 'Sunday'}
      </button>
      {state.branch && (
        <button
          className="sb-item sb-btn"
          title="Git branch — open Source Control"
          onClick={() => dispatch({ type: 'SET_RAIL_VIEW', view: 'source' })}
        >
          <BranchIcon size={13} />
          {state.branch}
        </button>
      )}
      <div className="sb-right">
        <StreakPill info={streakInfo} />
        <UpdatePill />
        {activeFile && (
          <button
            className="sb-item sb-btn"
            title="Go to Line…"
            onClick={() => ev('sunday:editor-goto-line')}
          >
            Ln {state.cursor.line}, Col {state.cursor.column}
          </button>
        )}
        {activeFile && (
          <button
            className="sb-item sb-btn"
            title="Change language mode"
            onClick={() => ev('sunday:show-palette', { query: 'language' })}
          >
            {activeFile.language}
          </button>
        )}
        <span className="sb-item" title="File encoding">
          UTF-8
        </span>
        <span className="sb-item sb-sun">☀ Sunday</span>
      </div>
    </div>
  );
}
