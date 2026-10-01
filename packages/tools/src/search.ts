import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveWithinRoot } from './paths.js';
import { err, type Tool } from './types.js';

const SKIPPED_DIRS = new Set(['.git', 'node_modules', 'dist', '.hg', '.svn', '__pycache__']);
const MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS_CAP = 200;

function globToRegExp(glob: string): RegExp {
  const src = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${src}$`);
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith('.') && e.isDirectory() && SKIPPED_DIRS.has(e.name)) continue;
    if (SKIPPED_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) yield full;
  }
}

export const searchTool: Tool = {
  definition: {
    name: 'search',
    description:
      'Search file contents in the workspace with a regular expression. Skips .git, node_modules and dist. Returns file:line matches.',
    parameters: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        path: { type: 'string', description: 'Workspace-relative file or directory (default ".").' },
        include: { type: 'string', description: 'Filename filter, e.g. "*.ts" (default: all files).' },
        maxResults: { type: 'integer', description: 'Maximum matches to return.', minimum: 1, maximum: MAX_RESULTS_CAP },
        caseSensitive: { type: 'boolean', description: 'Case-sensitive matching (default false).' },
      },
    },
  },
  async execute(rawArgs, ctx) {
    const args = rawArgs as {
      pattern: string;
      path?: string;
      include?: string;
      maxResults?: number;
      caseSensitive?: boolean;
    };
    let re: RegExp;
    try {
      re = new RegExp(args.pattern, args.caseSensitive ? '' : 'i');
    } catch {
      return err(`invalid regular expression: ${args.pattern}`);
    }
    const includeRe = args.include ? globToRegExp(args.include) : null;
    const maxResults = Math.min(args.maxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_CAP);
    const start = resolveWithinRoot(ctx.cwd, args.path ?? '.');
    const st = await fs.stat(start).catch(() => null);
    if (!st) return err(`not found: ${args.path ?? '.'}`);

    const files: string[] = [];
    if (st.isFile()) files.push(start);
    else for await (const f of walk(start)) files.push(f);

    const matches: string[] = [];
    let truncated = false;
    for (const f of files) {
      if (includeRe && !includeRe.test(path.basename(f))) continue;
      const fst = await fs.stat(f).catch(() => null);
      if (!fst || fst.size > MAX_FILE_BYTES) continue;
      const buf = await fs.readFile(f).catch(() => null);
      if (!buf || buf.indexOf(0) !== -1) continue; // binary
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push(`${path.relative(ctx.cwd, f)}:${i + 1}: ${lines[i].trimEnd().slice(0, 300)}`);
          if (matches.length >= maxResults) {
            truncated = true;
            break;
          }
        }
      }
      if (truncated) break;
    }
    if (!matches.length) return { output: '(no matches)' };
    return {
      output: matches.join('\n') + (truncated ? `\n…[truncated to ${maxResults} matches]` : ''),
      metadata: { matchCount: matches.length, truncated },
    };
  },
};
