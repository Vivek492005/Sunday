/**
 * Tiny frontmatter parser for SUNDAY markdown files (SKILL.md, rules).
 *
 * Supports only the simple `key: value` subset of YAML used in these files:
 *   - scalar values: strings (optionally single/double quoted), booleans
 *     (`true`/`false`), numbers
 *   - block lists:
 *       globs:
 *         - "src/**"
 *         - "*.md"
 *   - inline lists: `globs: ["src/**", "*.md"]`
 *
 * Anything fancier is left as a raw string; the parser never throws on
 * malformed frontmatter — it returns what it could understand.
 */

export type FrontmatterValue = string | boolean | number | string[];
export type FrontmatterData = Record<string, FrontmatterValue>;

export interface ParsedFrontmatter {
  data: FrontmatterData;
  body: string;
}

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/;
const LIST_ITEM = /^\s*-\s+(.*)$/;

function parseScalar(raw: string): FrontmatterValue {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^[+-]?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[') && v.endsWith(']')) {
    return v
      .slice(1, -1)
      .split(',')
      .map((s) => parseScalar(s))
      .map((s) => String(s));
  }
  return v;
}

/**
 * Split a markdown document into `{ data, body }`.
 * If the document does not start with a `---` frontmatter fence,
 * `data` is `{}` and `body` is the whole document.
 */
export function parseFrontmatter(md: string): ParsedFrontmatter {
  const lines = md.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { data: {}, body: md };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---' || lines[i].trim() === '...') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    // No closing fence: treat the whole document as body.
    return { data: {}, body: md };
  }

  const data: FrontmatterData = {};
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    const item = LIST_ITEM.exec(line);
    if (item && currentKey !== null) {
      if (currentList === null) {
        currentList = [];
        data[currentKey] = currentList;
      }
      currentList.push(String(parseScalar(item[1])));
      continue;
    }

    const key = KEY_LINE.exec(line);
    if (key) {
      currentKey = key[1];
      currentList = null;
      const rawValue = key[2].trim();
      if (rawValue === '') {
        // Value may be a block list on the following lines; default to ''.
        data[currentKey] = '';
      } else {
        data[currentKey] = parseScalar(rawValue);
      }
      continue;
    }
    // Unknown line shape: reset list context, keep going.
    currentKey = null;
    currentList = null;
  }

  return { data, body: lines.slice(end + 1).join('\n') };
}

/** Coerce a frontmatter value into a string array (comma-split for strings). */
export function toStringArray(value: FrontmatterValue | undefined): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0);
  if (typeof value === 'boolean' || typeof value === 'number') return [String(value)];
  return value
    .split(/[\n,]/)
    .map((v) => v.trim().replace(/^["']|["']$/g, ''))
    .filter((v) => v.length > 0);
}

/** Coerce a frontmatter value into a string (first element for arrays). */
export function toStringValue(value: FrontmatterValue | undefined): string {
  if (value === undefined) return '';
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : '';
  return String(value);
}
