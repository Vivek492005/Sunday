/**
 * Sunday's own title bar — frameless window chrome.
 * Sun logo + wordmark, custom dropdown menus, custom window controls.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useIde } from '../state/ideStore';
import { fileService, windowControls } from '../services/fileService';
import { baseName } from '../services/languageMap';
import { SunLogo, MinIcon, MaxIcon, RestoreIcon, XIcon } from './icons';

interface MenuEntry {
  label: string;
  kbd?: string;
  action?: () => void;
  separator?: boolean;
}

export function TitleBar() {
  const { state, dispatch } = useIde();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  useEffect(() => {
    void windowControls.isMaximized().then(setMaximized).catch(() => undefined);
  }, []);

  const openFolder = async () => {
    try {
      const folder = await fileService.openFolder();
      if (folder) {
        dispatch({ type: 'SET_ROOT', folder });
        dispatch({ type: 'ADD_RECENT', folder });
        void fileService.watchStart(folder).catch(() => undefined);
        const branch = await fileService.gitBranch(folder).catch(() => null);
        dispatch({ type: 'SET_BRANCH', branch });
      }
    } catch (err) {
      console.error('open folder failed', err);
    }
  };

  const saveActive = () => {
    window.dispatchEvent(new CustomEvent('sunday:save-active'));
  };

  const menus: Record<string, MenuEntry[]> = {
    File: [
      { label: 'Open Folder…', kbd: 'Ctrl+O', action: () => void openFolder() },
      { label: 'New File', kbd: 'Ctrl+N', action: () => window.dispatchEvent(new CustomEvent('sunday:new-file')) },
      { separator: true, label: '' },
      { label: 'Save', kbd: 'Ctrl+S', action: saveActive },
      { separator: true, label: '' },
      { label: 'Close Window', action: () => void windowControls.close() },
    ],
    View: [
      { label: 'Toggle Sidebar', kbd: 'Ctrl+B', action: () => dispatch({ type: 'TOGGLE_SIDEBAR' }) },
      { label: 'Explorer', action: () => dispatch({ type: 'SET_RAIL_VIEW', view: 'explorer' }) },
    ],
    Help: [
      { label: 'About Sunday', action: () => window.dispatchEvent(new CustomEvent('sunday:about')) },
    ],
  };

  const toggleMax = async () => {
    await windowControls.maximize();
    const m = await windowControls.isMaximized().catch(() => false);
    setMaximized(m);
  };

  return (
    <div className="sunday-titlebar" ref={barRef}>
      <div className="brand">
        <SunLogo size={22} />
        <div className="wordmark">
          Sun<span>day</span>
        </div>
      </div>
      {state.rootFolder && <div className="folder-name">{baseName(state.rootFolder)}</div>}

      <div className="sunday-menus">
        {Object.keys(menus).map((name) => (
          <div key={name} className={`sunday-menu-item${openMenu === name ? ' open' : ''}`}>
            <button
              onClick={() => setOpenMenu(openMenu === name ? null : name)}
              onMouseEnter={() => openMenu && setOpenMenu(name)}
            >
              {name}
            </button>
            {openMenu === name && (
              <div className="sunday-menu-dropdown">
                {menus[name].map((entry, i) =>
                  entry.separator ? (
                    <hr key={i} />
                  ) : (
                    <button
                      key={i}
                      onClick={() => {
                        setOpenMenu(null);
                        entry.action?.();
                      }}
                    >
                      <span>{entry.label}</span>
                      {entry.kbd && <span className="kbd">{entry.kbd}</span>}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="sunday-window-controls">
        <button aria-label="Minimize" onClick={() => void windowControls.minimize()}>
          <MinIcon />
        </button>
        <button aria-label={maximized ? 'Restore' : 'Maximize'} onClick={() => void toggleMax()}>
          {maximized ? <RestoreIcon /> : <MaxIcon />}
        </button>
        <button aria-label="Close" className="close" onClick={() => void windowControls.close()}>
          <XIcon />
        </button>
      </div>
    </div>
  );
}
