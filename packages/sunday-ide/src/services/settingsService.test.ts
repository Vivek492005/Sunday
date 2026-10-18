import { describe, expect, it } from 'vitest';
import { withDefaults, DEFAULT_SETTINGS } from './settingsService';

describe('withDefaults', () => {
  it('fills missing keys from defaults', () => {
    const merged = withDefaults({ editorFontSize: 16 });
    expect(merged.editorFontSize).toBe(16);
    expect(merged.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(merged.editorTabSize).toBe(DEFAULT_SETTINGS.editorTabSize);
  });

  it('returns a copy of defaults for empty patch', () => {
    const merged = withDefaults({});
    expect(merged).toEqual(DEFAULT_SETTINGS);
    expect(merged).not.toBe(DEFAULT_SETTINGS);
  });
});
