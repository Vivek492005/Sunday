/**
 * Sunday IDE global UI state — plain React context + reducer.
 * Owns: open folder, open tabs, active file, sidebar visibility,
 * cursor position, git branch. Editor content lives in Monaco models.
 */
import React, { createContext, useContext, useMemo, useReducer } from 'react';
import { baseName, languageForFile } from '../services/languageMap';

export interface OpenFile {
  path: string;
  name: string;
  language: string;
  dirty: boolean;
}

export type RailView = 'explorer' | 'search' | 'source' | 'agent' | 'missions' | 'extensions' | 'debug' | 'ops';

interface IdeState {
  rootFolder: string | null;
  openFiles: OpenFile[];
  activePath: string | null;
  railView: RailView;
  sidebarVisible: boolean;
  branch: string | null;
  cursor: { line: number; column: number };
  recentFolders: string[];
  settingsOpen: boolean;
  importOpen: boolean;
}

type Action =
  | { type: 'SET_ROOT'; folder: string | null }
  | { type: 'OPEN_FILE'; path: string }
  | { type: 'CLOSE_FILE'; path: string }
  | { type: 'SET_ACTIVE'; path: string | null }
  | { type: 'SET_DIRTY'; path: string; dirty: boolean }
  | { type: 'RENAME_FILE'; oldPath: string; newPath: string }
  | { type: 'SET_RAIL_VIEW'; view: RailView }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'SET_BRANCH'; branch: string | null }
  | { type: 'SET_CURSOR'; line: number; column: number }
  | { type: 'ADD_RECENT'; folder: string }
  | { type: 'SET_SETTINGS_OPEN'; open: boolean }
  | { type: 'SET_IMPORT_OPEN'; open: boolean };

const initialState: IdeState = {
  rootFolder: null,
  openFiles: [],
  activePath: null,
  railView: 'explorer',
  sidebarVisible: true,
  branch: null,
  cursor: { line: 1, column: 1 },
  recentFolders: loadRecent(),
  settingsOpen: false,
  importOpen: false,
};

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem('sunday.recentFolders');
    if (raw) return JSON.parse(raw) as string[];
  } catch {
    // corrupted storage — start fresh
  }
  return [];
}

function persistRecent(folders: string[]): void {
  try {
    localStorage.setItem('sunday.recentFolders', JSON.stringify(folders.slice(0, 8)));
  } catch {
    // storage full/blocked — non-fatal
  }
}

function reducer(state: IdeState, action: Action): IdeState {
  switch (action.type) {
    case 'SET_ROOT':
      return { ...state, rootFolder: action.folder, branch: null };
    case 'OPEN_FILE': {
      const exists = state.openFiles.some((f) => f.path === action.path);
      const files = exists
        ? state.openFiles
        : [
            ...state.openFiles,
            {
              path: action.path,
              name: baseName(action.path),
              language: languageForFile(action.path),
              dirty: false,
            },
          ];
      return { ...state, openFiles: files, activePath: action.path };
    }
    case 'CLOSE_FILE': {
      const files = state.openFiles.filter((f) => f.path !== action.path);
      const activePath =
        state.activePath === action.path
          ? (files[files.length - 1]?.path ?? null)
          : state.activePath;
      return { ...state, openFiles: files, activePath };
    }
    case 'SET_ACTIVE':
      return { ...state, activePath: action.path };
    case 'SET_DIRTY':
      return {
        ...state,
        openFiles: state.openFiles.map((f) =>
          f.path === action.path ? { ...f, dirty: action.dirty } : f,
        ),
      };
    case 'RENAME_FILE':
      return {
        ...state,
        openFiles: state.openFiles.map((f) =>
          f.path === action.oldPath
            ? {
                ...f,
                path: action.newPath,
                name: baseName(action.newPath),
                language: languageForFile(action.newPath),
              }
            : f,
        ),
        activePath: state.activePath === action.oldPath ? action.newPath : state.activePath,
      };
    case 'SET_RAIL_VIEW':
      return { ...state, railView: action.view, sidebarVisible: true };
    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarVisible: !state.sidebarVisible };
    case 'SET_BRANCH':
      return { ...state, branch: action.branch };
    case 'SET_CURSOR':
      return { ...state, cursor: { line: action.line, column: action.column } };
    case 'SET_SETTINGS_OPEN':
      return { ...state, settingsOpen: action.open };
    case 'SET_IMPORT_OPEN':
      return { ...state, importOpen: action.open };
    case 'ADD_RECENT': {
      const folders = [action.folder, ...state.recentFolders.filter((f) => f !== action.folder)].slice(0, 8);
      persistRecent(folders);
      return { ...state, recentFolders: folders };
    }
    default:
      return state;
  }
}

const IdeContext = createContext<{ state: IdeState; dispatch: React.Dispatch<Action> } | null>(null);

export function IdeProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <IdeContext.Provider value={value}>{children}</IdeContext.Provider>;
}

export function useIde(): { state: IdeState; dispatch: React.Dispatch<Action> } {
  const ctx = useContext(IdeContext);
  if (!ctx) throw new Error('useIde must be used inside IdeProvider');
  return ctx;
}
