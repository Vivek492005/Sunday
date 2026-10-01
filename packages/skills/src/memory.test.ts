import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SecretRefusedError, loadMemory, remember, redactSecrets, redactionMarker } from './memory.js';

let ws: string;
let user: string;

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'mem-ws-'));
  user = await mkdtemp(join(tmpdir(), 'mem-user-'));
});

function opts() {
  return { workspaceDir: ws, userDir: user, date: '2026-10-01' };
}

describe('loadMemory', () => {
  it('is opt-in: missing files are omitted', async () => {
    expect(await loadMemory(opts())).toEqual({});
  });

  it('loads existing workspace and user files', async () => {
    await mkdir(join(ws, '.sunday'), { recursive: true });
    await writeFile(join(ws, '.sunday', 'memory.md'), '- 2026-09-01: ws note\n', 'utf8');
    await mkdir(join(user, '.sunday'), { recursive: true });
    await writeFile(join(user, '.sunday', 'memory.md'), '- 2026-09-02: user note\n', 'utf8');
    const mem = await loadMemory(opts());
    expect(mem.workspace).toContain('ws note');
    expect(mem.user).toContain('user note');
  });
});

describe('remember', () => {
  it('appends a dated entry to the workspace memory file', async () => {
    const { appended } = await remember('the user likes terse replies', 'workspace', opts());
    expect(appended).toBe('- 2026-10-01: the user likes terse replies');
    const mem = await loadMemory(opts());
    expect(mem.workspace).toBe('- 2026-10-01: the user likes terse replies\n');
    expect(mem.user).toBeUndefined();
  });

  it('appends to the user scope and preserves existing entries', async () => {
    await remember('first note', 'user', opts());
    const { appended, diff } = await remember('second note', 'user', {
      ...opts(),
      date: '2026-10-02',
    });
    expect(appended).toBe('- 2026-10-02: second note');
    const mem = await loadMemory(opts());
    expect(mem.user).toBe('- 2026-10-01: first note\n- 2026-10-02: second note\n');
    // Diff shows old tail -> new tail.
    expect(diff).toContain('- 2026-10-01: first note');
    expect(diff).toContain('- 2026-10-02: second note');
    expect(diff).toContain('before');
    expect(diff).toContain('after');
  });

  it('refuses empty text', async () => {
    await expect(remember('   ', 'workspace', opts())).rejects.toThrow('empty');
  });

  it.each([
    ['openai key', 'api key is sk-abcDEF1234567890 done'],
    ['github pat', 'token ghp_abcdefghij1234567890 here'],
    ['github oauth', 'gho_abcdefghij1234567890 here'],
    ['fine-grained pat', 'github_pat_abcdefghij1234567890 here'],
    ['aws access key', 'AKIAIOSFODNN7EXAMPLE here'],
    ['aws secret assignment', 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCY'],
    ['private key block', '-----BEGIN RSA PRIVATE KEY-----\nMIIE...'],
    ['password assignment', 'password = hunter2'],
    ['passwd assignment', 'passwd: hunter2'],
    ['client secret', 'client_secret=hunter2hunter2hunter2'],
    ['api key assignment', 'api_key: hunter2hunter2hunter2'],
    ['slack token', 'xoxb-1234567890-abcdefghij here'],
    ['google api key', 'AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz12'],
  ])('refuses secrets (%s) and writes nothing', async (_label, text) => {
    await expect(remember(text, 'workspace', opts())).rejects.toBeInstanceOf(SecretRefusedError);
    expect(await loadMemory(opts())).toEqual({});
  });

  it('does not mistake ordinary prose for a secret', async () => {
    const { appended } = await remember('ask about the password policy doc', 'workspace', opts());
    expect(appended).toContain('password policy doc');
  });
});

describe('redactSecrets', () => {
  it('replaces full-token patterns with labelled markers', () => {
    const out = redactSecrets('key=sk-abcdef1234567890 and ghp_abcdefghijklmnopqrst');
    expect(out).toContain('[REDACTED:openai-key]');
    expect(out).toContain('[REDACTED:github-pat]');
    expect(out).not.toContain('sk-abcdef1234567890');
    expect(out).not.toContain('ghp_abcdefghijklmnopqrst');
  });

  it('redacts the value of assignment-style patterns too', () => {
    const out = redactSecrets('config: password = hunter2; api_key: "abc123def456"');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('abc123def456');
    expect(out).toContain('[REDACTED:password-assignment]');
    expect(out).toContain('[REDACTED:api-key-assignment]');
  });

  it('redacts a whole PEM private-key block, not just the header', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA7b...',
      '...more base64...',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = redactSecrets(`before\n${pem}\nafter`);
    expect(out).not.toContain('MIIEpAIBAAKCAQEA7b');
    expect(out).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(out).toContain('[REDACTED:private-key-block]');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('leaves ordinary prose untouched', () => {
    const prose = 'ask about the password policy doc';
    expect(redactSecrets(prose)).toBe(prose);
  });

  it('redactionMarker names the pattern, never the value', () => {
    expect(redactionMarker('openai-key')).toBe('[REDACTED:openai-key]');
  });
});
