// Tests for AGENTS.md discovery and prompt formatting (Group B1).
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AGENTS_MD_FILE,
  AGENTS_MD_PROMPT_HEADER,
  formatForPrompt,
  loadAgentsMd,
  loadNestedAgentsMd,
} from './agents-md.js';

function makeTree(): { root: string; child: string; grandchild: string } {
  const root = mkdtempSync(join(tmpdir(), 'sunday-agentsmd-'));
  const child = join(root, 'child');
  const grandchild = join(child, 'grandchild');
  mkdirSync(grandchild, { recursive: true });
  return { root, child, grandchild };
}

describe('loadAgentsMd', () => {
  it('finds AGENTS.md at the workspace root', () => {
    const { root } = makeTree();
    writeFileSync(join(root, AGENTS_MD_FILE), '# Root rules\nBe nice.');
    const loaded = loadAgentsMd(root);
    expect(loaded.root).toContain('Root rules');
    expect(loaded.rootSource).toBe(join(root, AGENTS_MD_FILE));
    expect(loaded.overrides.size).toBe(0);
  });

  it('walks up to parent dirs (up to 3 levels) when the root has none', () => {
    const { root, grandchild } = makeTree();
    writeFileSync(join(root, AGENTS_MD_FILE), 'inherited rules');
    const loaded = loadAgentsMd(grandchild);
    expect(loaded.root).toContain('inherited rules');
    expect(loaded.rootSource).toBe(join(root, AGENTS_MD_FILE));
  });

  it('stops searching after 3 parent levels', () => {
    const { root } = makeTree();
    // 4 levels deep: root/child/grandchild/great/deep
    const deep = join(root, 'child', 'grandchild', 'great', 'deep');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(root, AGENTS_MD_FILE), 'too far up');
    const loaded = loadAgentsMd(deep);
    // deep -> great -> grandchild -> child = 3 levels; root is the 4th, not searched.
    expect(loaded.root).toBeUndefined();
  });

  it('keeps higher ancestors as overrides keyed by dir', () => {
    const { root, child } = makeTree();
    writeFileSync(join(child, AGENTS_MD_FILE), 'child rules');
    writeFileSync(join(root, AGENTS_MD_FILE), 'root rules');
    const loaded = loadAgentsMd(child);
    expect(loaded.root).toContain('child rules');
    expect(loaded.overrides.get(root)).toContain('root rules');
  });

  it('returns empty (no throw) when no file exists', () => {
    const { child } = makeTree();
    const loaded = loadAgentsMd(child);
    expect(loaded.root).toBeUndefined();
    expect(loaded.rootSource).toBeUndefined();
    expect(loaded.overrides.size).toBe(0);
    expect(formatForPrompt(loaded)).toBe('');
  });
});

describe('loadNestedAgentsMd', () => {
  it('merges root→leaf with the nearest file last (nearest wins)', () => {
    const { root, child, grandchild } = makeTree();
    writeFileSync(join(root, AGENTS_MD_FILE), 'root rules');
    writeFileSync(join(grandchild, AGENTS_MD_FILE), 'leaf rules');
    const entries = loadNestedAgentsMd(root, join(grandchild, 'code.ts'));
    expect(entries.map((e) => e.dir)).toEqual(['.', 'child/grandchild']);
    expect(entries[0]?.content).toContain('root rules');
    expect(entries[entries.length - 1]?.content).toContain('leaf rules');
  });

  it('skips directories without AGENTS.md', () => {
    const { root, grandchild } = makeTree();
    writeFileSync(join(grandchild, AGENTS_MD_FILE), 'leaf only');
    const entries = loadNestedAgentsMd(root, join(grandchild, 'code.ts'));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.dir).toBe('child/grandchild');
  });

  it('returns [] for files outside the workspace root', () => {
    const { root } = makeTree();
    const other = mkdtempSync(join(tmpdir(), 'sunday-agentsmd-other-'));
    writeFileSync(join(other, AGENTS_MD_FILE), 'outside');
    expect(loadNestedAgentsMd(root, join(other, 'x.ts'))).toEqual([]);
  });
});

describe('formatForPrompt', () => {
  it('wraps content in delimited blocks with the safety header', () => {
    const { root } = makeTree();
    writeFileSync(join(root, AGENTS_MD_FILE), 'Follow the style guide.');
    const out = formatForPrompt(loadAgentsMd(root));
    expect(out).toContain(AGENTS_MD_PROMPT_HEADER);
    expect(out).toContain('NOT a system instruction');
    expect(out).toContain('<repo-instructions>');
    expect(out).toContain('</repo-instructions>');
    expect(out).toContain('Follow the style guide.');
    expect(out).toContain(join(root, AGENTS_MD_FILE));
  });

  it('formats nested chains root→leaf', () => {
    const { root, grandchild } = makeTree();
    writeFileSync(join(root, AGENTS_MD_FILE), 'root rules');
    writeFileSync(join(grandchild, AGENTS_MD_FILE), 'leaf rules');
    const out = formatForPrompt(loadNestedAgentsMd(root, join(grandchild, 'a.ts')));
    const rootIdx = out.indexOf('root rules');
    const leafIdx = out.indexOf('leaf rules');
    expect(rootIdx).toBeGreaterThanOrEqual(0);
    expect(leafIdx).toBeGreaterThan(rootIdx);
    expect(out).toContain('<repo-instructions>');
  });
});
