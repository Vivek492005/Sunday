import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createDefaultRegistry,
  resolveWithinRoot,
  PathEscapeError,
  validateArgs,
  type ToolContext,
} from './index.js';

let tmp: string;
let ctx: ToolContext;

beforeEach(async () => {
  // realpath: os.tmpdir() can be a symlink (macOS: /var -> /private/var);
  // resolveWithinRoot realpaths internally, so compare against the real path.
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sunday-tools-')));
  ctx = { cwd: tmp };
});

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (e, stdout, stderr) =>
      e ? reject(new Error(stderr)) : resolve(stdout),
    );
  });
}

describe('paths', () => {
  it('resolves inside the root', () => {
    expect(resolveWithinRoot(tmp, 'a/b.txt')).toBe(path.join(tmp, 'a/b.txt'));
    expect(resolveWithinRoot(tmp, '.')).toBe(tmp);
  });
  it('rejects escapes', () => {
    expect(() => resolveWithinRoot(tmp, '../evil')).toThrow(PathEscapeError);
    expect(() => resolveWithinRoot(tmp, 'a/../../evil')).toThrow(PathEscapeError);
    expect(() => resolveWithinRoot(tmp, '/etc/passwd')).toThrow(PathEscapeError);
  });
  it('rejects symlink escapes (§15.2 realpath rule)', async () => {
    // A symlink inside the workspace pointing outside it must not be
    // dereferenceable through the file tools.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sunday-tools-outside-'));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret');
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(tmp, 'link.txt'));
    expect(() => resolveWithinRoot(tmp, 'link.txt')).toThrow(PathEscapeError);
    // A symlink to a directory outside the root is an escape too.
    await fs.symlink(outside, path.join(tmp, 'dirlink'));
    expect(() => resolveWithinRoot(tmp, path.join('dirlink', 'secret.txt'))).toThrow(
      PathEscapeError,
    );
    // Symlinks that stay inside the workspace keep working.
    await fs.mkdir(path.join(tmp, 'sub'));
    await fs.writeFile(path.join(tmp, 'sub', 'ok.txt'), 'fine');
    await fs.symlink(path.join(tmp, 'sub'), path.join(tmp, 'inner'));
    expect(resolveWithinRoot(tmp, path.join('inner', 'ok.txt'))).toBe(
      path.join(tmp, 'sub', 'ok.txt'),
    );
  });
  it('resolves not-yet-existing paths against the nearest ancestor', () => {
    expect(resolveWithinRoot(tmp, path.join('newdir', 'newfile.txt'))).toBe(
      path.join(tmp, 'newdir', 'newfile.txt'),
    );
  });
});

describe('validateArgs', () => {
  const schema = {
    type: 'object',
    required: ['path'],
    properties: {
      path: { type: 'string' },
      limit: { type: 'integer', minimum: 1 },
      mode: { type: 'string', enum: ['a', 'b'] },
    },
  };
  it('accepts valid args', () => {
    expect(validateArgs(schema, { path: 'x', limit: 5, mode: 'a' })).toEqual([]);
  });
  it('reports missing required, wrong types, enum and minimum', () => {
    const errs = validateArgs(schema, { limit: 'five', mode: 'z' });
    expect(errs.join(' ')).toMatch(/path.*required/);
    expect(errs.join(' ')).toMatch(/limit.*integer/);
    expect(errs.join(' ')).toMatch(/mode.*one of/);
    expect(validateArgs(schema, { path: 'x', limit: 0 })[0]).toMatch(/minimum/);
  });
});

