/**
 * Sunday IDE shell — 100% custom layout.
 * TitleBar / (ActivityRail + Sidebar + EditorArea) / StatusBar.
 * No VS Code workbench, no VS Code CSS, no VS Code icons.
 */
import React, { useEffect } from 'react';
import { IdeProvider, useIde } from './state/ideStore';
import { fileService } from './services/fileService';
import { TitleBar } from './components/TitleBar';
import { ActivityBar } from './components/ActivityBar';
import { Explorer } from './components/Sidebar/Explorer';
import { EditorArea } from './components/Editor/EditorArea';
import { StatusBar } from './components/StatusBar';
import './theme/sunday.css';

function Shell() {
  const { state, dispatch } = useIde();

  // global shortcuts: Ctrl+O open folder, Ctrl+B toggle sidebar
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'o') {
        e.preventDefault();
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
      } else if (key === 'b') {
        e.preventDefault();
        dispatch({ type: 'TOGGLE_SIDEBAR' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch]);

  return (
    <div className="sunday-app">
      <TitleBar />
      <div className="sunday-body">
        <ActivityBar />
        <div className={`sunday-sidebar${state.sidebarVisible ? '' : ' hidden'}`}>
          {state.railView === 'explorer' && <Explorer />}
        </div>
        <EditorArea />
      </div>
      <StatusBar />
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
