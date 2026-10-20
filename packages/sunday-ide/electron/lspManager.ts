/**
 * LSP server manager — spawns language servers (user-configured commands,
 * e.g. pyright-langserver, rust-analyzer, typescript-language-server) and
 * relays Content-Length framed JSON-RPC between them and the renderer.
 *
 * Safety: circuit breaker per language (max 3 spawns/60s), 10MB frame cap,
 * servers are killed on stop/exit. A dead server never affects the IDE.
 */
import { spawn, type ChildProcess } from 'node:child_process';

interface ServerProc {
  proc: ChildProcess;
  buffer: Buffer;
}

const servers = new Map<string, ServerProc>();
const spawnAttempts = new Map<string, number[]>();
let messageListener: ((language: string, payload: string) => void) | null = null;

export function setLspMessageListener(fn: (language: string, payload: string) => void): void {
  messageListener = fn;
}

function spawnAllowed(language: string): boolean {
  const now = Date.now();
  const list = (spawnAttempts.get(language) ?? []).filter((t) => now - t < 60_000);
  spawnAttempts.set(language, list);
  return list.length < 3;
}

const MAX_FRAME = 10 * 1024 * 1024;

function frame(msg: string): string {
  return `Content-Length: ${Buffer.byteLength(msg, 'utf-8')}\r\n\r\n${msg}`;
}

export function startLspServer(language: string, command: string, args: string[], cwd: string): { ok: boolean; error?: string } {
  if (servers.has(language)) return { ok: true };
  if (!spawnAllowed(language)) {
    return { ok: false, error: `language server for ${language} crashed repeatedly — circuit breaker (restart Sunday)` };
  }
  (spawnAttempts.get(language) ?? []).push(Date.now());
  try {
    const proc = spawn(command, args, {
      cwd: cwd || undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      shell: false,
    });
    const entry: ServerProc = { proc, buffer: Buffer.alloc(0) };
    servers.set(language, entry);
    proc.stdout.on('data', (chunk: Buffer) => {
      entry.buffer = Buffer.concat([entry.buffer, chunk]);
      // Parse Content-Length framed messages; cap runaway buffers.
      for (;;) {
        const headerEnd = entry.buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) break;
        const header = entry.buffer.subarray(0, headerEnd).toString('utf-8');
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        if (!m) {
          entry.buffer = Buffer.alloc(0);
          break;
        }
        const len = parseInt(m[1], 10);
        if (len > MAX_FRAME) {
          entry.buffer = Buffer.alloc(0);
          break;
        }
        const start = headerEnd + 4;
        if (entry.buffer.length < start + len) break;
        const payload = entry.buffer.subarray(start, start + len).toString('utf-8');
        entry.buffer = entry.buffer.subarray(start + len);
        messageListener?.(language, payload);
      }
      if (entry.buffer.length > MAX_FRAME) entry.buffer = Buffer.alloc(0);
    });
    proc.stderr.on('data', () => {
      // server logs — ignored in normal operation
    });
    proc.on('exit', () => {
      if (servers.get(language) === entry) servers.delete(language);
    });
    proc.on('error', () => {
      if (servers.get(language) === entry) servers.delete(language);
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function sendLspMessage(language: string, json: string): boolean {
  const entry = servers.get(language);
  if (!entry?.proc.stdin) return false;
  entry.proc.stdin.write(frame(json));
  return true;
}

export function stopLspServer(language: string): void {
  const entry = servers.get(language);
  if (!entry) return;
  servers.delete(language);
  try {
    entry.proc.kill();
  } catch {
    // already dead
  }
}

export function stopAllLspServers(): void {
  for (const lang of [...servers.keys()]) stopLspServer(lang);
}
