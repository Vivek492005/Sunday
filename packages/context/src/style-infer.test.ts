// Tests for project style inference (Group B2).
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  formatStyleForPrompt,
  inferStyle,
  loadStoredStyle,
  projectIdFor,
  saveStyle,
  styleFilePath,
} from './style-infer.js';

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sunday-style-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    if (rel.endsWith('.bin')) {
      writeFileSync(full, Buffer.from([0x00, 0x01, 0x02, 0xff]));
    } else {
      writeFileSync(full, content);
    }
  }
  return root;
}

const TS_STYLE = `import { helper } from './helper';
import fs from 'node:fs';

export function greetUser(userName: string): string {
  const greetingMessage = 'hello';
  const targetName = "world";
  return greetingMessage + ' ' + targetName;
}

export const configValues = {
  maxRetries: 3,
  timeoutMs: 1000,
};
`;

describe('inferStyle', () => {
  it('detects 2-space indent, single quotes, semicolons, camelCase, ESM', () => {
    const root = makeRepo({ 'src/a.ts': TS_STYLE, 'src/b.ts': TS_STYLE });
    const style = inferStyle(root);
    expect(style.indent.kind).toBe('spaces');
    expect(style.indent.size).toBe(2);
    expect(style.quotes).toBe('single');
    expect(style.semicolons).toBe('always');
    expect(style.imports).toBe('esm');
    expect(style.naming.camelCase).toBeGreaterThan(style.naming.snake_case);
  });

  it('detects tabs and double quotes', () => {
    const root = makeRepo({
      'main.go': 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}\n',
    });
    const style = inferStyle(root);
    expect(style.indent.kind).toBe('tabs');
    expect(style.indent.size).toBeNull();
    expect(style.quotes).toBe('double');
  });

  it('detects no-semicolon style and snake_case', () => {
    const root = makeRepo({
      'app.py': 'def compute_total(user_count):\n    base_value = 10\n    return base_value + user_count\n',
    });
    const style = inferStyle(root);
    expect(style.semicolons).toBe('never');
    expect(style.naming.snake_case).toBeGreaterThan(0);
  });

  it('detects CommonJS requires', () => {
    const root = makeRepo({
      'index.js': "const fs = require('node:fs')\nconst path = require('node:path')\nmodule.exports = { fs }\n",
    });
    const style = inferStyle(root);
    expect(style.imports).toBe('cjs');
  });

  it('skips binary files and node_modules', () => {
    const root = makeRepo({
      'src/a.ts': TS_STYLE,
      'asset.bin': '',
      'node_modules/dep/index.js': 'var x = require("y");\n',
    });
    const style = inferStyle(root);
    // node_modules CJS must not leak in: the only sampled file is ESM TS.
    expect(style.imports).toBe('esm');
    expect(style.quotes).toBe('single');
  });

  it('handles an empty repo without throwing', () => {
    const root = makeRepo({});
    const style = inferStyle(root);
    expect(style.indent.kind).toBe('unknown');
    expect(style.quotes).toBe('unknown');
    expect(style.semicolons).toBe('unknown');
    expect(style.imports).toBe('unknown');
    expect(formatStyleForPrompt(style)).toContain('No strong code-style signal');
  });
});

describe('projectIdFor / style persistence', () => {
  it('is a stable 16-char hash of the workspace root', () => {
    const root = makeRepo({ 'a.ts': TS_STYLE });
    const id = projectIdFor(root);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(projectIdFor(root)).toBe(id);
    expect(projectIdFor(join(root, 'sub'))).not.toBe(id);
  });

  it('round-trips save/load and rejects other roots', () => {
    process.env.SUNDAY_HOME = mkdtempSync(join(tmpdir(), 'sunday-home-'));
    try {
      const root = makeRepo({ 'a.ts': TS_STYLE });
      const style = inferStyle(root);
      expect(loadStoredStyle(root)).toBeNull();
      saveStyle(root, style);
      expect(styleFilePath(root)).toContain(projectIdFor(root));
      const loaded = loadStoredStyle(root);
      expect(loaded).toEqual(style);
      expect(loadStoredStyle(join(root, 'other'))).toBeNull();
    } finally {
      delete process.env.SUNDAY_HOME;
    }
  });
});

describe('formatStyleForPrompt', () => {
  it('produces a concise one-line summary', () => {
    const root = makeRepo({ 'src/a.ts': TS_STYLE });
    const summary = formatStyleForPrompt(inferStyle(root));
    expect(summary).toContain('2-space indent');
    expect(summary).toContain('single quotes');
    expect(summary).toContain('semicolons');
    expect(summary).toContain('camelCase');
    expect(summary).toContain('ESM imports');
  });
});
