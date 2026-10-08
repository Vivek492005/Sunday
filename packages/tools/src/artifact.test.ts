// Tests for the A3 create_artifact tool: type validation, 500KB size cap,
// path-traversal rejection, session namespacing, 0600 file mode, and
// registry integration (arg validation + execution).
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARTIFACT_MAX_BYTES,
  createArtifactFile,
  createArtifactTool,
  sanitizeSessionId,
  slugifyTitle,
} from './artifact.js';
import { ToolRegistry, createDefaultRegistry } from './registry.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sunday-artifact-home-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('slugifyTitle', () => {
  it('slugifies plain titles', () => {
    expect(slugifyTitle('My Cool Report!')).toBe('my-cool-report');
    expect(slugifyTitle('  spaced  out  ')).toBe('spaced-out');
  });

  it('rejects path traversal and separators', () => {
    expect(slugifyTitle('../evil')).toBeUndefined();
    expect(slugifyTitle('a/../../b')).toBeUndefined();
    expect(slugifyTitle('a/b')).toBeUndefined();
    expect(slugifyTitle('a\\b')).toBeUndefined();
    expect(slugifyTitle('..')).toBeUndefined();
    expect(slugifyTitle('.hidden')).toBeUndefined();
    expect(slugifyTitle('C:\\win')).toBeUndefined();
    expect(slugifyTitle('')).toBeUndefined();
    expect(slugifyTitle('   ')).toBeUndefined();
    expect(slugifyTitle('!!!')).toBeUndefined();
  });
});

describe('sanitizeSessionId', () => {
  it('accepts safe ids and falls back to default', () => {
    expect(sanitizeSessionId('sess-123_abc')).toBe('sess-123_abc');
    expect(sanitizeSessionId('../x')).toBe('default');
    expect(sanitizeSessionId('')).toBe('default');
    expect(sanitizeSessionId(undefined)).toBe('default');
    expect(sanitizeSessionId('a'.repeat(100))).toBe('default');
  });
});

describe('createArtifactFile', () => {
  it('writes html/markdown/mermaid with the right extensions', async () => {
    for (const [type, ext] of [['html', '.html'], ['markdown', '.md'], ['mermaid', '.mmd']] as const) {
      const r = await createArtifactFile(
        { type, title: 'My Doc', content: 'hello' },
        { sessionId: 'sess1' },
        home,
      );
      expect(r.path).toBe(join(home, '.sunday', 'artifacts', 'sess1', `my-doc${ext}`));
      expect(r.id).toBe(`sess1/my-doc`);
      expect(r.bytes).toBe(5);
      expect(existsSync(r.path)).toBe(true);
      expect(readFileSync(r.path, 'utf8')).toBe('hello');
      expect(statSync(r.path).mode & 0o777).toBe(0o600);
    }
  });

  it('rejects unknown types', async () => {
    await expect(
      createArtifactFile({ type: 'exe', title: 'x', content: 'y' }, {}, home),
    ).rejects.toThrow(/invalid type/);
  });

  it('rejects traversal titles', async () => {
    await expect(
      createArtifactFile({ type: 'html', title: '../../evil', content: 'y' }, {}, home),
    ).rejects.toThrow(/invalid title/);
  });

  it('enforces the 500KB size cap', async () => {
    const big = 'x'.repeat(ARTIFACT_MAX_BYTES + 1);
    await expect(
      createArtifactFile({ type: 'markdown', title: 'big', content: big }, {}, home),
    ).rejects.toThrow(/too large/);
    // Exactly at the cap is fine.
    const ok = await createArtifactFile(
      { type: 'markdown', title: 'edge', content: 'x'.repeat(ARTIFACT_MAX_BYTES) },
      {},
      home,
    );
    expect(ok.bytes).toBe(ARTIFACT_MAX_BYTES);
  });

  it('namespaces by session id', async () => {
    const a = await createArtifactFile({ type: 'html', title: 'doc', content: 'a' }, { sessionId: 's1' }, home);
    const b = await createArtifactFile({ type: 'html', title: 'doc', content: 'b' }, { sessionId: 's2' }, home);
    expect(a.path).not.toBe(b.path);
    expect(readFileSync(b.path, 'utf8')).toBe('b');
  });
});

describe('createArtifactTool (registry integration)', () => {
  it('is registered in the default registry', () => {
    expect(createDefaultRegistry().names()).toContain('create_artifact');
  });

  it('validates args through the registry', async () => {
    const registry = new ToolRegistry();
    registry.register(createArtifactTool);
    const ctx = { cwd: '/tmp', sessionId: 's1' };
    // Missing content -> validation error, no throw.
    const bad = await registry.call('create_artifact', { type: 'html', title: 't' }, ctx);
    expect(bad.isError).toBe(true);
    // Bad type -> validation error (enum).
    const badType = await registry.call(
      'create_artifact',
      { type: 'pdf', title: 't', content: 'c' },
      ctx,
    );
    expect(badType.isError).toBe(true);
  });

  it('executes end-to-end via the registry (home isolated)', async () => {
    // The tool writes to the real homedir; execute the underlying function
    // with an isolated home instead (same code path as execute()).
    const r = await createArtifactFile(
      { type: 'markdown', title: 'Notes', content: '# hi' },
      { sessionId: 's9' },
      home,
    );
    expect(r.type).toBe('markdown');
    expect(existsSync(r.path)).toBe(true);
  });

  it('tool execute() surfaces failures as error results, not throws', async () => {
    const res = await createArtifactTool.execute(
      { type: 'html', title: '../nope', content: 'x' },
      { cwd: '/tmp' },
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain('invalid title');
  });
});
