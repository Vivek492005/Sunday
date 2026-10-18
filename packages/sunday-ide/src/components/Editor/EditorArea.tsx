/**
 * Sunday editor area — custom tab bar + Monaco editing surface.
 * One Monaco view; models are cached per file. Dirty tracking via
 * content comparison against the last-saved snapshot.
 */
import React, { useEffect, useRef } from 'react';
import { useIde } from '../../state/ideStore';
import { fileService } from '../../services/fileService';
import { ensureSundayTheme, monaco } from '../../services/monacoSetup';
import { SETTINGS_APPLIED_EVENT, type SundaySettings } from '../../services/settingsService';
import {
  toggleBreakpoint,
  getBreakpoints,
  onBreakpointsChanged,
} from '../../services/debugService';
import { CloseIcon } from '../icons';
import { WelcomePage } from './WelcomePage';

interface ModelEntry {
  model: monaco.editor.ITextModel;
  savedContent: string;
}

export function EditorArea() {
  const { state, dispatch } = useIde();
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef<Map<string, ModelEntry>>(new Map());
  const saveHandlerRef = useRef<() => void>(() => undefined);
  const activePathRef = useRef<string | null>(null);
  const bpDecorationsRef = useRef<string[]>([]);

  // create the Monaco instance once
  useEffect(() => {
    if (!hostRef.current || editorRef.current) return;
    ensureSundayTheme();
    const editor = monaco.editor.create(hostRef.current, {
      theme: 'sunday-dark',
      automaticLayout: true,
      fontSize: 13.5,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', ui-monospace, Menlo, Consolas, monospace",
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      padding: { top: 12 },
      renderLineHighlight: 'all',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      glyphMargin: true, // Wave 3: breakpoint gutter
    });
    editorRef.current = editor;

    editor.onDidChangeModelContent(() => {
      const model = editor.getModel();
      if (!model) return;
      const entry = [...modelsRef.current.entries()].find(([, e]) => e.model === model);
      if (!entry) return;
      const [filePath, e] = entry;
      dispatch({ type: 'SET_DIRTY', path: filePath, dirty: model.getValue() !== e.savedContent });
    });

    editor.onDidChangeCursorPosition((ev) => {
      dispatch({ type: 'SET_CURSOR', line: ev.position.lineNumber, column: ev.position.column });
    });

    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveHandlerRef.current();
      }
    };
    window.addEventListener('keydown', onKey);

    // Wave 3: gutter click toggles breakpoints (debug service).
    const mouseDisp = editor.onMouseDown((ev) => {
      if (ev.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = ev.target.position?.lineNumber;
      const filePath = activePathRef.current;
      if (!line || !filePath) return;
      toggleBreakpoint(filePath, line);
    });

    // Wave 3: live-apply settings (theme + editor options).
    const onSettings = (ev: Event) => {
      const s = (ev as CustomEvent<SundaySettings>).detail;
      if (!s) return;
      editor.updateOptions({
        fontSize: s.editorFontSize,
        fontFamily: s.editorFontFamily,
        tabSize: s.editorTabSize,
        wordWrap: s.editorWordWrap ? 'on' : 'off',
      });
      monaco.editor.setTheme(s.theme === 'sunday-light' ? 'sunday-light' : 'sunday-dark');
    };
    window.addEventListener(SETTINGS_APPLIED_EVENT, onSettings);

    // Wave 3: debug panel asks us to reveal a breakpoint line.
    const onReveal = (ev: Event) => {
      const { line } = (ev as CustomEvent<{ filePath: string; line: number }>).detail ?? {};
      if (typeof line !== 'number') return;
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: 1 });
      editor.focus();
    };
    window.addEventListener('sunday:reveal-line', onReveal);

    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(SETTINGS_APPLIED_EVENT, onSettings);
      window.removeEventListener('sunday:reveal-line', onReveal);
      mouseDisp.dispose();
      modelsRef.current.forEach((e) => e.model.dispose());
      modelsRef.current.clear();
      editor.dispose();
      editorRef.current = null;
    };
  }, [dispatch]);

  // save handler (also triggered from the File menu)
  useEffect(() => {
    saveHandlerRef.current = () => {
      const path = state.activePath;
      const editor = editorRef.current;
      if (!path || !editor) return;
      const entry = modelsRef.current.get(path);
      if (!entry) return;
      const content = entry.model.getValue();
      fileService
        .writeFile(path, content)
        .then(() => {
          entry.savedContent = content;
          dispatch({ type: 'SET_DIRTY', path, dirty: false });
        })
        .catch((err) => console.error('save failed', err));
    };
    const onSaveEvent = () => saveHandlerRef.current();
    window.addEventListener('sunday:save-active', onSaveEvent);
    return () => window.removeEventListener('sunday:save-active', onSaveEvent);
  }, [state.activePath, dispatch]);

  // open the active file's model when tabs change
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const activePath = state.activePath;
    if (!activePath) {
      editor.setModel(null);
      return;
    }
    const openFile = state.openFiles.find((f) => f.path === activePath);
    if (!openFile) {
      editor.setModel(null);
      return;
    }
    const existing = modelsRef.current.get(activePath);
    if (existing) {
      if (editor.getModel() !== existing.model) {
        monaco.editor.setModelLanguage(existing.model, openFile.language);
        editor.setModel(existing.model);
      }
      return;
    }
    // first open: load content from disk
    fileService
      .readFile(activePath)
      .then(({ content, isBinary }) => {
        if (isBinary) {
          const model = monaco.editor.createModel(
            'This file looks binary and cannot be edited as text.',
            'plaintext',
          );
          modelsRef.current.set(activePath, { model, savedContent: model.getValue() });
          editor.setModel(model);
          return;
        }
        const uri = monaco.Uri.file(activePath);
        const model =
          monaco.editor.getModel(uri) ??
          monaco.editor.createModel(content, openFile.language, uri);
        modelsRef.current.set(activePath, { model, savedContent: content });
        editor.setModel(model);
      })
      .catch((err) => console.error('open failed', err));
  }, [state.activePath, state.openFiles]);

  // dispose models for closed tabs
  useEffect(() => {
    const open = new Set(state.openFiles.map((f) => f.path));
    for (const [path, entry] of modelsRef.current) {
      if (!open.has(path)) {
        if (editorRef.current?.getModel() === entry.model) editorRef.current.setModel(null);
        entry.model.dispose();
        modelsRef.current.delete(path);
      }
    }
  }, [state.openFiles]);

  // Wave 3: keep a ref of the active path for the gutter-click handler.
  useEffect(() => {
    activePathRef.current = state.activePath;
  }, [state.activePath]);

  // Wave 3: paint breakpoint gutter decorations for the active file.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const paint = () => {
      const ed = editorRef.current;
      const filePath = activePathRef.current;
      if (!ed || !filePath) return;
      const lines = getBreakpoints(filePath);
      bpDecorationsRef.current = ed.deltaDecorations(
        bpDecorationsRef.current,
        lines.map((line) => ({
          range: new monaco.Range(line, 1, line, 1),
          options: {
            isWholeLine: false,
            glyphMarginClassName: 'sunday-bp-glyph',
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        })),
      );
    };
    paint();
    return onBreakpointsChanged(paint);
  }, [state.activePath]);

  const closeTab = (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    const file = state.openFiles.find((f) => f.path === path);
    if (file?.dirty && !window.confirm(`"${file.name}" has unsaved changes. Close anyway?`)) return;
    dispatch({ type: 'CLOSE_FILE', path });
  };

  const hasTabs = state.openFiles.length > 0;

  return (
    <div className="sunday-editor-area">
      {hasTabs && (
        <div className="sunday-tabs" role="tablist" aria-label="Open files">
          {state.openFiles.map((f) => (
            <div
              key={f.path}
              role="tab"
              aria-selected={state.activePath === f.path}
              className={`sunday-tab${state.activePath === f.path ? ' active' : ''}`}
              onClick={() => dispatch({ type: 'SET_ACTIVE', path: f.path })}
              title={f.path}
            >
              {f.dirty && <span className="dirty-dot" title="Unsaved changes" />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</span>
              <button
                className="tab-close"
                aria-label={`Close ${f.name}`}
                onClick={(e) => closeTab(e, f.path)}
              >
                <CloseIcon size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="sunday-editor-host">
        {/* Monaco host stays mounted so the editor instance survives tab/welcome switches */}
        <div className="monaco-host" ref={hostRef} style={{ display: hasTabs ? 'block' : 'none' }} />
        {!hasTabs && <WelcomePage />}
      </div>
    </div>
  );
}
