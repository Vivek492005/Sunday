/**
 * Minimal-but-real `vscode` API shim for the Sunday extension host.
 *
 * Extensions `require('vscode')` and get this object. Every call that needs
 * the IDE (messages, input boxes, status bar, editor state) is bridged to
 * the main process over JSON-RPC (the `bridge` function). Pure in-host APIs
 * (EventEmitter, Uri, Position, Range, Disposable...) are implemented here.
 *
 * Scope (honest): the most-used surface — commands, window messages/input,
 * output channels, configuration, workspace folders, document events,
 * status bar items, extensions registry. Monaco-bridged providers
 * (completion/hover) arrive with the LSP wave.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Bridge = (method: string, params?: any) => Promise<any>;

export class Disposable {
  private fn: (() => void) | undefined;
  constructor(fn?: () => void) {
    this.fn = fn;
  }
  dispose(): void {
    try {
      this.fn?.();
    } catch {
      /* ignore */
    }
    this.fn = undefined;
  }
  static from(...items: { dispose(): void }[]): Disposable {
    return new Disposable(() => items.forEach((i) => i.dispose()));
  }
}

export class EventEmitter<T = unknown> {
  private listeners = new Set<(e: T) => void>();
  event = (listener: (e: T) => void): Disposable => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };
  fire(data: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(data);
      } catch {
        /* listener errors must not kill the host */
      }
    }
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class Uri {
  private constructor(
    public readonly scheme: string,
    public readonly path: string,
    public readonly fsPath: string,
  ) {}
  static file(p: string): Uri {
    return new Uri('file', p, p);
  }
  static parse(s: string): Uri {
    const m = s.match(/^([a-z]+):\/\/(.*)$/i);
    if (m) return new Uri(m[1], m[2], m[2]);
    return new Uri('file', s, s);
  }
  toString(): string {
    return `${this.scheme}://${this.path}`;
  }
}

export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

export class Range {
  public readonly start: Position;
  public readonly end: Position;
  constructor(start: Position | number, end: Position | number, endLine?: number, endChar?: number) {
    if (typeof start === 'number' && typeof end === 'number') {
      this.start = new Position(start, end);
      this.end = new Position(endLine ?? start, endChar ?? end);
    } else {
      this.start = start as Position;
      this.end = end as Position;
    }
  }
}

export class Selection extends Range {}

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 } as const;
export const TextEditorRevealType = { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 } as const;

class OutputChannel {
  private lines: string[] = [];
  constructor(
    public readonly name: string,
    private bridge: Bridge,
  ) {}
  append(v: string): void {
    this.lines.push(v);
    if (this.lines.length > 5000) this.lines.splice(0, 1000); // cap memory
    void this.bridge('window.outputAppend', { name: this.name, value: v }).catch(() => undefined);
  }
  appendLine(v: string): void {
    this.append(v + '\n');
  }
  clear(): void {
    this.lines = [];
    void this.bridge('window.outputClear', { name: this.name }).catch(() => undefined);
  }
  show(): void {
    void this.bridge('window.outputShow', { name: this.name }).catch(() => undefined);
  }
  hide(): void {}
  dispose(): void {}
}

