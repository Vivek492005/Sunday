// sunday-agent — project scaffolding from templates (Group B3).
//
// Pure, VS Code-free file operations: `scaffold()` copies a template
// directory, replacing `{{projectName}}` placeholders in text files.
// The VS Code wiring (quickpick → input → scaffold → git init → install
// prompt → open window) lives in `./initProject.js`.
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** The four built-in templates. */
export const TEMPLATE_NAMES = ['react-ts', 'node-api', 'python-cli', 'nextjs'] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

/** Placeholder replaced in every text file of the template. */
export const PROJECT_NAME_PLACEHOLDER = '{{projectName}}';

/** Project names must be filesystem- and registry-safe. */
const PROJECT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function isTemplateName(name: string): name is TemplateName {
  return (TEMPLATE_NAMES as readonly string[]).includes(name);
}

export function assertValidProjectName(name: string): void {
  if (!PROJECT_NAME_RE.test(name)) {
    throw new Error(
      `invalid project name "${name}": use 1-64 chars of letters, digits, ".", "_", "-" (must start with a letter or digit)`,
    );
  }
}

export interface ScaffoldOptions {
  /** Directory containing the template folders (e.g. `<ext>/templates`). */
  templatesDir: string;
  template: string;
  projectName: string;
  /** Absolute directory the project is scaffolded into (created if missing). */
  targetDir: string;
}

/** True when the buffer looks like binary (NUL byte in the head). */
function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, Math.min(buf.length, 8192)).includes(0);
}

async function copyTemplateDir(
  srcDir: string,
  destDir: string,
  projectName: string,
  created: string[],
  relBase: string,
): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await copyTemplateDir(src, dest, projectName, created, rel);
    } else if (entry.isFile()) {
      const buf = await readFile(src);
      const out = isBinary(buf)
        ? buf
        : Buffer.from(buf.toString('utf8').split(PROJECT_NAME_PLACEHOLDER).join(projectName), 'utf8');
      await writeFile(dest, out);
      created.push(rel);
    }
    // Symlinks and other special files are intentionally not copied.
  }
}

/**
 * Scaffold `template` into `targetDir` with placeholders replaced.
 * Returns the created file paths, relative to `targetDir`, sorted.
 *
 * Throws when the template name is unknown (or looks like a path —
 * traversal is rejected), the project name is invalid, the template
 * directory is missing, or the target cannot be written.
 */
export async function scaffold(opts: ScaffoldOptions): Promise<string[]> {
  const template = opts.template.trim();
  if (!isTemplateName(template) || template.includes('/') || template.includes('\\') || template.includes('..')) {
    throw new Error(
      `unknown template "${opts.template}": choose one of ${TEMPLATE_NAMES.join(', ')}`,
    );
  }
  assertValidProjectName(opts.projectName);

  const srcDir = resolve(opts.templatesDir, template);
  let srcStat;
  try {
    srcStat = await stat(srcDir);
  } catch {
    throw new Error(`template "${template}" not found in ${opts.templatesDir}`);
  }
  if (!srcStat.isDirectory()) {
    throw new Error(`template "${template}" is not a directory: ${srcDir}`);
  }

  const targetDir = resolve(opts.targetDir);
  const created: string[] = [];
  await copyTemplateDir(srcDir, targetDir, opts.projectName, created, '');
  return created.sort();
}
