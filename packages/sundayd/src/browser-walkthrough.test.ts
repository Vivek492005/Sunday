import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '@sunday/tools';
import type { BrowserdManager } from './browserd.js';
import {
  defaultSessionId,
  resolveSessionMediaDir,
  sanitizeSessionId,
  savePng,
  writeTextFile,
} from './browser-media.js';
import { BROWSER_WALKTHROUGH_TOOL_NAME, registerBrowserWalkthroughTools } from './browser-walkthrough.js';

// 1x1 transparent PNG, used as canned screenshot bytes.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_BASE64, 'base64');

function tmpWs(): string {
  return mkdtempSync(join(tmpdir(), 'sunday-wt-'));
}

/** Plain stub for BrowserdManager — no real browserd, no browser. */
function stubManager(overrides: Partial<{ enabled: boolean; png: Buffer | string; failScreenshot: boolean }> = {}) {
  const enabled = overrides.enabled ?? true;
  return {
    screenshotCalls: 0,
    isBrowserEnabled: () => enabled,
    async screenshot(): Promise<Buffer | string> {
      (this as { screenshotCalls: number }).screenshotCalls++;
      if (overrides.failScreenshot) throw new Error('boom');
      return overrides.png ?? PNG;
    },
  };
}

function registered(manager: unknown, workspaceDir: string, sessionId = 'sess-1') {
  const registry = new ToolRegistry();
  registerBrowserWalkthroughTools(registry, manager as BrowserdManager, { workspaceDir, sessionId });
  return registry;
}

const CTX = { cwd: '/tmp/ws' };

describe('browser-media', () => {
  it('resolves the session media dir layout and creates it', () => {
    const ws = tmpWs();
    const dir = resolveSessionMediaDir(ws, 'my-session');
    expect(dir).toBe(join(ws, '.sunday', 'artifacts', 'my-session', 'media'));
    expect(readdirSync(join(ws, '.sunday', 'artifacts', 'my-session'))).toEqual(['media']);
  });

  it('defaults to browser-<yyyymmdd>-<hhmmss>', () => {
    expect(defaultSessionId()).toMatch(/^browser-\d{8}-\d{6}$/);
  });

  it('sanitizes traversal attempts in the session id', () => {
    const ws = tmpWs();
    const dir = resolveSessionMediaDir(ws, '../../evil/x');
    expect(dir).toBe(join(ws, '.sunday', 'artifacts', sanitizeSessionId('../../evil/x'), 'media'));
    expect(sanitizeSessionId('../../evil/x')).not.toContain('..');
    expect(sanitizeSessionId('')).toMatch(/^browser-\d{8}-\d{6}$/);
  });

  it('savePng dedups: step-1.png then step-1-2.png, no clobber', () => {
    const ws = tmpWs();
    const dir = resolveSessionMediaDir(ws, 'dedupe');
    const a = savePng(PNG, dir, 'step-1');
    const b = savePng(Buffer.from('other'), dir, 'step-1');
    expect(a).toBe(join(dir, 'step-1.png'));
    expect(b).toBe(join(dir, 'step-1-2.png'));
    expect(readFileSync(a).equals(PNG)).toBe(true);
    expect(readFileSync(b).toString()).toBe('other');
  });

  it('writeTextFile dedups markdown before the extension', () => {
    const ws = tmpWs();
    const dir = resolveSessionMediaDir(ws, 'md');
    const a = writeTextFile(dir, 'walkthrough.md', 'first');
    const b = writeTextFile(dir, 'walkthrough.md', 'second');
    expect(a).toBe(join(dir, 'walkthrough.md'));
    expect(b).toBe(join(dir, 'walkthrough-2.md'));
    expect(readFileSync(a, 'utf8')).toBe('first');
    expect(readFileSync(b, 'utf8')).toBe('second');
  });
});

