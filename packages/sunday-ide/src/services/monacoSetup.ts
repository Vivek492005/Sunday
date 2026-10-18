/**
 * Monaco editor bootstrap for Sunday IDE.
 * Monaco is used ONLY as the text-editing engine — the surrounding UI is
 * 100% Sunday's own. Defines the `sunday-dark` editor theme from Sunday tokens.
 */
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

let themeDefined = false;

export function ensureSundayTheme(): void {
  if (themeDefined) return;
  themeDefined = true;
  monaco.editor.defineTheme('sunday-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '8a7a5c', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'f5b942' },
      { token: 'string', foreground: 'a8c98a' },
      { token: 'number', foreground: 'e08a5c' },
      { token: 'type', foreground: '7cc9c9' },
    ],
    colors: {
      'editor.background': '#1a1611',
      'editor.foreground': '#e8e0d0',
      'editor.lineHighlightBackground': '#221c1433',
      'editorLineNumber.foreground': '#5c4f38',
      'editorLineNumber.activeForeground': '#f5b942',
      'editorCursor.foreground': '#f5b942',
      'editor.selectionBackground': '#4a3d2855',
      'editor.inactiveSelectionBackground': '#4a3d2833',
      'editorIndentGuide.background1': '#33291a',
      'editorIndentGuide.activeBackground1': '#4a3d28',
      'editorWidget.background': '#262016',
      'editorWidget.border': '#4a3d28',
      'editorSuggestWidget.selectedBackground': '#4a3d28',
      'editorGutter.background': '#1a1611',
      'scrollbarSlider.background': '#3a2f1e88',
      'scrollbarSlider.hoverBackground': '#4a3d28aa',
      'minimap.background': '#1a1611',
    },
  });
}

export { monaco };
