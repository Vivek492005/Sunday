/**
 * Sunday Extension Host — runs inside an Electron process started with
 * `--sunday-extension-host` (see main.ts). Loads installed VS Code
 * extensions from ~/.sunday-ide/extensions/, gives them a real `vscode`
 * API (extHost/vscodeApi.ts), and speaks JSON-RPC over stdio with the
 * IDE main process.
 *
 * Safety: every activate() is wrapped — one bad extension can never kill
 * the host or the IDE. Activation timeout 15s per extension.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createVscodeApi, type Bridge } from './vscodeApi.js';

const require_ = createRequire(import.meta.url);

// ---------- stdio JSON-RPC (bidirectional) ----------
let rpcId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let buffer = '';

const bridge: Bridge = (method, params) =>
  new Promise((resolve, reject) => {
    const id = rpcId++;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`bridge timeout: ${method}`));
    }, 30000);
  });

function sendResult(id: number | string, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function sendError(id: number | string, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { message } }) + '\n');
}

// ---------- extension registry ----------
interface LoadedExtension {
  id: string;
  dir: string;
  manifest: Record<string, unknown>;
  active: boolean;
  error?: string;
}

const extensions = new Map<string, LoadedExtension>();
(globalThis as Record<string, unknown>).__sundayExtensions = extensions;

function extensionsRoot(): string {
  return path.join(os.homedir(), '.sunday-ide', 'extensions');
}

function makeMemento() {
  const m = new Map<string, unknown>();
  return {
    get(k: string, d?: unknown) {
      return m.get(k) ?? d;
    },
    update(k: string, v: unknown) {
      m.set(k, v);
      return Promise.resolve();
    },
    keys: () => [...m.keys()],
  };
}

function scanExtensions(): LoadedExtension[] {
  const root = extensionsRoot();
  const found: LoadedExtension[] = [];
  if (!fs.existsSync(root)) return found;
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    const pkgPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
      const id = `${String(manifest.publisher ?? 'unknown')}.${String(manifest.name ?? name)}`;
      found.push({ id, dir, manifest, active: false });
    } catch {
      // corrupt manifest — skip, never crash the host
    }
  }
  return found;
}

// Patch require('vscode') BEFORE loading any extension code.
const Module = require_('node:module') as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
let currentContext: Record<string, unknown> | null = null;
const origLoad = Module._load.bind(Module);
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'vscode') return createVscodeApi(bridge, currentContext);
  return origLoad(request, parent, isMain);
};

async function activateExtension(ext: LoadedExtension): Promise<void> {
  const mainRel = ext.manifest.main as string | undefined;
  if (!mainRel) {
    ext.error = 'no main entry (declarative-only extension)';
    return;
  }
  const mainPath = path.join(ext.dir, mainRel);
  if (!fs.existsSync(mainPath)) {
    ext.error = `main not found: ${mainRel}`;
    return;
  }
  const subscriptions: { dispose(): void }[] = [];
  currentContext = {
    extension: { id: ext.id },
    extensionPath: ext.dir,
    subscriptions,
    globalState: makeMemento(),
    workspaceState: makeMemento(),
  };
  try {
    const mod = require_(mainPath) as { activate?: (ctx: unknown) => Promise<void> | void };
    if (typeof mod.activate !== 'function') {
      ext.error = 'no activate() export';
      return;
    }
    await Promise.race([
      Promise.resolve(mod.activate(currentContext)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('activation timeout (15s)')), 15000)),
    ]);
    ext.active = true;
  } catch (e) {
    ext.error = e instanceof Error ? e.message : String(e);
  } finally {
    currentContext = null;
  }
}

// ---------- RPC handlers (from IDE main) ----------
const handlers: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
  'extHost/ping': async () => 'pong',
  'extHost/scan': async () => {
    for (const ext of scanExtensions()) {
      if (!extensions.has(ext.id)) extensions.set(ext.id, ext);
    }
    return [...extensions.values()].map((e) => ({
      id: e.id,
      active: e.active,
      error: e.error,
      displayName: e.manifest.displayName ?? e.manifest.name,
      version: e.manifest.version,
      commands: ((e.manifest.contributes as Record<string, unknown>)?.commands as { command: string; title: string }[]) ?? [],
    }));
  },
  'extHost/activateAll': async (params) => {
    (globalThis as Record<string, unknown>).__sundayRoots = params.roots ?? [];
    (globalThis as Record<string, unknown>).__sundayConfig = params.config ?? {};
    const results: Record<string, string> = {};
    for (const ext of extensions.values()) {
      if (!ext.active) await activateExtension(ext);
      results[ext.id] = ext.active ? 'active' : (ext.error ?? 'inactive');
    }
    return results;
  },
  'extHost/executeCommand': async (params) => {
    const registry = (globalThis as Record<string, unknown>).__sundayCommands as
      | Map<string, (...a: unknown[]) => unknown>
      | undefined;
    const fn = registry?.get(String(params.id));
    if (!fn) throw new Error(`command not found in extension host: ${String(params.id)}`);
    return fn(...((params.args as unknown[]) ?? []));
  },
};

// ---------- stdin loop ----------
process.stdin.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf-8');
  let idx: number;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method && msg.id !== undefined) {
      const h = handlers[msg.method];
      if (!h) {
        sendError(msg.id, `unknown method: ${msg.method}`);
        continue;
      }
      h(msg.params ?? {})
        .then((r) => sendResult(msg.id as number, r))
        .catch((e) => sendError(msg.id as number, e instanceof Error ? e.message : String(e)));
    } else if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
      const p = pending.get(msg.id as number);
      if (p) {
        pending.delete(msg.id as number);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    }
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
