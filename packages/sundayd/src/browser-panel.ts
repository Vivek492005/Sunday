// sundayd — `browser/panel/*` JSON-RPC methods (Browser Agent UI phase).
//
// The Agent Browser panel in the sunday-agent extension talks to these
// methods; each one fans out to the managed browserd child through
// BrowserdManager. Registered ONLY through registerBrowserPanelMethods() —
// they are NOT part of the default method table, so the browser stays off
// unless the host opts in (SUNDAY_BROWSER_ENABLED=1). Every handler checks
// isBrowserEnabled() first and returns a clear disabled error otherwise,
// mirroring registerBrowserTools() in browser-tools.ts.
//
// The panel methods are deliberately thin: the screencast frame cache, the
// takeover gate that fails agent action tools fast, and the allow-list all
// live in BrowserdManager / browser-tools.ts (Worker 1's surface).

import { z } from 'zod';
import { ErrorCode, parseParams } from '@sunday/protocol';
import { RpcError } from './transport.js';

/**
 * Structural subset of BrowserdManager needed by the panel methods.
 * Declared structurally — not imported from ./browserd.js — so this module
 * stays decoupled from Worker 1's in-progress surface.
 *
 * ADAPTATION (Worker 1's actual surface, verified 2026-10-01): the
 * contract's `ensureRunning/open/close/screenshot` passthrough names do not
 * exist on BrowserdManager. This interface uses what does exist instead:
 * - `ensureRunning()` → `ensureReady()` (same "start if needed" semantics)
 * - `open(url)` → `rpc('browser/open', { url })`
 * - `close()` → `rpc('browser/close', {})`
 * - `screenshot()` → `rpc('browser/screenshot', {})` (returns `{ png }`)
 * The screencast/takeover names (`startScreencast/stopScreencast/
 * latestFrame/takeover/releaseControl/controlState`) match Worker 1
 * exactly. Passthrough results are normalized defensively at runtime below.
 */
export interface BrowserPanelManager {
  isBrowserEnabled(): boolean;
  ensureReady(): Promise<unknown>;
  rpc(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  startScreencast(): Promise<void>;
  stopScreencast(): Promise<void>;
  latestFrame(): Promise<unknown>;
  /** Returns the new control state on Worker 1's surface. */
  takeover(): Promise<unknown>;
  releaseControl(): Promise<unknown>;
  controlState(): 'agent' | 'user' | Promise<'agent' | 'user'>;
}

/** Structural shape of the sundayd Daemon surface this module needs. */
export interface BrowserPanelDaemon {
  registerMethod(name: string, handler: (params: unknown) => Promise<unknown>): void;
}

const DISABLED_MESSAGE = 'browser is disabled (set sunday.browser.enabled to true)';

function disabledError(): RpcError {
  // A caller error, not a daemon bug — same posture as toRpcError() in
  // mcp-methods.ts for unknown/disabled servers.
  return new RpcError(ErrorCode.InvalidParams, DISABLED_MESSAGE);
}

function requireEnabled(manager: BrowserPanelManager): void {
  if (!manager.isBrowserEnabled()) throw disabledError();
}

function toRpcError(e: unknown): RpcError {
  if (e instanceof RpcError) return e;
  if (e instanceof z.ZodError) {
    return new RpcError(ErrorCode.InvalidParams, `invalid params: ${e.issues.map((i) => i.message).join('; ')}`);
  }
  return new RpcError(ErrorCode.InternalError, e instanceof Error ? e.message : String(e));
}

interface OpenResult {
  ok: boolean;
  url?: string;
  title?: string;
  needsApproval?: boolean;
  origin?: string;
}

/** Normalize the `open` passthrough into the `browser/panel/open` schema. */
function normalizeOpen(result: unknown): OpenResult {
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    const out: OpenResult = { ok: r.ok === true };
    if (typeof r.url === 'string') out.url = r.url;
    if (typeof r.title === 'string') out.title = r.title;
    if (typeof r.needsApproval === 'boolean') out.needsApproval = r.needsApproval;
    if (typeof r.origin === 'string') out.origin = r.origin;
    return out;
  }
  return { ok: false };
}

/** Normalize `latestFrame()` into the `{ data }` schema: accepts either a
 *  raw base64 string or a `{ data }` envelope. */
function normalizeFrame(result: unknown): string | null {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const d = (result as Record<string, unknown>).data;
    return typeof d === 'string' ? d : null;
  }
  return null;
}

/** Normalize `screenshot()` into a base64 PNG string. Accepts the browserd
 *  `{ png }` shape, a `{ data }` envelope, or a raw base64 string. */
function normalizeScreenshot(result: unknown): string {
  if (typeof result === 'string' && result.length > 0) return result;
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    for (const key of ['png', 'data']) {
      const v = r[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  throw new RpcError(ErrorCode.InternalError, 'browserd returned an empty screenshot');
}

export function registerBrowserPanelMethods(daemon: BrowserPanelDaemon, manager: BrowserPanelManager): void {
  const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
    'browser/panel/ensure': async (params) => {
      try {
        parseParams('browser/panel/ensure', params);
        requireEnabled(manager);
        await manager.ensureReady();
        return { ok: true as const };
      } catch (e) {
        throw toRpcError(e);
      }
    },

    'browser/panel/open': async (params) => {
      try {
        const { url } = parseParams('browser/panel/open', params);
        requireEnabled(manager);
        await manager.ensureReady();
        return normalizeOpen(await manager.rpc('browser/open', { url }));
      } catch (e) {
        throw toRpcError(e);
      }
    },

    'browser/panel/frame': async (params) => {
      try {
        parseParams('browser/panel/frame', params);
        requireEnabled(manager);
        await manager.ensureReady();
        // Idempotent on the browserd side: the first call starts the
        // screencast, later calls are a no-op.
        await manager.startScreencast();
        return { data: normalizeFrame(await manager.latestFrame()) };
      } catch (e) {
        throw toRpcError(e);
      }
    },

    'browser/panel/takeover': async (params) => {
      try {
        parseParams('browser/panel/takeover', params);
        requireEnabled(manager);
        await manager.ensureReady();
        await manager.takeover();
        return { control: 'user' as const };
      } catch (e) {
        throw toRpcError(e);
      }
    },

    'browser/panel/release': async (params) => {
      try {
        parseParams('browser/panel/release', params);
        requireEnabled(manager);
        await manager.ensureReady();
        await manager.releaseControl();
        return { control: 'agent' as const };
      } catch (e) {
        throw toRpcError(e);
      }
    },

    'browser/panel/control': async (params) => {
      try {
        parseParams('browser/panel/control', params);
        requireEnabled(manager);
        return { control: await manager.controlState() };
      } catch (e) {
        throw toRpcError(e);
      }
    },

    'browser/panel/screenshot': async (params) => {
      try {
        parseParams('browser/panel/screenshot', params);
        requireEnabled(manager);
        await manager.ensureReady();
        return { data: normalizeScreenshot(await manager.rpc('browser/screenshot', {})) };
      } catch (e) {
        throw toRpcError(e);
      }
    },

    'browser/panel/close': async (params) => {
      try {
        parseParams('browser/panel/close', params);
        requireEnabled(manager);
        // Best effort: a close with no screencast running must not fail.
        try {
          await manager.stopScreencast();
        } catch {
          /* no screencast to stop */
        }
        await manager.rpc('browser/close', {});
        return { ok: true as const };
      } catch (e) {
        throw toRpcError(e);
      }
    },
  };

  for (const [method, handler] of Object.entries(handlers)) {
    daemon.registerMethod(method, handler);
  }
}
