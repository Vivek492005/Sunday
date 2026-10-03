// Phase 8 Stage 3: per-workspace MCP hub manager + tool gating tests.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WorkspaceMcpManager,
  adaptMcpToolForWorkspace,
} from './workspace-mcp.js';
import { setWorkspaceTrust, workspaceTrust } from './trust.js';
import { workspaceSecrets } from './workspace-secrets.js';
import type { Tool as McpTool } from '@sunday/mcp';
import type { Tool, ToolContext, ToolResult } from '@sunday/tools';

function fakeMcpTool(name: string): McpTool {
  return {
    definition: { name, description: 'fake', parameters: { type: 'object', properties: {} } },
    execute: async (): Promise<{ output: string }> => ({ output: `ran ${name}` }),
  } as unknown as McpTool;
}

function fakeAdapt(t: McpTool): Tool {
  return {
    definition: { name: t.definition.name, description: '', parameters: { type: 'object', properties: {} } },
    execute: async (_args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> => ({
      output: `ran ${t.definition.name}`,
    }),
  };
}

describe('WorkspaceMcpManager', () => {
  beforeEach(() => {
    workspaceTrust.clear();
    workspaceSecrets.clear();
  });
  afterEach(() => {
    workspaceTrust.clear();
    workspaceSecrets.clear();
  });

  it('creates one hub per workspace root (lazy, cached)', () => {
    const mgr = new WorkspaceMcpManager();
    const wsA = mkdtempSync(join(tmpdir(), 'ws-mcp-a-'));
    const wsB = mkdtempSync(join(tmpdir(), 'ws-mcp-b-'));
    const a1 = mgr.get(wsA);
    const a2 = mgr.get(wsA);
    const b = mgr.get(wsB);
    expect(a1).toBe(a2);
    expect(a1.hub).not.toBe(b.hub);
    expect(a1.root).not.toBe(b.root);
  });

  it('captures the workspace trust verdict at construction', async () => {
    const mgr = new WorkspaceMcpManager();
    const ws = mkdtempSync(join(tmpdir(), 'ws-mcp-'));
    // A workspace-scope config must exist for workspaceConfigIgnored to be meaningful.
    mkdirSync(join(ws, '.sunday'), { recursive: true });
    writeFileSync(
      join(ws, '.sunday', 'mcp.json'),
      JSON.stringify({ servers: { s: { transport: 'stdio', command: ['echo'] } } }),
    );
    setWorkspaceTrust(ws, false);
    const entry = mgr.get(ws);
    await entry.ready;
    expect(entry.workspaceTrusted).toBe(false);
    expect(entry.hub.workspaceConfigIgnored).toBe(true);
    expect(entry.hub.listServers()).toEqual([]);
  });

  it('rebuild() picks up a changed trust verdict', async () => {
    const mgr = new WorkspaceMcpManager();
    const ws = mkdtempSync(join(tmpdir(), 'ws-mcp-'));
    setWorkspaceTrust(ws, false);
    const before = mgr.get(ws);
    await before.ready;
    expect(before.workspaceTrusted).toBe(false);
    setWorkspaceTrust(ws, true);
    const after = mgr.rebuild(ws);
    await after.ready;
    expect(after.workspaceTrusted).toBe(true);
    expect(after.hub).not.toBe(before.hub);
  });

  it('resolve() falls back to the default hub without a workspaceRoot', () => {
    const mgr = new WorkspaceMcpManager();
    const ws = mkdtempSync(join(tmpdir(), 'ws-mcp-'));
    const def = mgr.get(ws);
    expect(mgr.resolve(undefined, def)).toBe(def);
    expect(mgr.resolve(ws, def)).toBe(def); // same root → same hub
  });
});

describe('adaptMcpToolForWorkspace', () => {
  const ctxFor = (cwd: string): ToolContext => ({ cwd });

  beforeEach(() => {
    workspaceTrust.clear();
    workspaceSecrets.clear();
  });
  afterEach(() => {
    workspaceTrust.clear();
    workspaceSecrets.clear();
  });

  it('ungated when no workspaceRoot (legacy)', async () => {
    const tool = adaptMcpToolForWorkspace(fakeMcpTool('mcp__s__t'), fakeAdapt);
    const res = await tool.execute({}, ctxFor('/anywhere'));
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain('ran mcp__s__t');
  });

  it('allows execution for sessions under the workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-mcp-'));
    const tool = adaptMcpToolForWorkspace(fakeMcpTool('mcp__s__t'), fakeAdapt, ws);
    const res = await tool.execute({}, ctxFor(join(ws, 'sub')));
    expect(res.isError).toBeFalsy();
  });

  it('permissive in single-workspace mode for cwd outside the workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-mcp-'));
    const other = mkdtempSync(join(tmpdir(), 'ws-mcp-'));
    const tool = adaptMcpToolForWorkspace(fakeMcpTool('mcp__s__t'), fakeAdapt, ws);
    const res = await tool.execute({}, ctxFor(other));
    expect(res.isError).toBeFalsy(); // backward compat
  });

  it('fail-closed in multi-workspace mode for cross-workspace execution', async () => {
    const wsA = mkdtempSync(join(tmpdir(), 'ws-mcp-a-'));
    const wsB = mkdtempSync(join(tmpdir(), 'ws-mcp-b-'));
    setWorkspaceTrust(wsA, true);
    setWorkspaceTrust(wsB, true);
    const tool = adaptMcpToolForWorkspace(fakeMcpTool('mcp__s__t'), fakeAdapt, wsA);
    const res = await tool.execute({}, ctxFor(wsB));
    expect(res.isError).toBe(true);
    expect(res.output).toContain('cannot run in this session');
  });
});

describe('per-workspace mcp.json isolation', () => {
  beforeEach(() => {
    workspaceTrust.clear();
    workspaceSecrets.clear();
  });
  afterEach(() => {
    workspaceTrust.clear();
    workspaceSecrets.clear();
  });

  it('each hub reads its own workspace mcp.json', async () => {
    const mgr = new WorkspaceMcpManager();
    const wsA = mkdtempSync(join(tmpdir(), 'ws-mcp-a-'));
    const wsB = mkdtempSync(join(tmpdir(), 'ws-mcp-b-'));
    setWorkspaceTrust(wsA, true);
    setWorkspaceTrust(wsB, true);
    // Workspace A defines a server; B defines none.
    mkdirSync(join(wsA, '.sunday'), { recursive: true });
    writeFileSync(
      join(wsA, '.sunday', 'mcp.json'),
      JSON.stringify({ servers: { aserver: { transport: 'stdio', command: ['echo', 'hi'] } } }),
    );
    const a = mgr.get(wsA);
    const b = mgr.get(wsB);
    await a.ready;
    await b.ready;
    expect(a.hub.listServers().map((s) => s.name)).toContain('aserver');
    expect(b.hub.listServers().map((s) => s.name)).not.toContain('aserver');
  });
});
