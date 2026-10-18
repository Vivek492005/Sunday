/**
 * VS Code `settings.json` → Sunday settings patch.
 *
 * Maps the editor/terminal/theme keys Sunday understands; everything else
 * is counted and reported as unmapped (the user can file follow-ups or the
 * report lists the top offenders).
 */
import type { SundaySettingsPatch, UnconvertibleItem } from './types.js';

export interface SettingsConversion {
  patch: SundaySettingsPatch;
  mapped: string[];
  unmapped: string[];
}

/**
 * Convert a parsed VS Code settings object. Pure — pass JSON.parse output.
 */
export function convertVscodeSettings(settings: Record<string, unknown>): SettingsConversion {
  const patch: SundaySettingsPatch = {};
  const mapped: string[] = [];
  const unmapped: string[] = [];

  const take = (key: string): unknown =>
    key in settings ? (settings as Record<string, unknown>)[key] : undefined;

  const fontSize = take('editor.fontSize');
  if (typeof fontSize === 'number' && fontSize > 0) {
    patch.editorFontSize = fontSize;
    mapped.push('editor.fontSize');
  }
  const fontFamily = take('editor.fontFamily');
  if (typeof fontFamily === 'string' && fontFamily.trim()) {
    patch.editorFontFamily = fontFamily;
    mapped.push('editor.fontFamily');
  }
  const tabSize = take('editor.tabSize');
  if (typeof tabSize === 'number' && tabSize > 0) {
    patch.editorTabSize = tabSize;
    mapped.push('editor.tabSize');
  }
  const wordWrap = take('editor.wordWrap');
  if (typeof wordWrap === 'string') {
    // "off" → false; "on" | "wordWrapColumn" | "bounded" → true
    patch.editorWordWrap = wordWrap !== 'off';
    mapped.push('editor.wordWrap');
  }
  const termFontSize = take('terminal.integrated.fontSize');
  if (typeof termFontSize === 'number' && termFontSize > 0) {
    patch.terminalFontSize = termFontSize;
    mapped.push('terminal.integrated.fontSize');
  }
  const theme = take('workbench.colorTheme');
  if (typeof theme === 'string' && theme.trim()) {
    patch.theme = /light/i.test(theme) ? 'sunday-light' : 'sunday-dark';
    mapped.push('workbench.colorTheme');
  }

  const KNOWN = new Set(mapped);
  for (const key of Object.keys(settings)) {
    if (!KNOWN.has(key)) unmapped.push(key);
  }
  return { patch, mapped, unmapped };
}

/** Parse raw settings.json text; returns null on invalid JSON. */
export function parseSettingsJson(raw: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Build unconvertible report items for keys we could not map. */
export function unmappedSettingsItems(sourceLabel: string, unmapped: string[]): UnconvertibleItem[] {
  if (unmapped.length === 0) return [];
  const shown = unmapped.slice(0, 8).join(', ');
  const more = unmapped.length > 8 ? ` (+${unmapped.length - 8} more)` : '';
  return [
    {
      source: sourceLabel,
      item: `${unmapped.length} setting key(s) have no Sunday equivalent yet`,
      reason: `Not mapped: ${shown}${more}. Sunday will keep its own defaults for these.`,
    },
  ];
}
