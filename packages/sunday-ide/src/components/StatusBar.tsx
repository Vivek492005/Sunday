/**
 * Sunday status bar — signature yellow bar per the Sunday Dark theme.
 * Branch, cursor position, language, and the Sunday mark.
 */
import React from 'react';
import { useIde } from '../state/ideStore';
import { baseName } from '../services/languageMap';
import { BranchIcon } from './icons';

export function StatusBar() {
  const { state } = useIde();
  const activeFile = state.openFiles.find((f) => f.path === state.activePath);

  return (
    <div className="sunday-statusbar">
      <span className="sb-item" title={state.rootFolder ?? 'No folder open'}>
        {state.rootFolder ? baseName(state.rootFolder) : 'Sunday'}
      </span>
      {state.branch && (
        <span className="sb-item" title="Git branch">
          <BranchIcon size={13} />
          {state.branch}
        </span>
      )}
      <div className="sb-right">
        {activeFile && (
          <span className="sb-item">
            Ln {state.cursor.line}, Col {state.cursor.column}
          </span>
        )}
        {activeFile && <span className="sb-item">{activeFile.language}</span>}
        <span className="sb-item">UTF-8</span>
        <span className="sb-item sb-sun">☀ Sunday</span>
      </div>
    </div>
  );
}
