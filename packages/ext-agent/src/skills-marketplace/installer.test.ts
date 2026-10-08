// Tests for skills-marketplace/installer.ts: install/uninstall/isInstalled,
// URL + size + hash enforcement, path-traversal safety. All fs/fetch injected.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installSkill,
  isInstalled,
  listInstalled,
  MAX_DOWNLOAD_BYTES,
  skillInstallDir,
  skillsDir,
  SkillAlreadyInstalledError,
  SkillInstallError,
  uninstallSkill,
  type DownloadFetch,
} from './installer.js';
import type { RegistrySkill } from './registry.js';

const skill: RegistrySkill = {
  name: 'hello-sunday',
  description: 'Example.',
  author: 'Sunday',
  version: '1.0.0',
  downloadUrl: 'https://example.com/hello-sunday/SKILL.md',
};

function fetchOk(body: string, contentLength?: number): DownloadFetch {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: (n: string) => (n === 'content-length' && contentLength !== undefined ? String(contentLength) : null) },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
  });
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function home(): string {
  const d = mkdtempSync(join(tmpdir(), 'sunday-skills-test-'));
  dirs.push(d);
  return d;
}

describe('installSkill', () => {
  it('downloads SKILL.md into ~/.sunday/skills/<name>/', async () => {
    const h = home();
    await installSkill(skill, { fetchImpl: fetchOk('# Hello\n'), homeDir: h });
    expect(isInstalled(h, 'hello-sunday')).toBe(true);
    expect(readFileSync(join(skillsDir(h), 'hello-sunday', 'SKILL.md'), 'utf8')).toBe('# Hello\n');
    const meta = JSON.parse(readFileSync(join(skillsDir(h), 'hello-sunday', 'sunday-skill.json'), 'utf8'));
    expect(meta.version).toBe('1.0.0');
  });

  it('refuses to install twice', async () => {
    const h = home();
    await installSkill(skill, { fetchImpl: fetchOk('# x'), homeDir: h });
    await expect(installSkill(skill, { fetchImpl: fetchOk('# x'), homeDir: h })).rejects.toBeInstanceOf(
      SkillAlreadyInstalledError,
    );
  });

  it('rejects non-https download URLs', async () => {
    const h = home();
    await expect(
      installSkill({ ...skill, downloadUrl: 'http://example.com/x' }, { fetchImpl: fetchOk('# x'), homeDir: h }),
    ).rejects.toBeInstanceOf(SkillInstallError);
    expect(isInstalled(h, 'hello-sunday')).toBe(false);
  });

  it('rejects unsafe names', async () => {
    const h = home();
    await expect(
      installSkill({ ...skill, name: '../evil' }, { fetchImpl: fetchOk('# x'), homeDir: h }),
    ).rejects.toBeInstanceOf(SkillInstallError);
  });

  it('enforces the 2 MiB cap (declared and actual)', async () => {
    const h = home();
    // Declared via content-length.
    await expect(
      installSkill(skill, { fetchImpl: fetchOk('# x', MAX_DOWNLOAD_BYTES + 1), homeDir: h }),
    ).rejects.toThrow(/2 MiB/);
    // Actual body over the cap with no content-length.
    const big = 'x'.repeat(MAX_DOWNLOAD_BYTES + 1);
    await expect(
      installSkill(skill, { fetchImpl: fetchOk(big), homeDir: h }),
    ).rejects.toThrow(/2 MiB/);
    expect(isInstalled(h, 'hello-sunday')).toBe(false);
  });

  it('rejects empty downloads', async () => {
    const h = home();
    await expect(installSkill(skill, { fetchImpl: fetchOk(''), homeDir: h })).rejects.toThrow(/empty/);
  });

  it('rejects HTTP errors and network failures', async () => {
    const h = home();
    const bad: DownloadFetch = async () => ({
      ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(installSkill(skill, { fetchImpl: bad, homeDir: h })).rejects.toThrow(/HTTP 404/);
    const down: DownloadFetch = async () => { throw new Error('dns'); };
    await expect(installSkill(skill, { fetchImpl: down, homeDir: h })).rejects.toThrow(/download failed/);
  });

  it('verifies the sha256 hash pin when present', async () => {
    const h = home();
    const body = '# pinned';
    const good = 'sha256:' + createHash('sha256').update(body).digest('hex');
    await installSkill({ ...skill, hash: good }, { fetchImpl: fetchOk(body), homeDir: h });
    expect(isInstalled(h, 'hello-sunday')).toBe(true);

    const h2 = home();
    const badHash = 'sha256:' + '00'.repeat(32);
    await expect(
      installSkill({ ...skill, hash: badHash }, { fetchImpl: fetchOk(body), homeDir: h2 }),
    ).rejects.toThrow(/hash verification/);
    expect(isInstalled(h2, 'hello-sunday')).toBe(false);
  });

  it('exposes the 2 MiB cap', () => {
    expect(MAX_DOWNLOAD_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe('uninstallSkill', () => {
  it('removes the skill directory', async () => {
    const h = home();
    await installSkill(skill, { fetchImpl: fetchOk('# x'), homeDir: h });
    expect(uninstallSkill(h, 'hello-sunday')).toBe(true);
    expect(isInstalled(h, 'hello-sunday')).toBe(false);
    expect(existsSync(join(skillsDir(h), 'hello-sunday'))).toBe(false);
  });

  it('returns false when not installed; rejects unsafe names', async () => {
    const h = home();
    expect(uninstallSkill(h, 'nope')).toBe(false);
    expect(uninstallSkill(h, '../evil')).toBe(false);
  });

  it('never escapes the skills dir', () => {
    const h = home();
    // Even a hostile name resolves inside skillsDir or throws.
    expect(() => skillInstallDir(h, '../../tmp')).toThrow(SkillInstallError);
  });
});

describe('isInstalled / listInstalled', () => {
  it('lists installed skills with versions', async () => {
    const h = home();
    expect(listInstalled(h)).toEqual([]);
    await installSkill(skill, { fetchImpl: fetchOk('# x'), homeDir: h });
    await installSkill({ ...skill, name: 'other', version: '2.0.0' }, { fetchImpl: fetchOk('# y'), homeDir: h });
    const list = listInstalled(h).sort((a, b) => a.name.localeCompare(b.name));
    expect(list).toEqual([
      { name: 'hello-sunday', version: '1.0.0' },
      { name: 'other', version: '2.0.0' },
    ]);
  });
});
