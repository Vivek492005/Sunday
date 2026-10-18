// F11 Browser-verified UI Loop — acceptance tests (seeded UI bugs).
//
// Simulates the agent's closed loop on a broken page:
//   detect (a11y_scan + console) → fix → before/after visual_diff evidence
//   → viewport_matrix captures. All through the JSON-RPC server with a fake
//   driver; the real-browser path is covered by the nightly eval job.

import { PassThrough } from 'node:stream';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '@sunday/protocol';
import { BrowserdServer, type BrowserdConfig } from './server.js';
import { FakeDriver, type FakePage } from './fake-driver.js';
import { drawRect, solidPng } from './visual-diff.js';

interface Frame {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

const harnesses: Array<{ input: PassThrough }> = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.input.end();
});

function buggyPage(): FakePage {
  return {
    url: 'http://localhost:3000/',
    title: 'Checkout',
    nodes: [
      { id: 'e0', role: 'heading', name: 'Checkout' },
      { id: 'e1', role: 'button', name: 'Pay now' },
      { id: 'e2', role: 'img' }, // no alt text — a11y violation
    ],
    consoleEntries: [{ type: 'error', text: 'TypeError: cannot read property of undefined', ts: 1 }],
    networkEntries: [],
    a11yViolations: [
      {
        id: 'color-contrast',
        impact: 'serious',
        description: 'Ensures the contrast between foreground and background colors meets WCAG 2 AA contrast ratio thresholds',
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.8/color-contrast',
        nodes: 3,
      },
      {
        id: 'image-alt',
        impact: 'critical',
        description: 'Ensures <img> elements have alternate text or a role of none or presentation',
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.8/image-alt',
        nodes: 1,
      },
    ],
  };
}

async function makeHarness(pages: FakePage[], config: BrowserdConfig = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Frame[] = [];
  let buf = '';
  output.on('data', (d: Buffer) => {
    buf += d.toString();
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const frame = JSON.parse(line) as Frame;
      if (frame.id !== undefined) frames.push(frame);
    }
  });
  const mediaBaseDir = await mkdtemp(join(tmpdir(), 'f11-media-'));
  const server = new BrowserdServer({
    ...config,
    mediaBaseDir,
    createDriver: () => new FakeDriver(pages, config.allowEval ?? false),
    onStdinClose: () => undefined,
  });
  server.start(input, output);
  harnesses.push({ input });
  let nextId = 1;
  return {
    mediaBaseDir,
    async call(method: string, params: unknown = {}): Promise<Frame> {
      const id = nextId++;
      input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const start = Date.now();
      for (;;) {
        const hit = frames.find((f) => f.id === id);
        if (hit) return hit;
        if (Date.now() - start > 5000) throw new Error(`timeout waiting for ${method}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    },
  };
}

describe('F11 seeded UI bug — closed loop with evidence', () => {
  it('a11y_scan surfaces the seeded violations with impact levels', async () => {
    const h = await makeHarness([buggyPage()]);
    await h.call('browser/open', { url: 'http://localhost:3000/' });
    const f = await h.call('browser/accessibility-scan');
    expect(f.error).toBeUndefined();
    expect(f.result.violations).toHaveLength(2);
    expect(f.result.violations.map((v: any) => v.id)).toEqual(['color-contrast', 'image-alt']);
    expect(f.result.violations[1].impact).toBe('critical');
    expect(f.result.url).toBe('http://localhost:3000/');
  });

  it('console + verify_ui catch the seeded console error', async () => {
    const h = await makeHarness([buggyPage()]);
    await h.call('browser/open', { url: 'http://localhost:3000/' });
    const con = await h.call('browser/console');
    expect(con.result.entries).toHaveLength(1);
    expect(con.result.entries[0].text).toMatch(/TypeError/);
    const v = await h.call('browser/verify_ui', {
      url: 'http://localhost:3000/',
      checks: [{ kind: 'no_console_errors' }],
    });
    expect(v.result.ok).toBe(false);
    expect(v.result.consoleErrors).toBe(1);
  });

  it('visual_diff on before/after fix produces an evidence artifact', async () => {
    const h = await makeHarness([buggyPage()]);
    // "Before": misaligned Pay button at x=20. "After": fixed at x=60.
    const bg = solidPng(200, 100, 255, 255, 255);
    const before = drawRect(bg, 20, 30, 80, 24, 245, 185, 66).toString('base64');
    const after = drawRect(bg, 60, 30, 80, 24, 245, 185, 66).toString('base64');
    const f = await h.call('browser/visual-diff', { beforePng: before, afterPng: after });
    expect(f.error).toBeUndefined();
    expect(f.result.diffPixels).toBe(2 * 40 * 24);
    expect(f.result.diffRatio).toBeCloseTo(1920 / 20000, 6);
    expect(f.result.diffPng.length).toBeGreaterThan(0);
    // Evidence artifact exists on disk (feeds F9 visualProof).
    const st = await stat(f.result.diffPath);
    expect(st.size).toBeGreaterThan(0);
    expect(f.result.diffPath).toContain(h.mediaBaseDir);
  });

  it('visual_diff rejects mismatched dimensions with a clear error', async () => {
    const h = await makeHarness([buggyPage()]);
    const a = solidPng(32, 32, 0, 0, 0).toString('base64');
    const b = solidPng(64, 32, 0, 0, 0).toString('base64');
    const f = await h.call('browser/visual-diff', { beforePng: a, afterPng: b });
    expect(f.error).toBeDefined();
    expect(f.error!.message).toMatch(/dimension mismatch/);
  });

  it('viewport_matrix captures mobile/tablet/desktop with artifact paths', async () => {
    const h = await makeHarness([buggyPage()]);
    const f = await h.call('browser/viewport-matrix', { url: 'http://localhost:3000/' });
    expect(f.error).toBeUndefined();
    expect(f.result.shots).toHaveLength(3);
    expect(f.result.shots.map((s: any) => s.name)).toEqual(['mobile', 'tablet', 'desktop']);
    for (const shot of f.result.shots) {
      expect(shot.bytes).toBeGreaterThan(0);
      const st = await stat(shot.path);
      expect(st.size).toBeGreaterThan(0);
    }
    const desktop = f.result.shots[2];
    expect(desktop.width).toBe(1440);
    expect(desktop.height).toBe(900);
  });

  it('viewport_matrix blocks file:// and asks approval for new origins', async () => {
    const h = await makeHarness([buggyPage()]);
    const blocked = await h.call('browser/viewport-matrix', { url: 'file:///etc/passwd' });
    expect(blocked.error?.code).toBe(ErrorCode.PolicyDenied);
    const approval = await h.call('browser/viewport-matrix', { url: 'https://new-origin.example/' });
    expect(approval.result).toMatchObject({ needsApproval: true, origin: 'https://new-origin.example', shots: [] });
  });

  it('new RPCs stay usable while the user has taken over (observation-only)', async () => {
    const h = await makeHarness([buggyPage()]);
    await h.call('browser/open', { url: 'http://localhost:3000/' });
    await h.call('browser/takeover');
    const scan = await h.call('browser/accessibility-scan');
    expect(scan.error).toBeUndefined();
    expect(scan.result.violations).toHaveLength(2);
    const a = solidPng(8, 8, 1, 2, 3).toString('base64');
    const diff = await h.call('browser/visual-diff', { beforePng: a, afterPng: a });
    expect(diff.error).toBeUndefined();
    expect(diff.result.diffPixels).toBe(0);
  });
});
