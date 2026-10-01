/**
 * RuleLoader — collects the rules that apply to the current context:
 *
 *   - `AGENTS.md`: workspace root + nested dirs; when several apply to a
 *     file, the NEAREST one wins (only the nearest is included).
 *   - `<workspace>/.sunday/rules/*.md` (workspace scope)
 *   - `~/.sunday/rules/*.md` (user scope)
 *
 * Precedence, low → high: system > user > workspace > nested AGENTS.md.
 * `loadActiveRules()` returns rules ordered by ascending precedence so the
 * caller (worker 3) can compile them into a system-prompt section in order.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { matchAnyGlob, normalizeForGlob } from './glob.js';
import { parseFrontmatter, toStringArray, toStringValue } from './frontmatter.js';

export interface ActiveRule {
  /** Where the rule came from, e.g. `system`, `user:rules/lint.md`, `workspace:rules/go.md`, `agents:sub/AGENTS.md`. */
  source: string;
  description?: string;
  /** Rule body (frontmatter stripped). */
  content: string;
  alwaysApply: boolean;
}

/** A rule injected above everything else (the "system" precedence slot). */
export interface SystemRule {
  description?: string;
  content: string;
}

export interface RuleLoaderOptions {
  /** Workspace root. Defaults to `process.cwd()`. */
  workspaceDir?: string;
  /** Home dir whose `.sunday/rules` is the user scope. Defaults to `os.homedir()`. */
  userDir?: string;
  /** Optional system-slot rules (lowest precedence: first in the returned order). */
  systemRules?: SystemRule[];
}

type Precedence = 'system' | 'user' | 'workspace' | 'agents';

const PRECEDENCE_ORDER: Record<Precedence, number> = {
  system: 0,
  user: 1,
  workspace: 2,
  agents: 3,
};

interface RuleWithPrecedence extends ActiveRule {
  precedence: Precedence;
}

const RULES_DIR = 'rules';
const AGENTS_FILE = 'AGENTS.md';

export class RuleLoader {
  private readonly workspaceDir: string;
  private readonly userDir: string;
  private readonly systemRules: SystemRule[];

  constructor(opts: RuleLoaderOptions = {}) {
    this.workspaceDir = resolve(opts.workspaceDir ?? process.cwd());
    this.userDir = resolve(opts.userDir ?? homedir());
    this.systemRules = opts.systemRules ?? [];
  }

  private rulesDir(scope: 'user' | 'workspace'): string {
    return scope === 'workspace'
      ? join(this.workspaceDir, '.sunday', RULES_DIR)
      : join(this.userDir, '.sunday', RULES_DIR);
  }

  /** Read `*.md` rule files from a rules dir (sorted by file name). */
  private async readRuleFiles(
    dir: string,
    scope: 'user' | 'workspace',
    filePath: string | undefined,
  ): Promise<RuleWithPrecedence[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const names = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => e.name)
      .sort();
    const out: RuleWithPrecedence[] = [];
    for (const name of names) {
      const raw = await readFile(join(dir, name), 'utf8');
      const { data, body } = parseFrontmatter(raw);
      const globs = toStringArray(data['globs']);
      const alwaysApply =
        typeof data['alwaysApply'] === 'boolean' ? data['alwaysApply'] : globs.length === 0;
      if (!alwaysApply) {
        if (filePath === undefined) continue;
        if (!matchAnyGlob(globs, filePath, this.workspaceDir)) continue;
      }
      const description = toStringValue(data['description']) || undefined;
      out.push({
        source: `${scope}:${RULES_DIR}/${name}`,
        description,
        content: body.trim(),
        alwaysApply,
        precedence: scope,
      });
    }
    return out;
  }

  /**
   * Find the nearest AGENTS.md for `filePath`: walk from the file's directory
   * up to (and including) the workspace root; the deepest AGENTS.md wins and
   * is the only one included. Without `filePath`, only the workspace-root
   * AGENTS.md is considered.
   */
  private async nearestAgentsMd(filePath: string | undefined): Promise<string | null> {
    const dirs: string[] = [];
    if (filePath !== undefined) {
      let dir = dirname(resolve(filePath));
      const root = this.workspaceDir;
      const rel = relative(root, dir);
      if (!rel.startsWith('..') && rel !== '') {
        // filePath is inside the workspace: walk up to the root.
        let current = dir;
        while (true) {
          dirs.push(current);
          if (current === root) break;
          const parent = dirname(current);
          if (parent === current) break;
          current = parent;
        }
      }
    }
    dirs.push(this.workspaceDir);
    for (const dir of dirs) {
      try {
        await stat(join(dir, AGENTS_FILE));
        return join(dir, AGENTS_FILE);
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Load the rules active for the current context. When `filePath` is given,
   * glob-scoped rules are filtered by it and the nearest AGENTS.md chain is
   * resolved against it. Returned in ascending precedence order
   * (system → user → workspace → nested AGENTS.md).
   */
  async loadActiveRules(filePath?: string): Promise<ActiveRule[]> {
    const rules: RuleWithPrecedence[] = [];

    for (const sr of this.systemRules) {
      rules.push({
        source: 'system',
        description: sr.description,
        content: sr.content,
        alwaysApply: true,
        precedence: 'system',
      });
    }

    rules.push(...(await this.readRuleFiles(this.rulesDir('user'), 'user', filePath)));
    rules.push(...(await this.readRuleFiles(this.rulesDir('workspace'), 'workspace', filePath)));

    const agentsMd = await this.nearestAgentsMd(filePath);
    if (agentsMd !== null) {
      const content = (await readFile(agentsMd, 'utf8')).trim();
      const rel = normalizeForGlob(relative(this.workspaceDir, agentsMd));
      rules.push({
        source: `agents:${rel}`,
        content,
        alwaysApply: true,
        precedence: 'agents',
      });
    }

    rules.sort((a, b) => {
      const p = PRECEDENCE_ORDER[a.precedence] - PRECEDENCE_ORDER[b.precedence];
      return p !== 0 ? p : a.source.localeCompare(b.source);
    });
    return rules.map(({ precedence: _p, ...rule }) => rule);
  }

  /** Convenience: the workspace-relative path of the nearest AGENTS.md, if any. */
  async nearestAgentsMdPath(filePath?: string): Promise<string | null> {
    const p = await this.nearestAgentsMd(filePath);
    return p === null ? null : normalizeForGlob(relative(this.workspaceDir, p));
  }
}

/** Re-export for callers that want the AGENTS.md file name constant. */
export const AGENTS_MD = AGENTS_FILE;
