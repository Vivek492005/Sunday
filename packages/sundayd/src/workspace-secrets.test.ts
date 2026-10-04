// Phase 8 Stage 3: per-workspace secret store tests.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WorkspaceSecretResolver,
  WorkspaceSecretStore,
  workspaceSecrets,
} from './workspace-secrets.js';
import { mcpSecretEnvName } from './trust.js';

describe('WorkspaceSecretStore', () => {
  let store: WorkspaceSecretStore;

  beforeEach(() => {
    store = new WorkspaceSecretStore();
  });

  it('resolves secrets provided for the workspace', () => {
    const ws = mkdtempSync(join(realpathSync(tmpdir()), 'ws-sec-'));
    store.provide(ws, { API_KEY: 'secret-a' });
    expect(store.resolve(ws, 'API_KEY')).toBe('secret-a');
  });

  it('does not leak secrets across workspaces', () => {
    const wsA = mkdtempSync(join(realpathSync(tmpdir()), 'ws-sec-a-'));
    const wsB = mkdtempSync(join(realpathSync(tmpdir()), 'ws-sec-b-'));
    store.provide(wsA, { API_KEY: 'secret-a' });
    store.provide(wsB, { API_KEY: 'secret-b' });
    expect(store.resolve(wsA, 'API_KEY')).toBe('secret-a');
    expect(store.resolve(wsB, 'API_KEY')).toBe('secret-b');
    // A workspace with no namespace resolves nothing in multi-workspace mode.
    const wsC = mkdtempSync(join(realpathSync(tmpdir()), 'ws-sec-c-'));
    expect(store.resolve(wsC, 'API_KEY')).toBeUndefined();
  });

  it('a nested cwd inherits its workspace namespace', () => {
    const ws = mkdtempSync(join(realpathSync(tmpdir()), 'ws-sec-'));
    store.provide(ws, { TOKEN: 't' });
    expect(store.resolve(join(ws, 'sub', 'dir'), 'TOKEN')).toBe('t');
  });

  it('normalizes keys the same way as mcpSecretEnvName', () => {
    const ws = mkdtempSync(join(realpathSync(tmpdir()), 'ws-sec-'));
    store.provide(ws, { 'my.api-key': 'v' });
    expect(store.resolve(ws, 'my.api-key')).toBe('v');
    expect(store.resolve(ws, 'my_api_key')).toBe('v');
  });

  it('falls back to env vars in single-workspace mode (backward compat)', () => {
    const ws = mkdtempSync(join(realpathSync(tmpdir()), 'ws-sec-'));
    process.env[mcpSecretEnvName('LEGACY_KEY')] = 'legacy-value';
    try {
      expect(store.resolve(ws, 'LEGACY_KEY')).toBe('legacy-value');
    } finally {
      delete process.env[mcpSecretEnvName('LEGACY_KEY')];
    }
  });

  it('env fallback is disabled in multi-workspace mode (fail closed)', () => {
    const wsA = mkdtempSync(join(realpathSync(tmpdir()), 'ws-sec-'));
    const wsB = mkdtempSync(join(realpathSync(tmpdir()), 'ws-sec-'));
    process.env[mcpSecretEnvName('LEGACY_KEY')] = 'legacy-value';
    try {
      store.provide(wsA, { OTHER: 'x' });
      expect(store.isMultiWorkspace).toBe(true);
      // wsB has no namespace: env must NOT leak into it.
      expect(store.resolve(wsB, 'LEGACY_KEY')).toBeUndefined();
    } finally {
      delete process.env[mcpSecretEnvName('LEGACY_KEY')];
    }
  });
});

describe('WorkspaceSecretResolver', () => {
  beforeEach(() => workspaceSecrets.clear());
  afterEach(() => workspaceSecrets.clear());

  it('resolves from the bound workspace namespace', async () => {
    const ws = mkdtempSync(join(realpathSync(tmpdir()), 'ws-sec-'));
    workspaceSecrets.provide(ws, { K: 'v' });
    const r = new WorkspaceSecretResolver(ws);
    await expect(r.resolve('K')).resolves.toBe('v');
  });

  it('throws when the key is unavailable to the workspace', async () => {
    const wsA = mkdtempSync(join(realpathSync(tmpdir()), 'ws-sec-'));
    const wsB = mkdtempSync(join(realpathSync(tmpdir()), 'ws-sec-'));
    workspaceSecrets.provide(wsA, { K: 'v' });
    const r = new WorkspaceSecretResolver(wsB);
    await expect(r.resolve('K')).rejects.toThrow(/not available for workspace/);
  });
});
