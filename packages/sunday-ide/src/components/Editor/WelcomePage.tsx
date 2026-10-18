/**
 * Sunday welcome page — Sunday's own design (Phase 7 language):
 * "Your AI-native IDE." hero, open-folder CTA, recent folders, agent modes.
 */
import React from 'react';
import { useIde } from '../../state/ideStore';
import { fileService } from '../../services/fileService';
import { baseName } from '../../services/languageMap';
import { SunLogo } from '../icons';

const MODES = [
  { name: 'Auto', desc: 'Sunday picks the best strategy for your task.' },
  { name: 'Architect', desc: 'Plans before touching a single file.' },
  { name: 'Implementer', desc: 'Writes the code, runs the checks.' },
  { name: 'Reviewer', desc: 'Critiques diffs like a senior engineer.' },
];

export function WelcomePage() {
  const { state, dispatch } = useIde();

  const openFolder = async (folder?: string) => {
    try {
      const picked = folder ?? (await fileService.openFolder());
      if (!picked) return;
      dispatch({ type: 'SET_ROOT', folder: picked });
      dispatch({ type: 'ADD_RECENT', folder: picked });
      void fileService.watchStart(picked).catch(() => undefined);
      const branch = await fileService.gitBranch(picked).catch(() => null);
      dispatch({ type: 'SET_BRANCH', branch });
    } catch (err) {
      console.error('open folder failed', err);
    }
  };

  return (
    <div className="sunday-welcome">
      <div className="hero-logo">
        <SunLogo size={64} />
      </div>
      <h1>
        Sun<span>day</span>
      </h1>
      <p className="tagline">Your AI-native IDE.</p>

      <div className="cta-row">
        <button className="sunday-btn" onClick={() => void openFolder()}>
          Open Folder
        </button>
        <button
          className="sunday-btn ghost"
          onClick={() => window.dispatchEvent(new CustomEvent('sunday:new-file'))}
        >
          New File
        </button>
      </div>

      {state.recentFolders.length > 0 && (
        <div className="recent">
          <h3>RECENT</h3>
          {state.recentFolders.map((f) => (
            <button key={f} className="sunday-recent-item" onClick={() => void openFolder(f)} title={f}>
              <SunLogo size={14} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {baseName(f)}
              </span>
              <span style={{ color: 'var(--sunday-fg-faint)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {f}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="modes">
        {MODES.map((m) => (
          <div key={m.name} className="sunday-mode-card">
            <div className="mode-name">{m.name}</div>
            <div className="mode-desc">{m.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
