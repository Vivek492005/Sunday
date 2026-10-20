/**
 * LSP client — bridges a real Language Server to Monaco.
 *
 * Servers come from settings: `lspServers` = { "<languageId>": ["cmd", ...args] }
 * e.g. { "python": ["pyright-langserver", "--stdio"],
 *        "rust": ["rust-analyzer"],
 *        "typescript": ["typescript-language-server", "--stdio"] }
 *
 * Wired features: diagnostics (publishDiagnostics → Monaco markers),
 * hover, go-to-definition, completion. Full-text sync for simplicity.
 */
import { monaco } from './monacoSetup';

interface LspBridge {
  start(language: string, command: string, args: string[], cwd: string): Promise<{ ok: boolean; error?: string }>;
  send(language: string, json: string): Promise<boolean>;
  stop(language: string): Promise<void>;
  onMessage(cb: (info: { language: string; payload: string }) => void): () => void;
}

function bridge(): LspBridge | null {
  const b = (window as unknown as { sunday?: { lsp?: LspBridge } }).sunday;
  return b?.lsp ?? null;
}

interface LspServerConfig {
  command: string;
  args: string[];
}

const clients = new Map<string, LspClient>();
let serversConfig: Record<string, string[]> = {};
let rootPath = '';

export function configureLsp(servers: Record<string, string[]>, root: string): void {
  serversConfig = servers ?? {};
  rootPath = root;
}

export function lspConfigFor(languageId: string): LspServerConfig | null {
  const entry = serversConfig[languageId];
  if (!entry || entry.length === 0) return null;
  return { command: entry[0], args: entry.slice(1) };
}

/** Start the server for a language (idempotent) and register Monaco providers once. */
export async function ensureLspForLanguage(languageId: string): Promise<void> {
  if (clients.has(languageId)) return;
  const cfg = lspConfigFor(languageId);
  if (!cfg) return;
  const client = new LspClient(languageId, cfg);
  clients.set(languageId, client);
  await client.start();
}

/** Sync a model's content with its language server (didOpen on first call). */
export async function lspSyncDocument(languageId: string, model: monaco.editor.ITextModel): Promise<void> {
  const client = clients.get(languageId);
  if (!client) return;
  await client.syncDocument(model);
}

class LspClient {
  private id = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private versions = new Map<string, number>();
  private providersRegistered = false;
  private ready: Promise<void>;
  private resolveReady!: () => void;

  constructor(
    private language: string,
    private cfg: LspServerConfig,
  ) {
    this.ready = new Promise<void>((r) => {
      this.resolveReady = r;
    });
  }

