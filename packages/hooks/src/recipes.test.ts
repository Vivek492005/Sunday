import { describe, expect, it } from 'vitest';
import { buildRecipesFile, parseHooksFile, recipeNames } from './index.js';

describe('recipes', () => {
  it('all 5 recipes exist and produce valid hooks', () => {
    expect(recipeNames().sort()).toEqual(
      ['block-env-reads', 'changelog-update', 'format-on-edit', 'secret-scan', 'test-before-done'].sort(),
    );
    for (const name of recipeNames()) {
      const file = buildRecipesFile([name]);
      const parsed = parseHooksFile(file); // throws on invalid
      expect(parsed.hooks.length).toBeGreaterThan(0);
    }
  });
  it('block-env-reads blocks .env reads', () => {
    const file = buildRecipesFile(['block-env-reads']);
    const hook = file.hooks[0];
    expect(hook.event).toBe('pre_tool');
    expect(hook.actions[0].type).toBe('block');
  });
  it('unknown recipe throws', () => {
    expect(() => buildRecipesFile(['nope'])).toThrow(/unknown recipe/);
  });
});
