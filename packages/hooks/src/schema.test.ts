import { describe, expect, it } from 'vitest';
import { parseHooksFile, tryParseHooksFile } from './schema.js';

const VALID = {
  version: 1,
  hooks: [
    {
      name: 'block-env',
      event: 'pre_tool',
      match: { tools: ['read_file'], paths: ['**/.env'] },
      actions: [{ type: 'block', reason: 'nope' }],
    },
    {
      name: 'fmt',
      event: 'post_edit',
      actions: [
        { type: 'run_command', command: 'npx', args: ['prettier', '--write', '{file}'] },
        { type: 'annotate', text: 'formatted' },
      ],
    },
  ],
};

describe('schema', () => {
  it('parses a valid hooks file', () => {
    const f = parseHooksFile(VALID);
    expect(f.hooks).toHaveLength(2);
    expect(f.hooks[0].enabled).toBe(true); // default
  });
  it('rejects unknown events', () => {
    expect(() =>
      parseHooksFile({ version: 1, hooks: [{ name: 'x', event: 'nope', actions: [] }] }),
    ).toThrow();
  });
  it('rejects empty actions', () => {
    expect(() =>
      parseHooksFile({ version: 1, hooks: [{ name: 'x', event: 'pre_tool', actions: [] }] }),
    ).toThrow();
  });
  it('rejects bad version', () => {
    expect(() => parseHooksFile({ version: 2, hooks: [] })).toThrow();
  });
  it('tryParse returns null on invalid', () => {
    expect(tryParseHooksFile({ version: 1 })).toBeNull();
    expect(tryParseHooksFile(null)).toBeNull();
  });
  it('modify_input only allows whitelisted ops', () => {
    expect(() =>
      parseHooksFile({
        version: 1,
        hooks: [
          {
            name: 'x',
            event: 'pre_tool',
            actions: [{ type: 'modify_input', op: 'delete_arg', key: 'a', value: 'b' }],
          },
        ],
      }),
    ).toThrow();
  });
});