describe('fs tools', () => {
  it('write_file creates parents and read_file pages with line numbers', async () => {
    const r = createDefaultRegistry();
    const w = await r.call('write_file', { path: 'sub/a.txt', content: 'l1\nl2\nl3\n' }, ctx);
    expect(w.isError).toBeFalsy();
    const rd = await r.call('read_file', { path: 'sub/a.txt', offset: 2, limit: 1 }, ctx);
    expect(rd.output).toBe('2: l2');
  });
  it('read_file rejects missing files, directories and binaries', async () => {
    const r = createDefaultRegistry();
    expect((await r.call('read_file', { path: 'nope.txt' }, ctx)).isError).toBe(true);
    await fs.mkdir(path.join(tmp, 'd'));
    expect((await r.call('read_file', { path: 'd' }, ctx)).isError).toBe(true);
    await fs.writeFile(path.join(tmp, 'b.bin'), Buffer.from([0x00, 0x01, 0x02]));
    expect((await r.call('read_file', { path: 'b.bin' }, ctx)).isError).toBe(true);
  });
  it('edit_file replaces exactly one occurrence', async () => {
    const r = createDefaultRegistry();
    await r.call('write_file', { path: 'e.txt', content: 'hello world\n' }, ctx);
    const ok = await r.call('edit_file', { path: 'e.txt', oldText: 'world', newText: 'sunday' }, ctx);
    expect(ok.isError).toBeFalsy();
    expect(await fs.readFile(path.join(tmp, 'e.txt'), 'utf8')).toBe('hello sunday\n');
    expect((await r.call('edit_file', { path: 'e.txt', oldText: 'missing', newText: 'x' }, ctx)).isError).toBe(true);
    await r.call('write_file', { path: 'f.txt', content: 'a a a\n' }, ctx);
    expect((await r.call('edit_file', { path: 'f.txt', oldText: 'a', newText: 'b' }, ctx)).isError).toBe(true);
  });
  it('list_dir annotates entries and hides dotfiles by default', async () => {
    const r = createDefaultRegistry();
    await r.call('write_file', { path: 'v.txt', content: 'x' }, ctx);
    await r.call('write_file', { path: '.hidden', content: 'x' }, ctx);
    await fs.mkdir(path.join(tmp, 'sub'));
    const out = (await r.call('list_dir', {}, ctx)).output;
    expect(out).toMatch(/\[dir\] sub\//);
    expect(out).toMatch(/\[file\] v\.txt/);
    expect(out).not.toMatch(/\.hidden/);
  });
  it('confines everything to the workspace root', async () => {
    const r = createDefaultRegistry();
    expect((await r.call('read_file', { path: '../escape.txt' }, ctx)).isError).toBe(true);
    expect((await r.call('write_file', { path: '../escape.txt', content: 'x' }, ctx)).isError).toBe(true);
  });
});

describe('search', () => {
  it('finds regex matches as file:line and honors include + maxResults', async () => {
    const r = createDefaultRegistry();
    await r.call('write_file', { path: 'a.ts', content: 'const needle = 1;\n// needle here\n' }, ctx);
    await r.call('write_file', { path: 'b.md', content: 'needle in md\n' }, ctx);
    const all = await r.call('search', { pattern: 'needle' }, ctx);
    expect(all.output).toMatch(/a\.ts:1:/);
    expect(all.output).toMatch(/b\.md:1:/);
    const ts = await r.call('search', { pattern: 'needle', include: '*.ts' }, ctx);
    expect(ts.output).toMatch(/a\.ts/);
    expect(ts.output).not.toMatch(/b\.md/);
    const capped = await r.call('search', { pattern: 'needle', maxResults: 1 }, ctx);
    expect(capped.metadata).toMatchObject({ truncated: true });
  });
  it('rejects invalid regex', async () => {
    const r = createDefaultRegistry();
    expect((await r.call('search', { pattern: '([' }, ctx)).isError).toBe(true);
  });
});

describe('run_terminal', () => {
  it('runs commands and captures output', async () => {
    const r = createDefaultRegistry();
    const res = await r.call('run_terminal', { command: 'echo hello-sunday' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.output).toMatch(/hello-sunday/);
    expect(res.metadata).toMatchObject({ exitCode: 0 });
  });
  it('reports non-zero exits with output', async () => {
    const r = createDefaultRegistry();
    const cmd = process.platform === 'win32' ? 'exit 3' : 'sh -c "echo oops >&2; exit 3"';
    const res = await r.call('run_terminal', { command: cmd }, ctx);
    expect(res.isError).toBe(true);
    expect(res.metadata).toMatchObject({ exitCode: 3 });
  });
  it('kills commands that exceed timeoutMs', async () => {
    const r = createDefaultRegistry();
    const cmd = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
    const res = await r.call('run_terminal', { command: cmd, timeoutMs: 800 }, ctx);
    expect(res.metadata).toMatchObject({ timedOut: true });
    expect(res.isError).toBe(true);
  }, 10000);
});

describe('git tools', () => {
  async function initRepo(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sunday-git-'));
    await git(dir, ['init', '-q']);
    await git(dir, ['config', 'user.email', 't@t']);
    await git(dir, ['config', 'user.name', 't']);
    await fs.writeFile(path.join(dir, 'f.txt'), 'v1\n');
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '-qm', 'first']);
    return dir;
  }
  it('status, log and diff round-trip', async () => {
    const dir = await initRepo();
    const r = createDefaultRegistry();
    const c = { cwd: dir };
    expect((await r.call('git_status', {}, c)).output).toMatch(/clean/);
    expect((await r.call('git_log', {}, c)).output).toMatch(/first/);
    await fs.writeFile(path.join(dir, 'f.txt'), 'v2\n');
    expect((await r.call('git_status', {}, c)).output).toMatch(/ M f\.txt/);
    const diff = await r.call('git_diff', {}, c);
    expect(diff.output).toMatch(/v2/);
  });
  it('errors outside a repo', async () => {
    const r = createDefaultRegistry();
    expect((await r.call('git_status', {}, ctx)).isError).toBe(true);
  });
});

describe('registry', () => {
  it('exposes definitions and rejects unknown tools / bad args', async () => {
    const r = createDefaultRegistry();
    expect(r.names()).toContain('run_terminal');
    expect(r.definitions().every((d) => typeof d.name === 'string')).toBe(true);
    expect((await r.call('nope', {}, ctx)).isError).toBe(true);
    expect((await r.call('read_file', { path: 42 }, ctx)).isError).toBe(true);
  });
});
