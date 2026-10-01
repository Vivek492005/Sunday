import { describe, expect, it } from 'vitest';
import { parseFrontmatter, toStringArray, toStringValue } from './frontmatter.js';

describe('parseFrontmatter', () => {
  it('parses name/description and returns the body', () => {
    const md = `---\nname: deploy\ndescription: Deploy the app\n---\n\n# Deploy\n\nRun it.\n`;
    const { data, body } = parseFrontmatter(md);
    expect(data['name']).toBe('deploy');
    expect(data['description']).toBe('Deploy the app');
    expect(body).toBe('\n# Deploy\n\nRun it.\n');
  });

  it('returns empty data when there is no frontmatter', () => {
    const md = '# Just a doc\n\nNo fence here.\n';
    const { data, body } = parseFrontmatter(md);
    expect(data).toEqual({});
    expect(body).toBe(md);
  });

  it('treats an unclosed fence as no frontmatter', () => {
    const md = '---\nname: broken\n\nno closing fence';
    const { data, body } = parseFrontmatter(md);
    expect(data).toEqual({});
    expect(body).toBe(md);
  });

  it('parses booleans, numbers, quoted strings, block lists and inline lists', () => {
    const md = `---\nalwaysApply: true\ncount: 3\ntitle: "hello: world"\nglobs:\n  - "**/*.ts"\n  - src/*\ninline: ["a", "b"]\n---\nbody\n`;
    const { data } = parseFrontmatter(md);
    expect(data['alwaysApply']).toBe(true);
    expect(data['count']).toBe(3);
    expect(data['title']).toBe('hello: world');
    expect(data['globs']).toEqual(['**/*.ts', 'src/*']);
    expect(data['inline']).toEqual(['a', 'b']);
  });

  it('parses false booleans and single-quoted strings', () => {
    const { data } = parseFrontmatter(`---\nalwaysApply: false\ndesc: 'it works'\n---\nx\n`);
    expect(data['alwaysApply']).toBe(false);
    expect(data['desc']).toBe('it works');
  });

  it('ignores blank lines and # comments inside frontmatter', () => {
    const { data } = parseFrontmatter(`---\n# a comment\n\nname: x\n---\nbody`);
    expect(data).toEqual({ name: 'x' });
  });

  it('leaves malformed lines alone without throwing', () => {
    const { data, body } = parseFrontmatter(`---\nname: ok\n::: not yaml :::\n---\nbody`);
    expect(data['name']).toBe('ok');
    expect(body).toBe('body');
  });
});

describe('toStringArray', () => {
  it('splits comma-separated strings and passes arrays through', () => {
    expect(toStringArray('a, b ,c')).toEqual(['a', 'b', 'c']);
    expect(toStringArray(['a', ' b '])).toEqual(['a', 'b']);
    expect(toStringArray(true)).toEqual(['true']);
    expect(toStringArray(undefined)).toEqual([]);
  });
});

describe('toStringValue', () => {
  it('coerces values to strings', () => {
    expect(toStringValue('x')).toBe('x');
    expect(toStringValue(['a', 'b'])).toBe('a');
    expect(toStringValue(undefined)).toBe('');
    expect(toStringValue(42)).toBe('42');
  });
});
