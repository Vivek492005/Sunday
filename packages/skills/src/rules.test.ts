import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuleLoader } from './rules.js';

let ws: string;
let user: string;

async function ruleFile(scopeDir: string, name: string, md: string): Promise<void> {
  const dir = join(scopeDir, '.sunday', 'rules');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), md, 'utf8');
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'rules-ws-'));
  user = await mkdtemp(join(tmpdir(), 'rules-user-'));

  await writeFile(join(ws, 'AGENTS.md'), '# Root instructions\n\nBe kind.\n', 'utf8');
  await mkdir(join(ws, 'sub', 'deep'), { recursive: true });
  await writeFile(join(ws, 'sub', 'AGENTS.md'), '# Sub instructions\n\nBe specific.\n', 'utf8');
  await writeFile(join(ws, 'sub', 'deep', 'app.ts'), 'export {};\n', 'utf8');
  await writeFile(join(ws, 'README.md'), '# readme\n', 'utf8');

  // No globs, no alwaysApply -> always applied (workspace scope).
  await ruleFile(ws, 'always.md', `---\ndescription: Always on\n---\n\nAlways do this.\n`);
  // Globs only -> applies to matching files.
  await ruleFile(
    ws,
    'ts-only.md',
    `---\ndescription: TS style\nglobs:\n  - "**/*.ts"\n---\n\nUse strict TS.\n`,
  );
  // alwaysApply: false + globs -> only on glob match.
  await ruleFile(
    ws,
    'docs-only.md',
    `---\ndescription: Docs style\nalwaysApply: false\nglobs: "*.md"\n---\n\nWrite docs well.\n`,
  );

  // User scope, always applied.
  await ruleFile(user, 'user.md', `---\ndescription: User rule\nalwaysApply: true\n---\n\nUser says hi.\n`);
});

function loader(): RuleLoader {
  return new RuleLoader({ workspaceDir: ws, userDir: user });
}

describe('RuleLoader.loadActiveRules', () => {
  it('orders rules by ascending precedence: user < workspace < nested AGENTS.md', async () => {
    const rules = await loader().loadActiveRules(join(ws, 'sub', 'deep', 'app.ts'));
    const sources = rules.map((r) => r.source);
    expect(sources).toEqual([
      'user:rules/user.md',
      'workspace:rules/always.md',
      'workspace:rules/ts-only.md',
      'agents:sub/AGENTS.md',
    ]);
  });

  it('filters glob-scoped rules by filePath', async () => {
    const rules = await loader().loadActiveRules(join(ws, 'README.md'));
    const sources = rules.map((r) => r.source);
    expect(sources).toContain('workspace:rules/docs-only.md');
    expect(sources).not.toContain('workspace:rules/ts-only.md');
    expect(sources).toContain('workspace:rules/always.md');
  });

  it('excludes glob-only rules when no filePath is given', async () => {
    const rules = await loader().loadActiveRules();
    const sources = rules.map((r) => r.source);
    expect(sources).toContain('workspace:rules/always.md');
    expect(sources).toContain('user:rules/user.md');
    expect(sources).not.toContain('workspace:rules/ts-only.md');
    expect(sources).not.toContain('workspace:rules/docs-only.md');
    // Root AGENTS.md still applies without a filePath.
    expect(sources).toContain('agents:AGENTS.md');
  });

  it('nearest AGENTS.md wins over the root one', async () => {
    const rules = await loader().loadActiveRules(join(ws, 'sub', 'deep', 'app.ts'));
    const agents = rules.filter((r) => r.source.startsWith('agents:'));
    expect(agents).toHaveLength(1);
    expect(agents[0].source).toBe('agents:sub/AGENTS.md');
    expect(agents[0].content).toContain('Be specific.');
    expect(agents[0].content).not.toContain('Be kind.');
  });

  it('falls back to the root AGENTS.md for files outside nested dirs', async () => {
    const rules = await loader().loadActiveRules(join(ws, 'README.md'));
    const agents = rules.filter((r) => r.source.startsWith('agents:'));
    expect(agents).toHaveLength(1);
    expect(agents[0].source).toBe('agents:AGENTS.md');
    expect(agents[0].content).toContain('Be kind.');
  });

  it('strips rule frontmatter from content and keeps descriptions', async () => {
    const rules = await loader().loadActiveRules();
    const always = rules.find((r) => r.source === 'workspace:rules/always.md')!;
    expect(always.description).toBe('Always on');
    expect(always.content).toBe('Always do this.');
    expect(always.alwaysApply).toBe(true);
    const tsOnly = (await loader().loadActiveRules(join(ws, 'sub', 'deep', 'app.ts'))).find(
      (r) => r.source === 'workspace:rules/ts-only.md',
    )!;
    expect(tsOnly.alwaysApply).toBe(false);
  });

  it('places system rules first (lowest precedence)', async () => {
    const withSystem = new RuleLoader({
      workspaceDir: ws,
      userDir: user,
      systemRules: [{ description: 'sys', content: 'System prompt.' }],
    });
    const rules = await withSystem.loadActiveRules();
    expect(rules[0].source).toBe('system');
    expect(rules[0].content).toBe('System prompt.');
  });

  it('returns no rules when nothing is configured', async () => {
    const empty = new RuleLoader({
      workspaceDir: await mkdtemp(join(tmpdir(), 'rules-empty-')),
      userDir: await mkdtemp(join(tmpdir(), 'rules-empty-u-')),
    });
    expect(await empty.loadActiveRules()).toEqual([]);
  });
});
