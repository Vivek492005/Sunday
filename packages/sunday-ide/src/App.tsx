/**
 * Sunday IDE shell — 100% custom layout.
 * TitleBar / (ActivityRail + Sidebar + EditorArea) / Panel / StatusBar.
 * Command palette overlays everything. No VS Code workbench, no VS Code
 * CSS, no VS Code icons.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { IdeProvider, useIde } from './state/ideStore';
import { fileService } from './services/fileService';
import { settingsService, applySettings } from './services/settingsService';
import { registerCommand } from './services/commands';
import { TitleBar } from './components/TitleBar';
import { ActivityBar } from './components/ActivityBar';
import { Explorer } from './components/Sidebar/Explorer';
import { Search } from './components/Sidebar/Search';
import { SourceControl } from './components/Sidebar/SourceControl';
import { Extensions } from './components/Sidebar/Extensions';
import { Debug } from './components/Sidebar/Debug';
import { SettingsModal } from './components/Settings/SettingsModal';
import { ImportModal } from './components/Import/ImportModal';
import { AgentPanel } from './components/Agent/AgentPanel';
import { OpsView } from './components/Ops/OpsView';
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

  // Wave 3: load persisted settings once and apply (theme + editor options).
  useEffect(() => {
    void settingsService
      .get()
      .then(applySettings)
      .catch(() => undefined);
  }, []);

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
      id: 'sunday.viewSource',
      title: 'View: Source Control',
      run: () => dispatch({ type: 'SET_RAIL_VIEW', view: 'source' }),
    });
    registerCommand({
      id: 'sunday.viewExtensions',
      title: 'View: Extensions',
      run: () => dispatch({ type: 'SET_RAIL_VIEW', view: 'extensions' }),
    });
    registerCommand({
      id: 'sunday.viewDebug',
      title: 'View: Run & Debug',
      run: () => dispatch({ type: 'SET_RAIL_VIEW', view: 'debug' }),
    });
    registerCommand({
      id: 'sunday.viewOps',
      title: 'View: Sunday Ops',
      run: () => dispatch({ type: 'SET_RAIL_VIEW', view: 'ops' }),
    });
    registerCommand({
      id: 'sunday.opsRouting',
      title: 'Sunday: Open Ops > Routing (F3)',
      run: () => dispatch({ type: 'SET_RAIL_VIEW', view: 'ops' }),
    });
    registerCommand({
      id: 'sunday.opsSessions',
      title: 'Sunday: Open Ops > Sessions (F6)',
      run: () => dispatch({ type: 'SET_RAIL_VIEW', view: 'ops' }),
    });
    registerCommand({
      id: 'sunday.opsPermissions',
      title: 'Sunday: Open Ops > Permissions (F7)',
      run: () => dispatch({ type: 'SET_RAIL_VIEW', view: 'ops' }),
    });
    registerCommand({
      id: 'sunday.opsHooks',
      title: 'Sunday: Open Ops > Hooks (F8)',
      run: () => dispatch({ type: 'SET_RAIL_VIEW', view: 'ops' }),
    });
    registerCommand({
      id: 'sunday.opsEvidence',
      title: 'Sunday: Open Ops > Evidence (F9)',
      run: () => dispatch({ type: 'SET_RAIL_VIEW', view: 'ops' }),
    });
    registerCommand({
      id: 'sunday.opsSecurity',
      title: 'Sunday: Open Ops > Security (F10)',
      run: () => dispatch({ type: 'SET_RAIL_VIEW', view: 'ops' }),
    });
    registerCommand({
      id: 'sunday.opsBrowser',
      title: 'Sunday: Open Ops > Browser (F11)',
      run: () => dispatch({ type: 'SET_RAIL_VIEW', view: 'ops' }),
    });
    registerCommand({
      id: 'sunday.opsScoreboard',
      title: 'Sunday: Open Ops > Scoreboard (F12)',
      run: () => dispatch({ type: 'SET_RAIL_VIEW', view: 'ops' }),
    });
    registerCommand({
      id: 'sunday.openSettings',
      title: 'Open Settings',
      hint: 'Ctrl+,',
      run: () => dispatch({ type: 'SET_SETTINGS_OPEN', open: true }),
    });
    registerCommand({
      id: 'sunday.importFromTools',
      title: 'Sunday: Import from other tools',
      hint: 'Claude · Cursor · VS Code',
      run: () => dispatch({ type: 'SET_IMPORT_OPEN', open: true }),
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
      } else if (key === ',') {
        e.preventDefault();
        dispatch({ type: 'SET_SETTINGS_OPEN', open: true });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch, openFolder]);

  // TitleBar menu event router — every menu item must do something real.
  useEffect(() => {
    const on = (name: string, fn: () => void) => {
      const h = () => fn();
      window.addEventListener(name, h);
      return () => window.removeEventListener(name, h);
    };
    const offs = [
      on('sunday:show-palette', () => setPaletteOpen(true)),
      on('sunday:toggle-terminal', () => setPanelOpen((v) => !v)),
      on('sunday:show-settings', () => dispatch({ type: 'SET_SETTINGS_OPEN', open: true })),
      on('sunday:show-import', () => dispatch({ type: 'SET_IMPORT_OPEN', open: true })),
      on('sunday:show-agent', () => dispatch({ type: 'SET_RAIL_VIEW', view: 'agent' })),
      on('sunday:about', () =>
        window.alert('Sunday IDE 2.0\n100% Sunday interface — VS Code organs, Sunday skin.\nWaves 1–3 + F1–F15 built in.'),
      ),
    ];
    return () => offs.forEach((off) => off());
  }, [dispatch]);

  return (
    <div className="sunday-app">
      <TitleBar />
      <div className="sunday-body">
        <ActivityBar />
        <div className={`sunday-sidebar${state.sidebarVisible ? '' : ' hidden'}`}>
          {state.railView === 'explorer' && <Explorer />}
          {state.railView === 'search' && <Search />}
          {state.railView === 'source' && <SourceControl />}
          {state.railView === 'agent' && <AgentPanel />}
          {state.railView === 'extensions' && <Extensions />}
          {state.railView === 'debug' && <Debug />}
          {state.railView === 'ops' && <OpsView />}
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
      <SettingsModal />
      <ImportModal />
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