class StatusBarItem {
  text = '';
  tooltip: string | undefined;
  command: string | undefined;
  constructor(
    public readonly id: string,
    private bridge: Bridge,
  ) {}
  show(): void {
    void this.bridge('window.statusBar', { id: this.id, text: this.text, tooltip: this.tooltip }).catch(
      () => undefined,
    );
  }
  hide(): void {
    void this.bridge('window.statusBar', { id: this.id, text: '' }).catch(() => undefined);
  }
  dispose(): void {
    this.hide();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createVscodeApi(bridge: Bridge, extensionContext: any): any {
  const commandsRegistry = new Map<string, (...args: unknown[]) => unknown>();
  (globalThis as Record<string, unknown>).__sundayCommands = commandsRegistry;

  const docChangeEmitter = new EventEmitter();
  (globalThis as Record<string, unknown>).__sundayDocChange = docChangeEmitter;

  const api = {
    Disposable,
    EventEmitter,
    Uri,
    Position,
    Range,
    Selection,
    StatusBarAlignment,
    ViewColumn,
    TextEditorRevealType,
    version: '1.85.0', // API-compat claim: extensions gate on this
    env: {
      appName: 'Sunday',
      language: 'en',
      machineId: 'sunday-local',
      sessionId: 'sunday-session',
      openExternal: (uri: Uri) => bridge('env.openExternal', { uri: uri.toString() }),
      clipboard: {
        writeText: (t: string) => bridge('env.clipboardWrite', { text: t }),
        readText: () => bridge('env.clipboardRead', {}),
      },
    },
    commands: {
      registerCommand(id: string, fn: (...args: unknown[]) => unknown): Disposable {
        commandsRegistry.set(id, fn);
        void bridge('commands.registered', { id, extensionId: extensionContext?.extension?.id }).catch(
          () => undefined,
        );
        return new Disposable(() => commandsRegistry.delete(id));
      },
      registerTextEditorCommand(id: string, fn: (...args: unknown[]) => unknown): Disposable {
        return api.commands.registerCommand(id, fn);
      },
      async executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
        const local = commandsRegistry.get(id);
        if (local) return local(...args);
        return bridge('commands.execute', { id, args });
      },
      getCommands: async (_filterInternal?: boolean) => [...commandsRegistry.keys()],
    },
    window: {
      showInformationMessage: (msg: string, ...items: string[]) =>
        bridge('window.showMessage', { kind: 'info', message: String(msg), items }),
      showWarningMessage: (msg: string, ...items: string[]) =>
        bridge('window.showMessage', { kind: 'warn', message: String(msg), items }),
      showErrorMessage: (msg: string, ...items: string[]) =>
        bridge('window.showMessage', { kind: 'error', message: String(msg), items }),
      showInputBox: (options?: { prompt?: string; placeHolder?: string; password?: boolean }) =>
        bridge('window.showInputBox', options ?? {}),
      showQuickPick: (items: unknown, options?: { placeHolder?: string }) =>
        bridge('window.showQuickPick', {
          items: (Array.isArray(items) ? items : []).map((i) =>
            typeof i === 'string' ? { label: i } : (i as { label: string }),
          ),
          options: options ?? {},
        }).then((r: { label?: string } | undefined) => r),
      createOutputChannel: (name: string) => new OutputChannel(name, bridge),
      createStatusBarItem: (alignment = 1, priority?: number, id?: string) =>
        new StatusBarItem(id ?? `sb-${alignment}-${priority ?? 0}-${Math.random().toString(36).slice(2, 8)}`, bridge),
      get activeTextEditor() {
        return undefined; // bridged async-only APIs can't be sync; extensions use commands for edits
      },
      onDidChangeActiveTextEditor: (_listener: unknown) => new Disposable(),
      showTextDocument: (uri: Uri) => bridge('window.showTextDocument', { path: uri.fsPath }),
    },
    workspace: {
      get workspaceFolders() {
        const roots = (globalThis as Record<string, unknown>).__sundayRoots as string[] | undefined;
        return roots?.map((r, i) => ({ uri: Uri.file(r), name: r.split(/[\\/]/).pop() ?? r, index: i }));
      },
      getConfiguration(section?: string) {
        const cfg = ((globalThis as Record<string, unknown>).__sundayConfig as Record<string, unknown>) ?? {};
        const prefix = section ? `${section}.` : '';
        return {
          get: <T>(key: string, fallback?: T): T => {
            const v = cfg[prefix + key];
            return (v === undefined ? fallback : v) as T;
          },
          has: (key: string) => cfg[prefix + key] !== undefined,
          update: () => Promise.resolve(),
        };
      },
      onDidChangeTextDocument: docChangeEmitter.event,
      onDidOpenTextDocument: (_l: unknown) => new Disposable(),
      onDidCloseTextDocument: (_l: unknown) => new Disposable(),
      onDidSaveTextDocument: (_l: unknown) => new Disposable(),
      onDidChangeConfiguration: (_l: unknown) => new Disposable(),
      fs: {
        readFile: async (uri: Uri) => {
          const r = await bridge('fs.readFile', { path: uri.fsPath });
          return new TextEncoder().encode(r.content ?? '');
        },
        writeFile: async (uri: Uri, content: Uint8Array) => {
          await bridge('fs.writeFile', { path: uri.fsPath, content: new TextDecoder().decode(content) });
        },
      },
    },
    languages: {
      // Provider registration is bridged to Monaco in the LSP wave; accept and no-op honestly.
      registerCompletionItemProvider: () => new Disposable(),
      registerHoverProvider: () => new Disposable(),
      createDiagnosticCollection: (name: string) => ({
        name,
        set: () => undefined,
        clear: () => undefined,
        dispose: () => undefined,
      }),
    },
    extensions: {
      getExtension: (id: string) => {
        const all = (globalThis as Record<string, unknown>).__sundayExtensions as Map<string, unknown>;
        return all?.get(id);
      },
      get all() {
        const all = (globalThis as Record<string, unknown>).__sundayExtensions as Map<string, unknown>;
        return all ? [...all.values()] : [];
      },
    },
  };
  return api;
}
