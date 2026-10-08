// Tests for the onboarding wizard: detection matrix on fixture repos,
// .env.example key parsing, checklist state machine, and summary.
import { describe, expect, it } from 'vitest';
import {
  analyzeRepo,
  parseEnvExampleKeys,
  stackLabel,
} from './detect.js';
import {
  applyStepUpdate,
  initialChecklist,
  summarize,
} from './state.js';

describe('parseEnvExampleKeys', () => {
  it('extracts keys, skips comments and blanks', () => {
    const keys = parseEnvExampleKeys('# comment\nPORT=3000\n\nHOST = localhost\nINVALID LINE\nPORT=3000\n');
    expect(keys).toEqual(['PORT', 'HOST']);
  });
});

describe('analyzeRepo — detection matrix', () => {
  const empty = (): Record<string, string | null> => ({
    'package.json': null,
    'package-lock.json': null,
    'pnpm-lock.yaml': null,
    'yarn.lock': null,
    'pyproject.toml': null,
    'requirements.txt': null,
    'poetry.lock': null,
    'uv.lock': null,
    Pipfile: null,
    'go.mod': null,
    'Cargo.toml': null,
    Dockerfile: null,
    'README.md': null,
    '.env.example': null,
  });

  it('detects node + pnpm from lockfile and scripts', () => {
    const a = analyzeRepo({
      ...empty(),
      'package.json': JSON.stringify({ scripts: { dev: 'vite', build: 'tsc' } }),
      'pnpm-lock.yaml': 'lockfileVersion: 9',
    });
    expect(a.stack).toBe('node');
    expect(a.packageManager).toBe('pnpm');
    expect(a.installCommand).toBe('pnpm install');
    expect(a.devCommand).toBe('pnpm dev');
    expect(a.buildCommand).toBe('pnpm build');
  });

  it('detects node + yarn, falls back to start when no dev script', () => {
    const a = analyzeRepo({
      ...empty(),
      'package.json': JSON.stringify({ scripts: { start: 'node index.js' } }),
      'yarn.lock': '# yarn',
    });
    expect(a.packageManager).toBe('yarn');
    expect(a.devCommand).toBe('yarn start');
    expect(a.buildCommand).toBeUndefined();
  });

  it('defaults to npm with no lockfile', () => {
    const a = analyzeRepo({ ...empty(), 'package.json': '{}' });
    expect(a.packageManager).toBe('npm');
    expect(a.installCommand).toBe('npm install');
  });

  it('tolerates invalid package.json', () => {
    const a = analyzeRepo({ ...empty(), 'package.json': 'not json{{' });
    expect(a.stack).toBe('node');
    expect(a.devCommand).toBeUndefined();
  });

  it('detects python + pip with requirements', () => {
    const a = analyzeRepo({ ...empty(), 'requirements.txt': 'requests\n' });
    expect(a.stack).toBe('python');
    expect(a.packageManager).toBe('pip');
    expect(a.installCommand).toBe('pip install -r requirements.txt');
  });

  it('detects python + poetry from poetry.lock', () => {
    const a = analyzeRepo({ ...empty(), 'pyproject.toml': '[tool.poetry]', 'poetry.lock': 'x' });
    expect(a.packageManager).toBe('poetry');
    expect(a.installCommand).toBe('poetry install');
  });

  it('detects python + uv from uv.lock', () => {
    const a = analyzeRepo({ ...empty(), 'pyproject.toml': '[project]', 'uv.lock': 'x' });
    expect(a.packageManager).toBe('uv');
    expect(a.installCommand).toBe('uv sync');
  });

  it('detects go', () => {
    const a = analyzeRepo({ ...empty(), 'go.mod': 'module example.com/x\n' });
    expect(a.stack).toBe('go');
    expect(a.installCommand).toBe('go mod download');
    expect(a.buildCommand).toBe('go build ./...');
  });

  it('detects rust', () => {
    const a = analyzeRepo({ ...empty(), 'Cargo.toml': '[package]\n' });
    expect(a.stack).toBe('rust');
    expect(a.installCommand).toBe('cargo fetch');
  });

  it('detects mixed stacks', () => {
    const a = analyzeRepo({ ...empty(), 'package.json': '{}', 'requirements.txt': 'x' });
    expect(a.stack).toBe('mixed');
  });

  it('detects unknown for an empty repo', () => {
    const a = analyzeRepo(empty());
    expect(a.stack).toBe('unknown');
    expect(a.installCommand).toBeUndefined();
  });

  it('reads .env.example vars and dockerfile/readme', () => {
    const a = analyzeRepo({
      ...empty(),
      '.env.example': 'PORT=3000\n# comment\nTOKEN=\n',
      Dockerfile: 'FROM node:20',
      'README.md': '# My App\n\nDoes things.\n',
    });
    expect(a.hasEnvExample).toBe(true);
    expect(a.envExampleVars).toEqual(['PORT', 'TOKEN']);
    expect(a.hasDockerfile).toBe(true);
    expect(a.readmeSummary).toBe('My App');
  });
});

describe('stackLabel', () => {
  it('labels stacks', () => {
    expect(stackLabel(analyzeRepo({ 'package.json': '{}', 'pnpm-lock.yaml': 'x' } as never))).toBe('Node.js (pnpm)');
    expect(stackLabel(analyzeRepo({ 'go.mod': 'x' } as never))).toBe('Go');
    expect(stackLabel(analyzeRepo({}))).toBe('Unknown stack');
  });
});

describe('initialChecklist', () => {
  it('builds steps for a node repo with env example', () => {
    const steps = initialChecklist(
      analyzeRepo({
        'package.json': JSON.stringify({ scripts: { dev: 'vite', build: 'tsc' } }),
        'pnpm-lock.yaml': 'x',
        '.env.example': 'PORT=1\n',
      } as never),
    );
    expect(steps.map((s) => s.id)).toEqual(['stack', 'install', 'env', 'dev', 'build']);
    expect(steps[0].status).toBe('done');
    expect(steps.find((s) => s.id === 'install')?.command).toBe('pnpm install');
    expect(steps.find((s) => s.id === 'env')?.action).toBe('env');
  });

  it('omits steps with no command and no env example', () => {
    const steps = initialChecklist(analyzeRepo({} as never));
    expect(steps.map((s) => s.id)).toEqual(['stack']);
  });
});

describe('applyStepUpdate', () => {
  it('updates one step immutably', () => {
    const steps = initialChecklist(analyzeRepo({ 'package.json': '{}' } as never));
    const next = applyStepUpdate(steps, 'install', { status: 'running' });
    expect(next.find((s) => s.id === 'install')?.status).toBe('running');
    expect(steps.find((s) => s.id === 'install')?.status).toBe('pending'); // original untouched
  });
  it('ignores unknown ids', () => {
    const steps = initialChecklist(analyzeRepo({} as never));
    expect(applyStepUpdate(steps, 'nope', { status: 'done' })).toEqual(steps);
  });
});

describe('summarize', () => {
  it('splits worked vs needs-attention', () => {
    const steps = applyStepUpdate(
      applyStepUpdate(initialChecklist(analyzeRepo({ 'package.json': '{}' } as never)), 'install', {
        status: 'failed',
        detail: 'exit 1',
      }),
      'stack',
      { status: 'done' },
    );
    const { worked, needsAttention } = summarize(steps);
    expect(worked).toHaveLength(1);
    expect(needsAttention.some((s) => s.includes('failed'))).toBe(true);
  });
});
