// sunday-agent — repo onboarding wizard (Workflow, C3): stack detection.
// Pure analysis of well-known workspace files → RepoAnalysis. All I/O lives
// in the command module; this file is fully unit-testable on fixtures.

export type Stack = 'node' | 'python' | 'go' | 'rust' | 'mixed' | 'unknown';

export type PackageManager =
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'pip'
  | 'poetry'
  | 'uv'
  | 'cargo'
  | 'go';

export interface RepoAnalysis {
  stack: Stack;
  packageManager?: PackageManager;
  installCommand?: string;
  devCommand?: string;
  buildCommand?: string;
  hasEnvExample: boolean;
  envExampleVars: string[];
  hasDockerfile: boolean;
  readmeSummary?: string;
}

/** File names the wizard reads (relative to the workspace root). */
export const ONBOARDING_FILES = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'pyproject.toml',
  'requirements.txt',
  'poetry.lock',
  'uv.lock',
  'Pipfile',
  'go.mod',
  'Cargo.toml',
  'Dockerfile',
  'README.md',
  '.env.example',
] as const;

export type OnboardingFileName = (typeof ONBOARDING_FILES)[number];

/** Parse `KEY=value` lines from a .env.example (keys only — values are never read). */
export function parseEnvExampleKeys(content: string): string[] {
  const keys: string[] = [];
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && !keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
}

function firstLineSummary(readme: string): string | undefined {
  for (const line of readme.split('\n')) {
    const t = line.trim().replace(/^#+\s*/, '');
    if (t) return t.slice(0, 140);
  }
  return undefined;
}

interface NodeInfo {
  packageManager: PackageManager;
  installCommand: string;
  devCommand?: string;
  buildCommand?: string;
}

function analyzeNode(files: Record<string, string | null>): NodeInfo {
  let packageManager: PackageManager = 'npm';
  if (files['pnpm-lock.yaml']) packageManager = 'pnpm';
  else if (files['yarn.lock']) packageManager = 'yarn';
  else if (files['package-lock.json']) packageManager = 'npm';

  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(files['package.json'] ?? '{}') as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    scripts = {};
  }
  const run = (name: string): string =>
    packageManager === 'npm' ? `npm run ${name}` : `${packageManager} ${name}`;
  return {
    packageManager,
    installCommand: `${packageManager} install`,
    devCommand: scripts['dev'] ? run('dev') : scripts['start'] ? run('start') : undefined,
    buildCommand: scripts['build'] ? run('build') : undefined,
  };
}

/** Analyze a workspace from file name → content (null = absent). */
export function analyzeRepo(files: Record<string, string | null>): RepoAnalysis {
  const has = (n: string): boolean => files[n] != null;
  const stacks: Stack[] = [];
  if (has('package.json')) stacks.push('node');
  if (has('pyproject.toml') || has('requirements.txt') || has('Pipfile')) stacks.push('python');
  if (has('go.mod')) stacks.push('go');
  if (has('Cargo.toml')) stacks.push('rust');

  const envContent = files['.env.example'];
  const analysis: RepoAnalysis = {
    stack: stacks.length === 0 ? 'unknown' : stacks.length === 1 ? stacks[0] : 'mixed',
    hasEnvExample: envContent != null,
    envExampleVars: envContent != null ? parseEnvExampleKeys(envContent) : [],
    hasDockerfile: has('Dockerfile'),
    readmeSummary: files['README.md'] ? firstLineSummary(files['README.md']!) : undefined,
  };

  // Commands follow the primary stack (node wins ties — most common for this IDE).
  const primary = stacks[0];
  if (primary === 'node') {
    const n = analyzeNode(files);
    analysis.packageManager = n.packageManager;
    analysis.installCommand = n.installCommand;
    analysis.devCommand = n.devCommand;
    analysis.buildCommand = n.buildCommand;
  } else if (primary === 'python') {
    if (has('poetry.lock')) {
      analysis.packageManager = 'poetry';
      analysis.installCommand = 'poetry install';
    } else if (has('uv.lock')) {
      analysis.packageManager = 'uv';
      analysis.installCommand = 'uv sync';
    } else {
      analysis.packageManager = 'pip';
      analysis.installCommand = has('requirements.txt')
        ? 'pip install -r requirements.txt'
        : 'pip install -e .';
    }
  } else if (primary === 'go') {
    analysis.packageManager = 'go';
    analysis.installCommand = 'go mod download';
    analysis.buildCommand = 'go build ./...';
  } else if (primary === 'rust') {
    analysis.packageManager = 'cargo';
    analysis.installCommand = 'cargo fetch';
    analysis.buildCommand = 'cargo build';
  }
  return analysis;
}

/** Human label for the detected stack. */
export function stackLabel(a: RepoAnalysis): string {
  const pm = a.packageManager ? ` (${a.packageManager})` : '';
  switch (a.stack) {
    case 'node':
      return `Node.js${pm}`;
    case 'python':
      return `Python${pm}`;
    case 'go':
      return 'Go';
    case 'rust':
      return 'Rust';
    case 'mixed':
      return `Mixed stack (primary: ${a.packageManager ?? 'unknown'})`;
    default:
      return 'Unknown stack';
  }
}
