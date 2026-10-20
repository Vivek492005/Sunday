/**
 * Sunday's own title bar — frameless window chrome.
 * Sun logo + wordmark, custom dropdown menus, custom window controls.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useIde } from '../state/ideStore';
import { fileService, windowControls } from '../services/fileService';
import { baseName } from '../services/languageMap';
import { SunLogo, MinIcon, MaxIcon, RestoreIcon, XIcon } from './icons';
import { AccountChip } from './Account/AccountChip';

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

  const ev = (name: string) => () => window.dispatchEvent(new CustomEvent(name));

  const menus: Record<string, MenuEntry[]> = {
    File: [
      { label: 'New File', kbd: 'Ctrl+N', action: ev('sunday:new-file') },
      { separator: true, label: '' },
      { label: 'Open File…', action: ev('sunday:open-file') },
      { label: 'Open Folder…', kbd: 'Ctrl+O', action: () => void openFolder() },
      { separator: true, label: '' },
      { label: 'Save', kbd: 'Ctrl+S', action: saveActive },
      { label: 'Save As…', action: ev('sunday:save-as') },
      { separator: true, label: '' },
      { label: 'Import from Claude / Cursor / VS Code…', action: ev('sunday:show-import') },
      { separator: true, label: '' },
      { label: 'Close Window', action: () => void windowControls.close() },
    ],
    Edit: [
      { label: 'Find', kbd: 'Ctrl+F', action: ev('sunday:editor-find') },
      { label: 'Replace', kbd: 'Ctrl+H', action: ev('sunday:editor-replace') },
      { separator: true, label: '' },
      { label: 'Command Palette', kbd: 'Ctrl+Shift+P', action: ev('sunday:show-palette') },
    ],
    View: [
      { label: 'Toggle Sidebar', kbd: 'Ctrl+B', action: () => dispatch({ type: 'TOGGLE_SIDEBAR' }) },
      { separator: true, label: '' },
      { label: 'Explorer', kbd: 'Ctrl+Shift+E', action: () => dispatch({ type: 'SET_RAIL_VIEW', view: 'explorer' }) },
      { label: 'Search', kbd: 'Ctrl+Shift+F', action: () => dispatch({ type: 'SET_RAIL_VIEW', view: 'search' }) },
      { label: 'Source Control', kbd: 'Ctrl+Shift+G', action: () => dispatch({ type: 'SET_RAIL_VIEW', view: 'source' }) },
      { label: 'Agent', action: () => dispatch({ type: 'SET_RAIL_VIEW', view: 'agent' }) },
      { label: 'Mission Control', action: () => dispatch({ type: 'SET_RAIL_VIEW', view: 'missions' }) },
      { label: 'Extensions', kbd: 'Ctrl+Shift+X', action: () => dispatch({ type: 'SET_RAIL_VIEW', view: 'extensions' }) },
      { label: 'Debug', action: () => dispatch({ type: 'SET_RAIL_VIEW', view: 'debug' }) },
      { label: 'Sunday Ops', action: () => dispatch({ type: 'SET_RAIL_VIEW', view: 'ops' }) },
      { separator: true, label: '' },
      { label: 'Toggle Terminal', kbd: 'Ctrl+`', action: ev('sunday:toggle-terminal') },
      { label: 'Settings', kbd: 'Ctrl+,', action: ev('sunday:show-settings') },
    ],
    Help: [
      { label: 'About Sunday', action: ev('sunday:about') },
      { label: 'Sunday on GitHub', action: () => void window.open('https://github.com/Vivek492005/Sunday', '_blank') },
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

      <AccountChip />

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
