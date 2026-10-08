// Tests for skills-marketplace/registry.ts: strict schema validation,
// malformed entries rejected, name sanitization, download-URL safety.
import { describe, expect, it } from 'vitest';
import {
  isSafeDownloadUrl,
  parseRegistry,
  sanitizeSkillName,
} from './registry.js';

const goodEntry = {
  name: 'hello-sunday',
  description: 'Example skill.',
  author: 'Sunday',
  version: '1.0.0',
  downloadUrl: 'https://raw.githubusercontent.com/Vivek492005/Sunday/main/x.md',
};

describe('parseRegistry', () => {
  it('accepts a well-formed registry', () => {
    const r = parseRegistry({ skills: [goodEntry] });
    expect(r.rejected).toEqual([]);
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0].name).toBe('hello-sunday');
  });

  it('tolerates extra fields (e.g. "example")', () => {
    const r = parseRegistry({ skills: [{ ...goodEntry, example: true, extra: 1 }] });
    expect(r.rejected).toEqual([]);
    expect(r.skills).toHaveLength(1);
  });

  it('rejects malformed entries individually, keeps the good ones', () => {
    const r = parseRegistry({
      skills: [
        goodEntry,
        { ...goodEntry, name: '../evil' },
        { ...goodEntry, name: 'bad2', downloadUrl: 'http://insecure.example.com/x' },
        { ...goodEntry, name: 'bad3', version: 'not-semver' },
        { ...goodEntry, name: 'bad4', description: '' },
        { name: 'bad5' }, // missing description/author/version/downloadUrl
        'not-an-object',
      ],
    });
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0].name).toBe('hello-sunday');
    expect(r.rejected).toHaveLength(6);
    expect(r.rejected.map((x) => x.index)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const rej of r.rejected) expect(rej.reason).toBeTruthy();
  });

  it('rejects duplicate names', () => {
    const r = parseRegistry({ skills: [goodEntry, { ...goodEntry }] });
    expect(r.skills).toHaveLength(1);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].reason).toContain('duplicate');
  });

  it('rejects a malformed top-level shape', () => {
    for (const doc of [null, {}, { skills: 'nope' }, []]) {
      const r = parseRegistry(doc);
      expect(r.skills).toEqual([]);
      expect(r.rejected).toHaveLength(1);
    }
  });

  it('validates the optional hash pin', () => {
    const h = 'sha256:' + 'ab'.repeat(32);
    const ok = parseRegistry({ skills: [{ ...goodEntry, hash: h }] });
    expect(ok.rejected).toEqual([]);
    expect(ok.skills[0].hash).toBe(h);
    const bad = parseRegistry({ skills: [{ ...goodEntry, hash: 'md5:1234' }] });
    expect(bad.skills).toEqual([]);
    expect(bad.rejected).toHaveLength(1);
  });
});

describe('sanitizeSkillName', () => {
  it('accepts lowercase alphanumerics and dashes', () => {
    expect(sanitizeSkillName('hello-sunday')).toBe('hello-sunday');
    expect(sanitizeSkillName('a1-b2')).toBe('a1-b2');
  });

  it('rejects path traversal and friends', () => {
    for (const bad of [
      '../evil', '..', '.', 'a/b', 'a\\b', '', 'UPPER', 'with space', 'under_score',
      'semi;colon', 'x'.repeat(65), null, undefined, 42, {},
    ]) {
      expect(sanitizeSkillName(bad)).toBeUndefined();
    }
  });
});

describe('shipped community-skills.json', () => {
  it('parses with zero rejections', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
    const doc = JSON.parse(readFileSync(join(root, 'community-skills.json'), 'utf8'));
    const r = parseRegistry(doc);
    expect(r.rejected).toEqual([]);
    expect(r.skills.length).toBeGreaterThan(0);
    for (const s of r.skills) {
      expect(isSafeDownloadUrl(s.downloadUrl)).toBe(true);
    }
  });
});

describe('isSafeDownloadUrl', () => {
  it('requires absolute https: without credentials', () => {
    expect(isSafeDownloadUrl('https://example.com/skill.md')).toBe(true);
    expect(isSafeDownloadUrl('http://example.com/skill.md')).toBe(false);
    expect(isSafeDownloadUrl('https://user:pass@example.com/x')).toBe(false);
    expect(isSafeDownloadUrl('ftp://example.com/x')).toBe(false);
    expect(isSafeDownloadUrl('/relative/path')).toBe(false);
    expect(isSafeDownloadUrl('not a url')).toBe(false);
    expect(isSafeDownloadUrl('')).toBe(false);
    expect(isSafeDownloadUrl(undefined)).toBe(false);
  });
});
