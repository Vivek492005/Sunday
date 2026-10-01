import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SkillLoader } from './skills.js';

let ws: string;
let user: string;

async function skillFile(scopeDir: string, name: string, md: string): Promise<void> {
  const dir = join(scopeDir, '.sunday', 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), md, 'utf8');
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'skills-ws-'));
  user = await mkdtemp(join(tmpdir(), 'skills-user-'));

  // Workspace skill with scripts (hasScripts: true).
  await skillFile(
    ws,
    'deploy',
    `---\nname: deploy\ndescription: Deploy the app to prod\n---\n\n# Deploy\n\nRun ./run.sh\n`,
  );
  await writeFile(join(ws, '.sunday', 'skills', 'deploy', 'run.sh'), '#!/bin/sh\necho hi\n', 'utf8');
  await mkdir(join(ws, '.sunday', 'skills', 'deploy', 'docs'), { recursive: true });
  await writeFile(join(ws, '.sunday', 'skills', 'deploy', 'docs', 'guide.md'), '# Guide\n', 'utf8');

  // Workspace skill without a description: skipped by discovery.
  await skillFile(ws, 'broken', `---\nname: broken\n---\n\nNo description.\n`);

  // User skill with the same name as the workspace one: workspace wins.
  await skillFile(
    user,
    'deploy',
    `---\nname: deploy\ndescription: User-scope deploy (shadowed)\n---\n\nshadowed\n`,
  );

  // User skill without scripts.
  await skillFile(
    user,
    'lint',
    `---\nname: lint\ndescription: Lint the codebase\n---\n\n# Lint\n\nRun the linter.\n`,
  );
  await writeFile(join(user, '.sunday', 'skills', 'lint', 'notes.md'), '# Notes\n', 'utf8');
});

function loader(): SkillLoader {
  return new SkillLoader({ workspaceDir: ws, userDir: user });
}

describe('SkillLoader.discover', () => {
  it('discovers skills in both scopes with frontmatter only', async () => {
    const skills = await loader().discover();
    expect(skills.map((s) => s.name)).toEqual(['deploy', 'lint']);
    const deploy = skills.find((s) => s.name === 'deploy')!;
    expect(deploy.description).toBe('Deploy the app to prod');
    expect(deploy.scope).toBe('workspace'); // workspace wins the name clash
    expect(deploy.path).toBe(join(ws, '.sunday', 'skills', 'deploy'));
    expect(skills.find((s) => s.name === 'lint')!.scope).toBe('user');
  });

  it('skips skills missing a description', async () => {
    const skills = await loader().discover();
    expect(skills.some((s) => s.name === 'broken')).toBe(false);
  });

  it('flags skills that contain executable scripts', async () => {
    const skills = await loader().discover();
    expect(skills.find((s) => s.name === 'deploy')!.hasScripts).toBe(true);
    expect(skills.find((s) => s.name === 'lint')!.hasScripts).toBe(false);
  });

  it('returns an empty list when no skills exist', async () => {
    const empty = new SkillLoader({
      workspaceDir: await mkdtemp(join(tmpdir(), 'skills-empty-')),
      userDir: await mkdtemp(join(tmpdir(), 'skills-empty-u-')),
    });
    expect(await empty.discover()).toEqual([]);
  });
});

describe('SkillLoader.loadSkill', () => {
  it('loads the full body and supporting files', async () => {
    const skill = await loader().loadSkill('deploy');
    expect(skill.name).toBe('deploy');
    expect(skill.description).toBe('Deploy the app to prod');
    expect(skill.body).toContain('# Deploy');
    expect(skill.body).not.toContain('name: deploy');
    expect(skill.files).toEqual(['docs/guide.md', 'run.sh']);
    expect(skill.hasScripts).toBe(true);
    expect(skill.scope).toBe('workspace');
  });

  it('throws for unknown skills', async () => {
    await expect(loader().loadSkill('nope')).rejects.toThrow('Skill not found: nope');
  });
});

describe('SkillLoader.loadSkillFile', () => {
  it('loads a referenced file on demand', async () => {
    const content = await loader().loadSkillFile('deploy', 'docs/guide.md');
    expect(content).toBe('# Guide\n');
  });

  it('refuses paths that escape the skill directory', async () => {
    await expect(loader().loadSkillFile('deploy', '../../secret.txt')).rejects.toThrow(
      'outside the skill directory',
    );
    await expect(loader().loadSkillFile('deploy', '/etc/passwd')).rejects.toThrow(
      'outside the skill directory',
    );
  });

  it('throws for missing files', async () => {
    await expect(loader().loadSkillFile('deploy', 'missing.md')).rejects.toThrow();
  });
});