  async start(): Promise<void> {
    const b = bridge();
    if (!b) return;
    const off = b.onMessage(({ language, payload }) => {
      if (language === this.language) this.onPayload(payload);
    });
    void off; // kept for process lifetime
    const res = await b.start(this.language, this.cfg.command, this.cfg.args, rootPath);
    if (!res.ok) {
      console.warn(`[lsp] ${this.language} server failed to start: ${res.error ?? 'unknown'}`);
      return;
    }
    const initResult = await this.request('initialize', {
      processId: null,
      rootUri: rootPath ? monaco.Uri.file(rootPath).toString() : null,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
          completion: { completionItem: { snippetSupport: true } },
          definition: {},
          publishDiagnostics: {},
          synchronization: { didSave: true },
        },
      },
      workspaceFolders: rootPath
        ? [{ uri: monaco.Uri.file(rootPath).toString(), name: rootPath.split(/[\\/]/).pop() ?? 'root' }]
        : null,
    }).catch(() => null);
    if (initResult !== null) {
      this.notify('initialized', {});
      this.registerProviders();
    }
    this.resolveReady();
  }

  private onPayload(payload: string): void {
    let msg: {
      id?: number;
      result?: unknown;
      error?: { message: string };
      method?: string;
      params?: { uri?: string; diagnostics?: LspDiagnostic[] };
    };
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics' && msg.params?.uri) {
      this.applyDiagnostics(msg.params.uri, msg.params.diagnostics ?? []);
    }
  }

  private applyDiagnostics(uri: string, diags: LspDiagnostic[]): void {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      `lsp-${this.language}`,
      diags.map((d) => ({
        severity:
          d.severity === 1
            ? monaco.MarkerSeverity.Error
            : d.severity === 2
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
        message: d.message,
        startLineNumber: d.range.start.line + 1,
        startColumn: d.range.start.character + 1,
        endLineNumber: d.range.end.line + 1,
        endColumn: d.range.end.character + 1,
        source: d.source,
      })),
    );
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const b = bridge();
    if (!b) throw new Error('no bridge');
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`lsp timeout: ${method}`));
      }, 15000);
      void b.send(this.language, JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  private notify(method: string, params: unknown): void {
    const b = bridge();
    if (!b) return;
    void b.send(this.language, JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  /** Call from EditorArea when a model of this language opens/changes. */
  async syncDocument(model: monaco.editor.ITextModel): Promise<void> {
    await this.ready;
    const uri = model.uri.toString();
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    if (version === 1) {
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: this.language, version, text: model.getValue() },
      });
    } else {
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text: model.getValue() }],
      });
    }
  }

  private registerProviders(): void {
    if (this.providersRegistered) return;
    this.providersRegistered = true;
    const lang = this.language;

    monaco.languages.registerHoverProvider(lang, {
      provideHover: async (model, position) => {
        try {
          const res = (await this.request('textDocument/hover', {
            textDocument: { uri: model.uri.toString() },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
          })) as { contents?: { kind?: string; value?: string } | { value?: string }[] } | null;
          if (!res?.contents) return null;
          const value = Array.isArray(res.contents)
            ? res.contents.map((c) => c.value ?? '').join('\n')
            : (res.contents.value ?? '');
          if (!value) return null;
          return { contents: [{ value }] };
        } catch {
          return null;
        }
      },
    });

    monaco.languages.registerDefinitionProvider(lang, {
      provideDefinition: async (model, position) => {
        try {
          const res = (await this.request('textDocument/definition', {
            textDocument: { uri: model.uri.toString() },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
          })) as { uri: string; range: LspRange } | { uri: string; range: LspRange }[] | null;
          if (!res) return null;
          const items = Array.isArray(res) ? res : [res];
          return items.map((loc) => ({
            uri: monaco.Uri.parse(loc.uri),
            range: new monaco.Range(
              loc.range.start.line + 1,
              loc.range.start.character + 1,
              loc.range.end.line + 1,
              loc.range.end.character + 1,
            ),
          }));
        } catch {
          return null;
        }
      },
    });

    monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: ['.', ':', '"', "'"],
      provideCompletionItems: async (model, position) => {
        try {
          const res = (await this.request('textDocument/completion', {
            textDocument: { uri: model.uri.toString() },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
          })) as { items?: LspCompletionItem[] } | LspCompletionItem[] | null;
          const items = Array.isArray(res) ? res : (res?.items ?? []);
          const word = model.getWordUntilPosition(position);
          const range = new monaco.Range(
            position.lineNumber,
            word.startColumn,
            position.lineNumber,
            word.endColumn,
          );
          return {
            suggestions: items.slice(0, 200).map((it) => ({
              label: it.label,
              kind: (it.kind ?? 6) as monaco.languages.CompletionItemKind,
              insertText: it.insertText ?? it.label,
              detail: it.detail,
              documentation: typeof it.documentation === 'string' ? it.documentation : it.documentation?.value,
              range,
            })),
          };
        } catch {
          return { suggestions: [] };
        }
      },
    });
  }
}

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}
interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  message: string;
  source?: string;
}
interface LspCompletionItem {
  label: string;
  kind?: number;
  insertText?: string;
  detail?: string;
  documentation?: string | { value: string };
}
