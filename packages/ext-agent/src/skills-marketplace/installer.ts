// sunday-agent — skills marketplace installer (D4).
//
// Downloads a skill's SKILL.md into ~/.sunday/skills/<name>/ and removes it
// on uninstall. SECURITY:
//   - Names are allowlisted (sanitizeSkillName) — no path traversal.
//   - downloadUrl must be https: (validated at registry parse AND here).
//   - Downloads are capped at 2 MiB (content-length pre-check + post-check).
//   - Downloaded content is NEVER executed — it is markdown documentation
//     read by the agent on demand, like any workspace file.
//   - Optional sha256 hash pin is verified before install.

import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { isSafeDownloadUrl, sanitizeSkillName, type RegistrySkill } from './registry.js';

/** Maximum download size per skill file (2 MiB). */
export const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;

export class SkillInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillInstallError';
  }
}

export class SkillAlreadyInstalledError extends SkillInstallError {
  constructor(name: string) {
    super(`skill "${name}" is already installed`);
    this.name = 'SkillAlreadyInstalledError';
  }
}

/** Minimal fetch shape for downloads (injectable for tests). */
export interface DownloadFetch {
  (url: string): Promise<{
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
}

export interface InstallerDeps {
  fetchImpl: DownloadFetch;
  /** os.homedir() in production; a tmp dir in tests. */
  homeDir: string;
}

/** ~/.sunday/skills — created on demand. */
export function skillsDir(homeDir: string): string {
  return join(homeDir, '.sunday', 'skills');
}

/** Absolute install dir for a skill; always inside skillsDir(). */
export function skillInstallDir(homeDir: string, name: string): string {
  const clean = sanitizeSkillName(name);
  if (!clean) throw new SkillInstallError(`unsafe skill name: ${String(name)}`);
  const base = resolve(skillsDir(homeDir));
  const dir = resolve(base, clean);
  if (dir !== base && !dir.startsWith(base + sep)) {
    // Defense in depth — sanitizeSkillName already excludes separators.
    throw new SkillInstallError(`unsafe skill name: ${String(name)}`);
  }
  return dir;
}

/** True when ~/.sunday/skills/<name>/SKILL.md exists. */
export function isInstalled(homeDir: string, name: string): boolean {
  try {
    const dir = skillInstallDir(homeDir, name);
    return existsSync(join(dir, 'SKILL.md'));
  } catch {
    return false;
  }
}

function verifyHash(data: Buffer, hash: string): boolean {
  const digest = createHash('sha256').update(data).digest('hex');
  const expected = hash.slice('sha256:'.length).toLowerCase();
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Install a skill: download SKILL.md (<=2 MiB, https only) into
 * ~/.sunday/skills/<name>/. Throws SkillAlreadyInstalledError when present,
 * SkillInstallError on any validation/download/hash failure (and cleans up
 * partial installs).
 */
export async function installSkill(skill: RegistrySkill, deps: InstallerDeps): Promise<void> {
  const name = sanitizeSkillName(skill.name);
  if (!name) throw new SkillInstallError(`unsafe skill name: ${String(skill.name)}`);
  if (!isSafeDownloadUrl(skill.downloadUrl)) {
    throw new SkillInstallError(`unsafe download URL for "${name}" (https: required)`);
  }
  const dir = skillInstallDir(deps.homeDir, name);
  if (existsSync(dir)) throw new SkillAlreadyInstalledError(name);

  let res: Awaited<ReturnType<DownloadFetch>>;
  try {
    res = await deps.fetchImpl(skill.downloadUrl);
  } catch (err) {
    throw new SkillInstallError(`download failed for "${name}": ${(err as Error).message}`);
  }
  if (!res.ok) throw new SkillInstallError(`download failed for "${name}" (HTTP ${res.status})`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    throw new SkillInstallError(`"${name}" exceeds the 2 MiB download cap`);
  }
  const data = Buffer.from(await res.arrayBuffer());
  if (data.byteLength === 0) throw new SkillInstallError(`"${name}" downloaded empty`);
  if (data.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new SkillInstallError(`"${name}" exceeds the 2 MiB download cap`);
  }
  if (skill.hash && !verifyHash(data, skill.hash)) {
    throw new SkillInstallError(`"${name}" failed hash verification`);
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(dir, 'SKILL.md'), data);
    writeFileSync(
      join(dir, 'sunday-skill.json'),
      JSON.stringify(
        { name, version: skill.version, author: skill.author, installedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw new SkillInstallError(`could not write "${name}": ${(err as Error).message}`);
  }
}

/**
 * Uninstall a skill (removes its directory). Returns true when something
 * was removed, false when it was not installed. Never touches anything
 * outside the skills dir.
 */
export function uninstallSkill(homeDir: string, name: string): boolean {
  let dir: string;
  try {
    dir = skillInstallDir(homeDir, name);
  } catch {
    return false;
  }
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return !existsSync(dir);
}

/** Read installed skill metadata (for the marketplace's installed state). */
export function listInstalled(homeDir: string): Array<{ name: string; version: string }> {
  const base = skillsDir(homeDir);
  let entries: string[];
  try {
    entries = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: Array<{ name: string; version: string }> = [];
  for (const name of entries) {
    if (!sanitizeSkillName(name)) continue;
    try {
      const meta = JSON.parse(readFileSync(join(base, name, 'sunday-skill.json'), 'utf8')) as {
        version?: unknown;
      };
      out.push({ name, version: typeof meta.version === 'string' ? meta.version : '?' });
    } catch {
      out.push({ name, version: '?' });
    }
  }
  return out;
}
