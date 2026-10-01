// Tests for the Part A tool wiring: load_skill / tool_search / remember
// registration, dangerous flags, the load_skill trust gate, and the
// EnvSecretResolver.
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adaptMcpTool, createSundaydTools, EnvSecretResolver } from './agent-tools.js';
import { mcpSecretEnvName } from './trust.js';
import { createToolSearchTool, McpHub } from '@sunday/mcp';

const TRUST_ENV = 'SUNDAY_WORKSPACE_TRUSTED';
let savedTrust: string | undefined;

beforeEach(() => {
  savedTrust = process.env[TRUST_ENV];
});

afterEach(() => {
  if (savedTrust === undefined) delete process.env[TRUST_ENV];
  else process.env[TRUST_ENV] = savedTrust;
});

async function makeDirs() {
  const root = await mkdtemp(join(tmpdir(), 'sunday-agenttools-test-'));
  const ws = join(root, 'ws');
  const home = join(root, 'home');
  await mkdir(join(ws, '.sunday'), { recursive: true });
  await mkdir(join(home, '.sunday'), { recursive: true });
  return { ws, home };
}

async function writeSkill(ws: string, dirName: string, frontmatter: string, body: string, scripts = false) {
  const dir = join(ws, '.sunday', 'skills', dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`);
  if (scripts) {
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(join(dir, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n');
  }
  await writeFile(join(dir, 'notes.md'), '# notes\n');
}

function makeTools(ws: string, home: string) {
  return createSundaydTools({
    workspaceDir: ws,
    userDir: home,
    mcp: {
      userConfigPath: join(ws, 'no-user-mcp.json'),
      workspaceConfigPath: join(ws, 'no-ws-mcp.json'),
    },
  });
}

describe('createSundaydTools registry', () => {
  it('registers load_skill, tool_search (read-only) and remember (dangerous)', async () => {
    const { ws, home } = await makeDirs();
    const { registry, policy, ready } = makeTools(ws, home);
    await ready;
    for (const name of ['load_skill', 'tool_search', 'remember']) {
      expect(registry.names()).toContain(name);
    }
    const defs = new Map(registry.definitions().map((d) => [d.name, d]));
    expect(defs.get('load_skill')!.dangerous ?? false).toBe(false);
    expect(defs.get('tool_search')!.dangerous ?? false).toBe(false);
    expect(defs.get('remember')!.dangerous).toBe(true);
    // Policy mirrors the dangerous flags.
    expect(policy.isDangerous('remember')).toBe(true);
    expect(policy.isDangerous('load_skill')).toBe(false);
    expect(policy.isDangerous('tool_search')).toBe(false);
    expect(policy.evaluate('remember').allow).toBe(false);
    policy.approve('remember');
    expect(policy.evaluate('remember')).toEqual({ allow: true });
  });

  it('tool_search reports no hidden tools on an empty hub', async () => {
    const { ws, home } = await makeDirs();
    const { registry, ready } = makeTools(ws, home);
    await ready;
    const r = await registry.call('tool_search', { query: 'deploy' }, { cwd: ws });
    expect(r.isError).toBeFalsy();
    expect(r.output).toMatch(/no hidden MCP tools match/);
  });
});

describe('load_skill', () => {
  it('returns the skill body plus supporting files', async () => {
    const { ws, home } = await makeDirs();
    await writeSkill(ws, 'code_review', 'name: code_review\ndescription: Review diffs.', 'Review carefully.');
    const { registry, ready } = makeTools(ws, home);
    await ready;
    const r = await registry.call('load_skill', { name: 'code_review' }, { cwd: ws });
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain('# code_review');
    expect(r.output).toContain('Review carefully.');
    expect(r.output).toContain('- notes.md');
    expect(r.output).not.toContain('SKILL.md');
  });

  it('rejects non-snake_case names and unknown skills cleanly', async () => {
    const { ws, home } = await makeDirs();
    const { registry, ready } = makeTools(ws, home);
    await ready;
    const bad = await registry.call('load_skill', { name: 'Code-Review!' }, { cwd: ws });
    expect(bad.isError).toBe(true);
    expect(bad.output).toMatch(/snake_case/);
    const unknown = await registry.call('load_skill', { name: 'nope' }, { cwd: ws });
    expect(unknown.isError).toBe(true);
    expect(unknown.output).toMatch(/Skill not found|load_skill/);
  });

  it('gates workspace skills with scripts in untrusted workspaces', async () => {
    const { ws, home } = await makeDirs();
    await writeSkill(ws, 'deploy', 'name: deploy\ndescription: Deploy things.', 'Run scripts/deploy.sh.', true);
    process.env[TRUST_ENV] = '0';
    const untrusted = makeTools(ws, home);
    await untrusted.ready;
    const denied = await untrusted.registry.call('load_skill', { name: 'deploy' }, { cwd: ws });
    expect(denied.isError).toBe(true);
    expect(denied.output).toMatch(/not trusted.*disabled until approved/);

    process.env[TRUST_ENV] = '1';
    const trusted = makeTools(ws, home);
    await trusted.ready;
    const ok = await trusted.registry.call('load_skill', { name: 'deploy' }, { cwd: ws });
    expect(ok.isError).toBeFalsy();
    expect(ok.output).toContain('# deploy');
  });

  it('does not gate scriptless skills or user-scope skills', async () => {
    const { ws, home } = await makeDirs();
    await writeSkill(ws, 'plain', 'name: plain\ndescription: Plain skill.', 'Nothing risky.');
    process.env[TRUST_ENV] = '0';
    const { registry, ready } = makeTools(ws, home);
    await ready;
    const r = await registry.call('load_skill', { name: 'plain' }, { cwd: ws });
    expect(r.isError).toBeFalsy();
  });
});

describe('remember', () => {
  it('appends to workspace memory and returns the diff', async () => {
    const { ws, home } = await makeDirs();
    const { registry, ready } = makeTools(ws, home);
    await ready;
    const r = await registry.call('remember', { text: 'user prefers pnpm' }, { cwd: ws });
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain('user prefers pnpm');
    const file = await readFile(join(ws, '.sunday', 'memory.md'), 'utf8');
    expect(file).toContain('user prefers pnpm');
  });

  it('supports the user scope and refuses secrets', async () => {
    const { ws, home } = await makeDirs();
    const { registry, ready } = makeTools(ws, home);
    await ready;
    const r = await registry.call('remember', { text: 'likes dark mode', scope: 'user' }, { cwd: ws });
    expect(r.isError).toBeFalsy();
    const file = await readFile(join(home, '.sunday', 'memory.md'), 'utf8');
    expect(file).toContain('likes dark mode');

    const secret = await registry.call('remember', { text: 'my api_key=sk-abcdef123456' }, { cwd: ws });
    expect(secret.isError).toBe(true);
    expect(secret.output).toMatch(/refus/i);
  });
});

describe('adaptMcpTool', () => {
  it('adapts the structural mcp Tool into the registry Tool shape', async () => {
    const hub = new McpHub({
      userConfigPath: join(tmpdir(), 'nope-user.json'),
      workspaceConfigPath: join(tmpdir(), 'nope-ws.json'),
    });
    const adapted = adaptMcpTool(createToolSearchTool(hub));
    expect(adapted.definition.name).toBe('tool_search');
    const r = await adapted.execute({ query: '' }, { cwd: tmpdir() });
    expect(r.output).toMatch(/query is empty/);
  });
});

describe('EnvSecretResolver', () => {
  it('resolves from SUNDAY_MCP_SECRET_* env vars and errors clearly when missing', async () => {
    const key = 'my-api-key';
    const envName = mcpSecretEnvName(key);
    process.env[envName] = 's3cr3t';
    try {
      await expect(new EnvSecretResolver().resolve(key)).resolves.toBe('s3cr3t');
    } finally {
      delete process.env[envName];
    }
    await expect(new EnvSecretResolver().resolve('missing-key')).rejects.toThrow(/not available/);
  });
});

describe('SEC-04: workspace MCP trust gating (fail-closed)', () => {
  async function writeWorkspaceMcp(ws: string) {
    await writeFile(
      join(ws, '.sunday', 'mcp.json'),
      JSON.stringify({
        servers: {
          evil: {
            transport: 'stdio',
            command: ['node', '-e', 'process.exit(1)'],
            defaultApproval: 'allow',
          },
        },
      }),
      'utf8',
    );
  }

  function makeToolsWithWsMcp(ws: string, home: string, workspaceTrusted?: boolean) {
    const mcp: { userConfigPath: string; workspaceConfigPath: string; workspaceTrusted?: boolean } = {
      userConfigPath: join(ws, 'no-user-mcp.json'),
      workspaceConfigPath: join(ws, '.sunday', 'mcp.json'),
    };
    if (workspaceTrusted !== undefined) mcp.workspaceTrusted = workspaceTrusted;
    return createSundaydTools({ workspaceDir: ws, userDir: home, mcp });
  }

  it('ignores the workspace mcp.json when the trust verdict is absent (fail-closed)', async () => {
    const { ws, home } = await makeDirs();
    await writeWorkspaceMcp(ws);
    delete process.env[TRUST_ENV];
    const { hub, policy, ready } = makeToolsWithWsMcp(ws, home);
    await ready;
    expect(hub.workspaceConfigIgnored).toBe(true);
    expect(hub.listServers().map((s) => s.name)).not.toContain('evil');
    expect(policy.dangerousTools()).not.toContain('mcp__evil__anything');
  });

  it('ignores the workspace mcp.json when the workspace is untrusted', async () => {
    const { ws, home } = await makeDirs();
    await writeWorkspaceMcp(ws);
    process.env[TRUST_ENV] = '0';
    const { hub, ready } = makeToolsWithWsMcp(ws, home);
    await ready;
    expect(hub.workspaceConfigIgnored).toBe(true);
    expect(hub.listServers().map((s) => s.name)).not.toContain('evil');
  });

  it('loads the workspace mcp.json when the workspace is trusted', async () => {
    const { ws, home } = await makeDirs();
    await writeWorkspaceMcp(ws);
    process.env[TRUST_ENV] = '1';
    const { hub, ready } = makeToolsWithWsMcp(ws, home);
    await ready;
    expect(hub.workspaceConfigIgnored).toBe(false);
    expect(hub.listServers().map((s) => s.name)).toContain('evil');
  });

  it('an explicit workspaceTrusted=true still overrides the env verdict', async () => {
    const { ws, home } = await makeDirs();
    await writeWorkspaceMcp(ws);
    process.env[TRUST_ENV] = '0';
    const { hub, ready } = makeToolsWithWsMcp(ws, home, true);
    await ready;
    expect(hub.listServers().map((s) => s.name)).toContain('evil');
  });
});
