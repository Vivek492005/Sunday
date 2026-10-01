/**
 * SkillLoader — discovers `.sunday/skills/<name>/SKILL.md` skills in the
 * workspace and user scopes, with progressive disclosure:
 *
 *   - `discover()` returns cheap `SkillSummary[]` (name + description only);
 *     this is what goes into the agent prompt.
 *   - `loadSkill(name)` pulls the full body on demand.
 *   - `loadSkillFile(name, relPath)` pulls a single referenced file on demand.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { parseFrontmatter, toStringValue } from './frontmatter.js';

export type SkillScope = 'workspace' | 'user';

export interface SkillSummary {
  name: string;
  description: string;
  scope: SkillScope;
  /** Absolute path of the skill directory. */
  path: string;
  /**
   * True when the skill directory contains executable scripts (a `scripts/`
   * or `bin/` directory, or files like `*.sh`, `*.ps1`, `*.js` beyond docs).
   * Worker 3 uses this to gate skills-with-scripts in untrusted workspaces.
   */
  hasScripts: boolean;
}

export interface LoadedSkill {
  name: string;
  description: string;
  /** Full SKILL.md body (frontmatter stripped). */
  body: string;
  /** Relative paths of supporting files in the skill dir (SKILL.md excluded). */
  files: string[];
  hasScripts: boolean;
  scope: SkillScope;
  /** Absolute path of the skill directory. */
  path: string;
}

export interface SkillLoaderOptions {
  /** Workspace root. Defaults to `process.cwd()`. */
  workspaceDir?: string;
  /** Home dir whose `.sunday/skills` is the user scope. Defaults to `os.homedir()`. */
  userDir?: string;
}

const SKILL_FILE = 'SKILL.md';

// Extensions that indicate executable/script content (beyond plain docs).
const SCRIPT_EXTENSIONS = new Set([
  '.sh', '.bash', '.zsh', '.fish',
  '.ps1', '.psm1', '.cmd', '.bat', '.com', '.exe',
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts',
  '.py', '.rb', '.pl', '.php', '.lua',
]);

const SCRIPT_DIR_NAMES = new Set(['scripts', 'bin', 'hooks']);

function extOf(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i >= 0 ? fileName.slice(i).toLowerCase() : '';
}

/** Recursively list files under `dir`, returned as paths relative to `dir`. */
async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(current, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        await walk(full);
      } else if (e.isFile()) {
        out.push(relative(dir, full).split(sep).join('/'));
      }
    }
  }
  await walk(dir);
  return out.sort();
}

/**
 * Detect executable scripts in a skill directory: a `scripts/`/`bin/`/`hooks/`
 * directory, or any file with a script/executable extension.
 */
export async function detectScripts(skillDir: string): Promise<boolean> {
  const files = await listFilesRecursive(skillDir);
  for (const rel of files) {
    const parts = rel.split('/');
    if (parts.some((p) => SCRIPT_DIR_NAMES.has(p.toLowerCase()))) return true;
    if (SCRIPT_EXTENSIONS.has(extOf(basename(rel)))) return true;
  }
  return false;
}

interface DiscoveredSkill {
  dirName: string;
  skillDir: string;
  scope: SkillScope;
}

export class SkillLoader {
  private readonly workspaceDir: string;
  private readonly userDir: string;

  constructor(opts: SkillLoaderOptions = {}) {
    this.workspaceDir = resolve(opts.workspaceDir ?? process.cwd());
    this.userDir = resolve(opts.userDir ?? homedir());
  }

  private skillsDir(scope: SkillScope): string {
    return scope === 'workspace'
      ? join(this.workspaceDir, '.sunday', 'skills')
      : join(this.userDir, '.sunday', 'skills');
  }

  private async scanScope(scope: SkillScope): Promise<DiscoveredSkill[]> {
    const base = this.skillsDir(scope);
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: DiscoveredSkill[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const skillDir = join(base, e.name);
      try {
        await stat(join(skillDir, SKILL_FILE));
      } catch {
        continue; // Not a skill: no SKILL.md.
      }
      out.push({ dirName: e.name, skillDir, scope });
    }
    return out;
  }

  private async readSkillFile(skillDir: string): Promise<string> {
    return readFile(join(skillDir, SKILL_FILE), 'utf8');
  }

  /**
   * Discover all skills (workspace + user scope). Cheap: reads SKILL.md
   * frontmatter only, never the body. Workspace scope wins on name clashes.
   */
  async discover(): Promise<SkillSummary[]> {
    const seen = new Map<string, SkillSummary>();
    for (const scope of ['workspace', 'user'] as const) {
      for (const d of await this.scanScope(scope)) {
        const raw = await this.readSkillFile(d.skillDir);
        const { data } = parseFrontmatter(raw);
        const name = toStringValue(data['name']) || d.dirName;
        const description = toStringValue(data['description']);
        if (!description) continue; // frontmatter name+description required
        if (seen.has(name)) continue; // workspace wins over user
        seen.set(name, {
          name,
          description,
          scope: d.scope,
          path: d.skillDir,
          hasScripts: await detectScripts(d.skillDir),
        });
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Resolve a skill by frontmatter name (falling back to directory name). */
  private async resolve(name: string): Promise<DiscoveredSkill> {
    for (const scope of ['workspace', 'user'] as const) {
      for (const d of await this.scanScope(scope)) {
        const raw = await this.readSkillFile(d.skillDir);
        const { data } = parseFrontmatter(raw);
        const skillName = toStringValue(data['name']) || d.dirName;
        if (skillName === name) return d;
      }
    }
    throw new Error(`Skill not found: ${name}`);
  }

  /** Load a skill's full body plus its list of supporting files. */
  async loadSkill(name: string): Promise<LoadedSkill> {
    const d = await this.resolve(name);
    const raw = await this.readSkillFile(d.skillDir);
    const { data, body } = parseFrontmatter(raw);
    const all = await listFilesRecursive(d.skillDir);
    const files = all.filter((f) => f.toLowerCase() !== SKILL_FILE.toLowerCase());
    return {
      name: toStringValue(data['name']) || d.dirName,
      description: toStringValue(data['description']),
      body,
      files,
      hasScripts: await detectScripts(d.skillDir),
      scope: d.scope,
      path: d.skillDir,
    };
  }

  /**
   * Load a single referenced file from a skill directory, on demand.
   * Refuses paths that escape the skill directory.
   */
  async loadSkillFile(name: string, relPath: string): Promise<string> {
    const d = await this.resolve(name);
    const target = resolve(d.skillDir, relPath);
    const rel = relative(d.skillDir, target);
    if (rel === '' || rel.startsWith('..') || resolve(target) !== target) {
      throw new Error(`Refusing to read outside the skill directory: ${relPath}`);
    }
    return readFile(target, 'utf8');
  }
}
