/**
 * Sunday IDE shell — 100% custom layout.
 * TitleBar / (ActivityRail + Sidebar + EditorArea) / Panel / StatusBar.
 * Command palette overlays everything. No VS Code workbench, no VS Code
 * CSS, no VS Code icons.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { IdeProvider, useIde } from './state/ideStore';
import { fileService } from './services/fileService';
import { registerCommand } from './services/commands';
import { TitleBar } from './components/TitleBar';
import { ActivityBar } from './components/ActivityBar';
import { Explorer } from './components/Sidebar/Explorer';
import { Search } from './components/Sidebar/Search';
import { AgentPanel } from './components/Agent/AgentPanel';
import { EditorArea } from './components/Editor/EditorArea';
import { Panel } from './components/Panel/Panel';
import { CommandPalette } from './components/CommandPalette';
import { StatusBar } from './components/StatusBar';
import './theme/sunday.css';

function Shell() {
  const { state, dispatch } = useIde();
  const [panelOpen, setPanelOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const openFolder = useCallback(async () => {
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
  }, [dispatch]);

  // Register palette commands once.
  useEffect(() => {
    registerCommand({
      id: 'sunday.openFolder',
      title: 'Open Folder…',
      hint: 'Ctrl+O',
      run: () => void openFolder(),
    });
    registerCommand({
      id: 'sunday.toggleSidebar',
      title: 'Toggle Sidebar',
      hint: 'Ctrl+B',
      run: () => dispatch({ type: 'TOGGLE_SIDEBAR' }),
    });
    registerCommand({
      id: 'sunday.togglePanel',
      title: 'Toggle Terminal Panel',
      hint: 'Ctrl+`',
      run: () => setPanelOpen((v) => !v),
    });
    registerCommand({
      id: 'sunday.viewExplorer',
      title: 'View: Explorer',
      run: () => dispatch({ type: 'SET_RAIL_VIEW', view: 'explorer' }),
    });
    registerCommand({
      id: 'sunday.viewSearch',
      title: 'View: Search',
      run: () => dispatch({ type: 'SET_RAIL_VIEW', view: 'search' }),
    });
    registerCommand({
      id: 'sunday.viewAgent',
      title: 'View: Sunday Agent',
      run: () => dispatch({ type: 'SET_RAIL_VIEW', view: 'agent' }),
    });
    registerCommand({
      id: 'sunday.commandPalette',
      title: 'Show Command Palette…',
      hint: 'Ctrl+Shift+P',
      run: () => setPaletteOpen(true),
    });
  }, [dispatch, openFolder]);

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'o') {
        e.preventDefault();
        void openFolder();
      } else if (key === 'b') {
        e.preventDefault();
        dispatch({ type: 'TOGGLE_SIDEBAR' });
      } else if (key === '`') {
        e.preventDefault();
        setPanelOpen((v) => !v);
      } else if (key === 'p' && e.shiftKey) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch, openFolder]);

  return (
    <div className="sunday-app">
      <TitleBar />
      <div className="sunday-body">
        <ActivityBar />
        <div className={`sunday-sidebar${state.sidebarVisible ? '' : ' hidden'}`}>
          {state.railView === 'explorer' && <Explorer />}
          {state.railView === 'search' && <Search />}
          {state.railView === 'agent' && <AgentPanel />}
        </div>
        <EditorArea />
      </div>
      {panelOpen && (
        <div className="sunday-panel-wrap">
          <Panel open={panelOpen} onClose={() => setPanelOpen(false)} />
        </div>
      )}
      <StatusBar />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

export function App() {
  return (
    <IdeProvider>
      <Shell />
    </IdeProvider>
  );
}
