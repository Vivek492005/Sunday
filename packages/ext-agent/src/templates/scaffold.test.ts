// Tests for project scaffolding (Group B3): placeholder replacement,
// template file sets, and invalid-input rejection. Runs against the real
// templates directory with temp target dirs.
import { mkdtempSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  TEMPLATE_NAMES,
  assertValidProjectName,
  isTemplateName,
  scaffold,
} from './scaffold.js';

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates');

const EXPECTED_FILES: Record<string, string[]> = {
  'react-ts': ['package.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'src/main.tsx', 'src/App.tsx', 'README.md', '.gitignore'],
  'node-api': ['package.json', 'tsconfig.json', 'src/index.ts', 'README.md', '.gitignore'],
  'python-cli': ['pyproject.toml', 'src/app.py', 'README.md', '.gitignore'],
  'nextjs': ['package.json', 'tsconfig.json', 'next.config.mjs', 'app/layout.tsx', 'app/page.tsx', 'README.md', '.gitignore'],
};

async function listAll(dir: string, base = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listAll(join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

describe('isTemplateName / assertValidProjectName', () => {
  it('recognizes the four templates', () => {
    for (const name of TEMPLATE_NAMES) expect(isTemplateName(name)).toBe(true);
    expect(isTemplateName('rails')).toBe(false);
    expect(isTemplateName('')).toBe(false);
  });

  it('accepts sane project names and rejects bad ones', () => {
    expect(() => assertValidProjectName('my-app_2.0')).not.toThrow();
    expect(() => assertValidProjectName('')).toThrow(/invalid project name/);
    expect(() => assertValidProjectName('-bad')).toThrow(/invalid project name/);
    expect(() => assertValidProjectName('a/b')).toThrow(/invalid project name/);
    expect(() => assertValidProjectName('has space')).toThrow(/invalid project name/);
  });
});

describe('scaffold', () => {
  it.each(TEMPLATE_NAMES)('scaffolds %s with the expected file set', async (template) => {
    const target = mkdtempSync(join(tmpdir(), 'sunday-scaffold-'));
    const created = await scaffold({ templatesDir: TEMPLATES_DIR, template, projectName: 'demo-app', targetDir: join(target, 'demo-app') });
    expect(created.sort()).toEqual(EXPECTED_FILES[template]!.sort());
    // Spot-check on-disk file set matches the returned list.
    expect(await listAll(join(target, 'demo-app'))).toEqual(created.sort());
  });

  it('replaces {{projectName}} in file contents', async () => {
    const target = mkdtempSync(join(tmpdir(), 'sunday-scaffold-'));
    await scaffold({ templatesDir: TEMPLATES_DIR, template: 'node-api', projectName: 'cool-api', targetDir: join(target, 'cool-api') });
    const pkg = JSON.parse(await readFile(join(target, 'cool-api', 'package.json'), 'utf8'));
    expect(pkg.name).toBe('cool-api');
    const index = await readFile(join(target, 'cool-api', 'src', 'index.ts'), 'utf8');
    expect(index).toContain('cool-api');
    expect(index).not.toContain('{{projectName}}');
    const readme = await readFile(join(target, 'cool-api', 'README.md'), 'utf8');
    expect(readme).toContain('# cool-api');
  });

  it('replaces placeholders in the python-cli template', async () => {
    const target = mkdtempSync(join(tmpdir(), 'sunday-scaffold-'));
    await scaffold({ templatesDir: TEMPLATES_DIR, template: 'python-cli', projectName: 'mytool', targetDir: join(target, 'mytool') });
    const toml = await readFile(join(target, 'mytool', 'pyproject.toml'), 'utf8');
    expect(toml).toContain('name = "mytool"');
    expect(toml).not.toContain('{{projectName}}');
  });

  it('rejects unknown template names', async () => {
    const target = mkdtempSync(join(tmpdir(), 'sunday-scaffold-'));
    await expect(
      scaffold({ templatesDir: TEMPLATES_DIR, template: 'rails', projectName: 'x', targetDir: target }),
    ).rejects.toThrow(/unknown template/);
  });

  it('rejects path traversal in the template name', async () => {
    const target = mkdtempSync(join(tmpdir(), 'sunday-scaffold-'));
    await expect(
      scaffold({ templatesDir: TEMPLATES_DIR, template: '../mcp', projectName: 'x', targetDir: target }),
    ).rejects.toThrow(/unknown template/);
  });

  it('rejects invalid project names', async () => {
    const target = mkdtempSync(join(tmpdir(), 'sunday-scaffold-'));
    await expect(
      scaffold({ templatesDir: TEMPLATES_DIR, template: 'node-api', projectName: 'bad name', targetDir: target }),
    ).rejects.toThrow(/invalid project name/);
  });

  it('throws when the template directory is missing', async () => {
    const target = mkdtempSync(join(tmpdir(), 'sunday-scaffold-'));
    await expect(
      scaffold({ templatesDir: join(target, 'nope'), template: 'node-api', projectName: 'x', targetDir: target }),
    ).rejects.toThrow(/not found/);
  });
});