describe('browser_walkthrough tool', () => {
  it('registers exactly one tool, dangerous', () => {
    const registry = registered(stubManager(), tmpWs());
    expect(registry.names()).toEqual([BROWSER_WALKTHROUGH_TOOL_NAME]);
    expect(registry.get(BROWSER_WALKTHROUGH_TOOL_NAME).definition.dangerous).toBe(true);
  });

  it('writes walkthrough.md with narrations in order and correct image links', async () => {
    const ws = tmpWs();
    const manager = stubManager();
    const registry = registered(manager, ws, 'walk-1');
    const tool = registry.get(BROWSER_WALKTHROUGH_TOOL_NAME);
    const result = await tool.execute(
      {
        title: 'Demo flow',
        steps: [
          { narration: 'Opened the homepage.', screenshot: true },
          { narration: 'Clicked the sign-in button.', screenshot: false },
          { narration: 'The sign-in form is visible.', screenshot: true },
        ],
      },
      CTX,
    );
    expect(result.isError).toBeFalsy();
    expect(result.output).toBe(
      `walkthrough written to ${join(ws, '.sunday', 'artifacts', 'walk-1', 'walkthrough.md')} (3 steps, 2 screenshots)`,
    );
    expect(result.metadata).toEqual({
      path: join(ws, '.sunday', 'artifacts', 'walk-1', 'walkthrough.md'),
      steps: 3,
      screenshots: 2,
    });
    expect(manager.screenshotCalls).toBe(2);

    const md = readFileSync(result.metadata!.path as string, 'utf8');
    expect(md.startsWith('# Demo flow\n')).toBe(true);
    const step1 = md.indexOf('## Step 1');
    const step2 = md.indexOf('## Step 2');
    const step3 = md.indexOf('## Step 3');
    expect([step1, step2, step3].every((i) => i >= 0)).toBe(true);
    expect(step1).toBeLessThan(step2);
    expect(step2).toBeLessThan(step3);
    // Narrations appear under their own step sections, in order.
    expect(md.indexOf('Opened the homepage.')).toBeGreaterThan(step1);
    expect(md.indexOf('Clicked the sign-in button.')).toBeGreaterThan(step2);
    expect(md.indexOf('The sign-in form is visible.')).toBeGreaterThan(step3);
    // Screenshotted steps link to media/step-N.png; step 2 has no link.
    expect(md).toContain('![step 1](media/step-1.png)');
    expect(md).toContain('![step 3](media/step-3.png)');
    expect(md).not.toContain('step-2.png');
    // PNGs are real files with the canned bytes.
    const mediaDir = join(ws, '.sunday', 'artifacts', 'walk-1', 'media');
    expect(readdirSync(mediaDir).sort()).toEqual(['step-1.png', 'step-3.png']);
    expect(readFileSync(join(mediaDir, 'step-1.png')).equals(PNG)).toBe(true);
  });

  it('adapts base64 screenshot returns to PNG bytes', async () => {
    const ws = tmpWs();
    const registry = registered(stubManager({ png: PNG_BASE64 }), ws, 'b64');
    const result = await registry.get(BROWSER_WALKTHROUGH_TOOL_NAME).execute(
      { title: 'T', steps: [{ narration: 'n', screenshot: true }] },
      CTX,
    );
    expect(result.isError).toBeFalsy();
    const bytes = readFileSync(join(ws, '.sunday', 'artifacts', 'b64', 'media', 'step-1.png'));
    expect(bytes.equals(PNG)).toBe(true);
  });

  it('errors cleanly when the browser is disabled', async () => {
    const registry = registered(stubManager({ enabled: false }), tmpWs());
    const result = await registry.get(BROWSER_WALKTHROUGH_TOOL_NAME).execute(
      { title: 'T', steps: [{ narration: 'n', screenshot: false }] },
      CTX,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('browser is disabled');
  });

  it('errors cleanly on empty steps and bad title', async () => {
    const registry = registered(stubManager(), tmpWs());
    const tool = registry.get(BROWSER_WALKTHROUGH_TOOL_NAME);
    const empty = await tool.execute({ title: 'T', steps: [] }, CTX);
    expect(empty.isError).toBe(true);
    expect(empty.output).toContain('steps must be a non-empty array');
    const noTitle = await tool.execute({ title: '  ', steps: [{ narration: 'n', screenshot: false }] }, CTX);
    expect(noTitle.isError).toBe(true);
    expect(noTitle.output).toContain('title must be a non-empty string');
  });

  it('errors cleanly when a screenshot fails', async () => {
    const ws = tmpWs();
    const registry = registered(stubManager({ failScreenshot: true }), ws, 'fail');
    const result = await registry.get(BROWSER_WALKTHROUGH_TOOL_NAME).execute(
      { title: 'T', steps: [{ narration: 'n', screenshot: true }] },
      CTX,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('screenshot for step 1 failed');
  });
});
