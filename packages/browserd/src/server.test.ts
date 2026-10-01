import { PassThrough } from 'node:stream';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '@sunday/protocol';
import { BrowserdServer, type BrowserdConfig } from './server.js';
import { FakeDriver, type FakePage } from './fake-driver.js';

interface Frame {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

interface Harness {
  call(method: string, params?: unknown): Promise<Frame>;
  /** Inbound notifications (no id), e.g. browser/screencastFrame. */
  notifications: Frame[];
}

const harnesses: Array<{ input: PassThrough }> = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.input.end();
});

function dashboardPage(): FakePage {
  return {
    url: 'http://localhost:3000/',
    title: 'Dashboard',
    nodes: [
      { id: 'e0', role: 'heading', name: 'Welcome back' },
      { id: 'e1', role: 'textbox', name: 'Search' },
      { id: 'e2', role: 'button', name: 'Refresh' },
    ],
    consoleEntries: [],
    networkEntries: [],
  };
}

async function makeHarness(pages: FakePage[] = [dashboardPage()], config: BrowserdConfig = {}): Promise<Harness> {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Frame[] = [];
  const notifications: Frame[] = [];
  let buf = '';
  output.on('data', (d: Buffer) => {
    buf += d.toString();
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const frame = JSON.parse(line) as Frame;
      // Notifications (e.g. browser/screencastFrame) carry no id.
      if (frame.id === undefined) notifications.push(frame);
      else frames.push(frame);
    }
  });
  const server = new BrowserdServer({
    ...config,
    createDriver: () => new FakeDriver(pages, config.allowEval ?? false),
    onStdinClose: () => undefined,
  });
  server.start(input, output);
  harnesses.push({ input });
  let nextId = 1;
  return {
    notifications,
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

describe('BrowserdServer', () => {
  it('answers browser/ping without launching a browser', async () => {
    const h = await makeHarness();
    const f = await h.call('browser/ping');
    expect(f.result).toMatchObject({ ok: true, driver: 'fake' });
    expect(typeof f.result.version).toBe('string');
  });

  it('runs the full open → snapshot → click → type → screenshot flow', async () => {
    const h = await makeHarness();
    const opened = await h.call('browser/open', { url: 'http://localhost:3000/' });
    expect(opened.result).toMatchObject({ ok: true, title: 'Dashboard' });

    const snap = await h.call('browser/snapshot');
    expect(snap.result.nodes.map((n: any) => n.ref)).toEqual(['e0', 'e1', 'e2']);

    expect((await h.call('browser/click', { ref: 'e2' })).result).toEqual({ ok: true });
    expect((await h.call('browser/type', { ref: 'e1', text: 'hello' })).result).toEqual({ ok: true });
    expect((await h.call('browser/press', { key: 'Enter' })).result).toEqual({ ok: true });
    expect((await h.call('browser/scroll', { dy: 300 })).result).toEqual({ ok: true });
    expect((await h.call('browser/wait', { ms: 10 })).result).toEqual({ ok: true });

    const shot = await h.call('browser/screenshot');
    expect(shot.result.bytes).toBeGreaterThan(0);
    expect(Buffer.from(shot.result.png, 'base64').subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );

    const con = await h.call('browser/console');
    expect(con.result.entries).toEqual([]);
    const net = await h.call('browser/network');
    expect(net.result.requests).toHaveLength(1);

    expect((await h.call('browser/close')).result).toEqual({ ok: true });
  });

  it('rejects unknown methods and bad params', async () => {
    const h = await makeHarness();
    const unknown = await h.call('browser/nope');
    expect(unknown.error?.code).toBe(ErrorCode.MethodNotFound);
    const badParams = await h.call('browser/click', {});
    expect(badParams.error?.code).toBe(ErrorCode.InvalidParams);
  });

  it('blocks file:// with PolicyDenied', async () => {
    const h = await makeHarness();
    const f = await h.call('browser/open', { url: 'file:///etc/passwd' });
    expect(f.error?.code).toBe(ErrorCode.PolicyDenied);
    expect(f.error?.message).toMatch(/file:\/\//);
  });

  it('blocks private IPs with PolicyDenied', async () => {
    const h = await makeHarness();
    for (const url of ['http://192.168.1.5:3000/', 'http://10.0.0.8/']) {
      const f = await h.call('browser/open', { url });
      expect(f.error?.code).toBe(ErrorCode.PolicyDenied);
      expect(f.error?.message).toMatch(/private network/);
    }
  });

  it('returns needsApproval for a new origin and does not navigate', async () => {
    const h = await makeHarness();
    const first = await h.call('browser/open', { url: 'https://example.com/' });
    expect(first.result).toMatchObject({ ok: false, needsApproval: true, origin: 'https://example.com' });

    // Not navigated: snapshot still fails with "no page open".
    const snap = await h.call('browser/snapshot');
    expect(snap.result.url).toBeNull();

    // Retry with approval → navigates and remembers the origin.
    const second = await h.call('browser/open', { url: 'https://example.com/', approve: true });
    expect(second.result).toMatchObject({ ok: true, url: 'https://example.com/' });
    const third = await h.call('browser/open', { url: 'https://example.com/other' });
    expect(third.result).toMatchObject({ ok: true });
  });

  it('browser/verify_ui passes all checks on a healthy page', async () => {
    const h = await makeHarness();
    const f = await h.call('browser/verify_ui', {
      url: 'http://localhost:3000/',
      checks: [
        { kind: 'text_present', text: 'Welcome back' },
        { kind: 'no_console_errors' },
        { kind: 'element_visible', ref: 'e2' },
        { kind: 'title_contains', text: 'Dashboard' },
      ],
    });
    expect(f.result.ok).toBe(true);
    expect(f.result.checks).toHaveLength(4);
    expect(f.result.checks.every((c: any) => c.passed)).toBe(true);
    expect(f.result.consoleErrors).toBe(0);
    expect(typeof f.result.screenshotPng).toBe('string');
  });

  it('browser/verify_ui fails the no_console_errors check with details', async () => {
    const pages = [dashboardPage()];
    pages[0].consoleEntries = [{ type: 'error', text: 'TypeError: x is undefined', ts: 1 }];
    const h = await makeHarness(pages);
    const f = await h.call('browser/verify_ui', {
      url: 'http://localhost:3000/',
      checks: [{ kind: 'no_console_errors' }, { kind: 'text_present', text: 'missing text' }],
    });
    expect(f.result.ok).toBe(false);
    expect(f.result.consoleErrors).toBe(1);
    const [consoleCheck, textCheck] = f.result.checks;
    expect(consoleCheck.passed).toBe(false);
    expect(consoleCheck.detail).toMatch(/TypeError/);
    expect(textCheck.passed).toBe(false);
  });

  it('browser/verify_ui fails fast on blocked navigations', async () => {
    const h = await makeHarness();
    const f = await h.call('browser/verify_ui', {
      url: 'file:///etc/passwd',
      checks: [{ kind: 'no_console_errors' }],
      readyTimeoutMs: 1000,
    });
    expect(f.error?.code).toBe(ErrorCode.PolicyDenied);
  });

  it('browser/verify_ui returns needsApproval for new origins instead of navigating', async () => {
    const h = await makeHarness();
    const f = await h.call('browser/verify_ui', {
      url: 'https://new-origin.example/',
      checks: [{ kind: 'no_console_errors' }],
    });
    expect(f.result).toMatchObject({ ok: false, needsApproval: true, origin: 'https://new-origin.example' });
  });

  it('browser/eval is denied unless explicitly enabled', async () => {
    const h = await makeHarness();
    await h.call('browser/open', { url: 'http://localhost:3000/' });
    const denied = await h.call('browser/eval', { fn: '() => document.title' });
    expect(denied.error?.code).toBe(ErrorCode.PolicyDenied);

    const h2 = await makeHarness([dashboardPage()], { allowEval: true });
    await h2.call('browser/open', { url: 'http://localhost:3000/' });
    const allowed = await h2.call('browser/eval', { fn: '() => document.title' });
    expect(allowed.result).toEqual({ result: 'Dashboard' });
  });

  it('actions before open fail with a clear error', async () => {
    const h = await makeHarness();
    const f = await h.call('browser/click', { ref: 'e1' });
    expect(f.error?.code).toBe(ErrorCode.InternalError);
    expect(f.error?.message).toMatch(/no page open/);
  });

  it('screencast pushes JPEG frames as notifications and caches the latest', async () => {
    const h = await makeHarness();
    await h.call('browser/open', { url: 'http://localhost:3000/' });
    // No frame before the screencast starts.
    expect((await h.call('browser/frame/latest')).result).toEqual({ data: null });

    expect((await h.call('browser/screencast/start')).result).toEqual({ ok: true });
    const start = Date.now();
    for (;;) {
      if (h.notifications.length >= 2) break;
      if (Date.now() - start > 5000) throw new Error('timed out waiting for screencast frames');
      await new Promise((r) => setTimeout(r, 50));
    }
    const frames = h.notifications.filter((n) => n.method === 'browser/screencastFrame');
    expect(frames.length).toBeGreaterThanOrEqual(2);
    for (const f of frames) {
      expect(typeof f.params.data).toBe('string');
      expect(typeof f.params.ts).toBe('number');
      // JPEG magic bytes FF D8 → base64 "/9j/".
      expect(f.params.data.startsWith('/9j/')).toBe(true);
    }

    // The cache holds the most recent frame.
    const latest = await h.call('browser/frame/latest');
    expect(latest.result.data).toBe(frames[frames.length - 1].params.data);

    // Stopping halts the flow.
    expect((await h.call('browser/screencast/stop')).result).toEqual({ ok: true });
    const count = h.notifications.length;
    await new Promise((r) => setTimeout(r, 1200));
    expect(h.notifications.length).toBe(count);
  });

  it('takeover blocks action RPCs but allows observation', async () => {
    const h = await makeHarness();
    await h.call('browser/open', { url: 'http://localhost:3000/' });

    expect((await h.call('browser/takeover')).result).toEqual({ ok: true, control: 'user' });
    expect((await h.call('browser/control')).result).toEqual({ control: 'user' });

    for (const [method, params] of [
      ['browser/open', { url: 'http://localhost:3000/other' }],
      ['browser/click', { ref: 'e2' }],
      ['browser/type', { ref: 'e1', text: 'x' }],
      ['browser/press', { key: 'Enter' }],
      ['browser/scroll', { dy: 100 }],
      ['browser/wait', { ms: 5 }],
    ] as Array<[string, unknown]>) {
      const f = await h.call(method, params);
      expect(f.error?.code).toBe(ErrorCode.BrowserTakeover);
      expect(f.error?.message).toMatch(/taken over/);
    }

    // Observation RPCs keep working during takeover.
    expect((await h.call('browser/snapshot')).result.nodes).toHaveLength(3);
    expect((await h.call('browser/screenshot')).result.bytes).toBeGreaterThan(0);
    expect((await h.call('browser/console')).result.entries).toEqual([]);
    expect((await h.call('browser/network')).result.requests).toHaveLength(1);

    expect((await h.call('browser/release')).result).toEqual({ ok: true, control: 'agent' });
    expect((await h.call('browser/control')).result).toEqual({ control: 'agent' });
    expect((await h.call('browser/click', { ref: 'e2' })).result).toEqual({ ok: true });
  });

  it('recording writes artifacts into the session media dir', async () => {
    const mediaBase = await mkdtemp(join(tmpdir(), 'browserd-media-'));
    const h = await makeHarness([dashboardPage()], { mediaBaseDir: mediaBase, sessionId: 'sess-1' });
    await h.call('browser/open', { url: 'http://localhost:3000/' });

    expect((await h.call('browser/recording/start', { video: true, trace: true })).result).toEqual({
      ok: true,
    });
    const mediaDir = join(mediaBase, 'sess-1', 'media');
    expect((await stat(join(mediaDir, 'video.webm'))).isFile()).toBe(true);
    expect((await stat(join(mediaDir, 'trace.zip'))).isFile()).toBe(true);

    const stopped = await h.call('browser/recording/stop');
    expect(stopped.result.ok).toBe(true);
    expect(stopped.result.videoPath).toBe(join(mediaDir, 'video.webm'));
    expect(stopped.result.tracePath).toBe(join(mediaDir, 'trace.zip'));
  });
});
