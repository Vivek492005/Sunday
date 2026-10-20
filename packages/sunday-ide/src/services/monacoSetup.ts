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
  // Wave 3: light variant for the Sunday Light theme.
  monaco.editor.defineTheme('sunday-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '8a7a5c', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'b07818' },
      { token: 'string', foreground: '4a7a3a' },
      { token: 'number', foreground: 'b05c2a' },
      { token: 'type', foreground: '2a7a7a' },
    ],
    colors: {
      'editor.background': '#f7f2e8',
      'editor.foreground': '#2a2318',
      'editor.lineHighlightBackground': '#eadfc833',
      'editorLineNumber.foreground': '#a89a7c',
      'editorLineNumber.activeForeground': '#b07818',
      'editorCursor.foreground': '#b07818',
      'editor.selectionBackground': '#f5b94255',
      'editorIndentGuide.background1': '#e0d5bc',
      'editorWidget.background': '#fffdf7',
      'editorWidget.border': '#d8cba8',
      'editorGutter.background': '#f7f2e8',
      'minimap.background': '#f7f2e8',
    },
  });
}

let languageConfigured = false;

/**
 * Configure Monaco's built-in language services for VS Code-level editing:
 * - TypeScript/JavaScript: full IntelliSense, diagnostics, JSX, module resolution
 * - JSON: schema validation off by default (schemas added per-workspace later)
 * Called once at startup (from App / EditorArea mount).
 */
export function ensureLanguageServices(): void {
  if (languageConfigured) return;
  languageConfigured = true;

  const ts = monaco.languages.typescript;
  const compilerOptions: monaco.languages.typescript.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    checkJs: false,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    strict: false,
    noEmit: true,
    allowNonTsExtensions: true,
    resolveJsonModule: true,
    isolatedModules: true,
    skipLibCheck: true,
  };
  ts.typescriptDefaults.setCompilerOptions(compilerOptions);
  ts.javascriptDefaults.setCompilerOptions({ ...compilerOptions, checkJs: false });

  // Report ALL semantic + syntactic errors (real red squiggles like VS Code),
  // but don't demand a full program — suggestions stay enabled.
  const diagnostics: monaco.languages.typescript.DiagnosticsOptions = {
    noSemanticValidation: false,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: false,
    onlyVisible: false,
  };
  ts.typescriptDefaults.setDiagnosticsOptions(diagnostics);
  ts.javascriptDefaults.setDiagnosticsOptions({ ...diagnostics, noSemanticValidation: false });

  ts.typescriptDefaults.setEagerModelSync(true);
  ts.javascriptDefaults.setEagerModelSync(true);

  // JSON: allow comments + trailing commas off by default; keep validation on.
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: true,
    trailingCommas: 'error',
  });
}

export { monaco };
