// Phase 8 Stage 3: per-workspace trust store tests.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WORKSPACE_TRUSTED_ENV,
  canonicalizeWorkspaceRoot,
  isPathWithin,
  isWorkspaceTrusted,
  setWorkspaceTrust,
  workspaceTrust,
} from './trust.js';

describe('canonicalizeWorkspaceRoot', () => {
  it('resolves to an absolute path', () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'ws-trust-'));
    expect(canonicalizeWorkspaceRoot(dir)).toBe(canonicalizeWorkspaceRoot(dir));
    expect(canonicalizeWorkspaceRoot('.')).toBe(process.cwd());
  });

  it('falls back to the resolved path for nonexistent dirs', () => {
    const missing = join(realpathSync(tmpdir()), 'ws-trust-missing-xyz');
    expect(canonicalizeWorkspaceRoot(missing)).toBe(missing);
  });
});

describe('isPathWithin', () => {
  it('matches the path itself and nested children', () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'ws-trust-'));
    expect(isPathWithin(dir, dir)).toBe(true);
    expect(isPathWithin(join(dir, 'sub', 'file.ts'), dir)).toBe(true);
  });

  it('rejects siblings and prefix-collisions', () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'ws-trust-'));
    expect(isPathWithin(join(realpathSync(tmpdir()), 'other'), dir)).toBe(false);
    // "/tmp/ws-trust-abc2" must not match "/tmp/ws-trust-abc".
    expect(isPathWithin(`${dir}-suffix`, dir)).toBe(false);
  });
});

describe('isWorkspaceTrusted (per-workspace)', () => {
  const OLD = process.env[WORKSPACE_TRUSTED_ENV];

  beforeEach(() => {
    workspaceTrust.clear();
    delete process.env[WORKSPACE_TRUSTED_ENV];
  });

  afterEach(() => {
    workspaceTrust.clear();
    if (OLD === undefined) delete process.env[WORKSPACE_TRUSTED_ENV];
    else process.env[WORKSPACE_TRUSTED_ENV] = OLD;
  });

  it('falls back to the env var in single-workspace mode (no configure)', () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'ws-trust-'));
    expect(isWorkspaceTrusted(dir)).toBe(false);
    process.env[WORKSPACE_TRUSTED_ENV] = '1';
    expect(isWorkspaceTrusted(dir)).toBe(true);
    expect(isWorkspaceTrusted()).toBe(true);
  });

  it('two workspaces can hold different verdicts on one daemon', () => {
    const trusted = mkdtempSync(join(realpathSync(tmpdir()), 'ws-trusted-'));
    const untrusted = mkdtempSync(join(realpathSync(tmpdir()), 'ws-untrusted-'));
    process.env[WORKSPACE_TRUSTED_ENV] = '1'; // env says trusted...
    setWorkspaceTrust(trusted, true);
    setWorkspaceTrust(untrusted, false); // ...but the map wins per workspace
    expect(isWorkspaceTrusted(trusted)).toBe(true);
    expect(isWorkspaceTrusted(untrusted)).toBe(false);
  });

  it('a nested session cwd inherits its workspace verdict', () => {
    const ws = mkdtempSync(join(realpathSync(tmpdir()), 'ws-trust-'));
    setWorkspaceTrust(ws, true);
    expect(isWorkspaceTrusted(join(ws, 'packages', 'foo'))).toBe(true);
  });

  it('fail-closed: unconfigured workspace is untrusted in multi-workspace mode', () => {
    const configured = mkdtempSync(join(realpathSync(tmpdir()), 'ws-trust-'));
    const unknown = mkdtempSync(join(realpathSync(tmpdir()), 'ws-trust-'));
    process.env[WORKSPACE_TRUSTED_ENV] = '1'; // env is ignored now
    setWorkspaceTrust(configured, true);
    expect(workspaceTrust.isMultiWorkspace).toBe(true);
    expect(isWorkspaceTrusted(unknown)).toBe(false);
  });

  it('no-arg form keeps legacy env behavior', () => {
    setWorkspaceTrust(mkdtempSync(join(realpathSync(tmpdir()), 'ws-trust-')), false);
    process.env[WORKSPACE_TRUSTED_ENV] = '1';
    expect(isWorkspaceTrusted()).toBe(true);
    delete process.env[WORKSPACE_TRUSTED_ENV];
    expect(isWorkspaceTrusted()).toBe(false);
  });
});
