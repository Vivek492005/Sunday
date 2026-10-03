// Phase 8 Stage 3: daemon/* + mcp/secrets/provide RPC dispatch tests.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequest } from '@sunday/protocol';
import { SundayDaemon } from './daemon.js';
import { workspaceTrust, isWorkspaceTrusted } from './trust.js';
import { workspaceSecrets } from './workspace-secrets.js';

function makeDaemon(opts: { onWorkspaceTrustChanged?: (root: string) => void } = {}): SundayDaemon {
  // handleRequest() dispatches directly without starting the transport, so
  // the default stdio transport is never started (safe in tests).
  return new SundayDaemon({
    onShutdown: () => undefined,
    onWorkspaceTrustChanged: opts.onWorkspaceTrustChanged,
  });
}

describe('daemon/configure + daemon/set-workspace-trust + daemon/status', () => {
  beforeEach(() => {
    workspaceTrust.clear();
    workspaceSecrets.clear();
  });
  afterEach(() => {
    workspaceTrust.clear();
    workspaceSecrets.clear();
  });

  it('daemon/configure records the workspace trust verdict', async () => {
    const daemon = makeDaemon();
    const ws = mkdtempSync(join(tmpdir(), 'ws-d-'));
    const res = (await daemon.handleRequest(
      createRequest('1', 'daemon/configure', { workspaceRoot: ws, trusted: true }),
    )) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(isWorkspaceTrusted(ws)).toBe(true);
  });

  it('daemon/set-workspace-trust updates the verdict and notifies', async () => {
    const seen: string[] = [];
    const daemon = makeDaemon({ onWorkspaceTrustChanged: (r) => seen.push(r) });
    const ws = mkdtempSync(join(tmpdir(), 'ws-d-'));
    const res = (await daemon.handleRequest(
      createRequest('1', 'daemon/set-workspace-trust', { workspaceRoot: ws, trusted: false }),
    )) as { ok: boolean; workspaceRoot: string };
    expect(res.ok).toBe(true);
    expect(isWorkspaceTrusted(ws)).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('daemon/status lists configured workspaces', async () => {
    const daemon = makeDaemon();
    const wsA = mkdtempSync(join(tmpdir(), 'ws-d-a-'));
    const wsB = mkdtempSync(join(tmpdir(), 'ws-d-b-'));
    await daemon.handleRequest(createRequest('1', 'daemon/configure', { workspaceRoot: wsA, trusted: true }));
    await daemon.handleRequest(createRequest('2', 'daemon/configure', { workspaceRoot: wsB, trusted: false }));
    const res = (await daemon.handleRequest(createRequest('3', 'daemon/status', {}))) as {
      workspaces: Array<{ root: string; trusted: boolean }>;
      multiWorkspace: boolean;
    };
    expect(res.multiWorkspace).toBe(true);
    expect(res.workspaces).toHaveLength(2);
    const byRoot = new Map(res.workspaces.map((w) => [w.root, w.trusted]));
    // Roots are canonicalized; look them up the same way the daemon does.
    const { canonicalizeWorkspaceRoot } = await import('./trust.js');
    expect(byRoot.get(canonicalizeWorkspaceRoot(wsA))).toBe(true);
    expect(byRoot.get(canonicalizeWorkspaceRoot(wsB))).toBe(false);
  });

  it('daemon/status reports empty before any workspace is configured', async () => {
    const daemon = makeDaemon();
    const res = (await daemon.handleRequest(createRequest('1', 'daemon/status', {}))) as {
      workspaces: unknown[];
      multiWorkspace: boolean;
    };
    expect(res.workspaces).toEqual([]);
    expect(res.multiWorkspace).toBe(false);
  });
});

describe('mcp/secrets/provide', () => {
  beforeEach(() => {
    workspaceTrust.clear();
    workspaceSecrets.clear();
  });
  afterEach(() => {
    workspaceTrust.clear();
    workspaceSecrets.clear();
  });

  it('stores secrets scoped to the workspace', async () => {
    const daemon = makeDaemon();
    const wsA = mkdtempSync(join(tmpdir(), 'ws-d-'));
    const wsB = mkdtempSync(join(tmpdir(), 'ws-d-'));
    const res = (await daemon.handleRequest(
      createRequest('1', 'mcp/secrets/provide', {
        workspaceRoot: wsA,
        secrets: { API_KEY: 'aaa' },
      }),
    )) as { ok: boolean; count: number };
    expect(res.ok).toBe(true);
    expect(res.count).toBe(1);
    expect(workspaceSecrets.resolve(wsA, 'API_KEY')).toBe('aaa');
    // Not visible from the other workspace (fail closed).
    expect(workspaceSecrets.resolve(wsB, 'API_KEY')).toBeUndefined();
  });

  it('rejects invalid params', async () => {
    const daemon = makeDaemon();
    await expect(
      daemon.handleRequest(createRequest('1', 'mcp/secrets/provide', { workspaceRoot: '' })),
    ).rejects.toThrow();
  });
});
