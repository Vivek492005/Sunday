import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeDriver, type FakePage } from './fake-driver.js';
import { DriverError } from './driver.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8]);

function loginPage(): FakePage {
  return {
    url: 'http://localhost:3000/login',
    title: 'Login',
    nodes: [
      { id: 'e0', role: 'heading', name: 'Sign in' },
      { id: 'e1', role: 'textbox', name: 'Email', value: '' },
      { id: 'e2', role: 'textbox', name: 'Password', value: '' },
      { id: 'e3', role: 'button', name: 'Log in' },
    ],
    consoleEntries: [],
    networkEntries: [],
  };
}

describe('FakeDriver', () => {
  it('runs the full open → snapshot → click → type → screenshot flow', async () => {
    const d = new FakeDriver([loginPage()]);
    const opened = await d.open('http://localhost:3000/login');
    expect(opened.title).toBe('Login');

    const snap = await d.snapshot();
    expect(snap.url).toBe('http://localhost:3000/login');
    expect(snap.nodes.map((n) => n.ref)).toEqual(['e0', 'e1', 'e2', 'e3']);
    expect(snap.nodes[3]).toMatchObject({ role: 'button', name: 'Log in', visible: true });

    await d.type('e1', 'user@example.com');
    await d.type('e2', 's3cret', { submit: false });
    await d.click('e3');

    const page = d.pageFor('http://localhost:3000/login')!;
    expect(page.nodes[1].typed).toBe('user@example.com');
    expect(page.nodes[1].value).toBe('user@example.com');
    expect(page.nodes[3].clicked).toBe(true);

    const png = await d.screenshot();
    expect(png.subarray(0, 8)).toEqual(PNG_MAGIC);

    await d.close();
    expect(d.isClosed).toBe(true);
  });

  it('creates a blank page for unknown URLs and records network', async () => {
    const d = new FakeDriver();
    await d.open('http://localhost:4000/');
    const net = await d.networkEntries();
    expect(net).toHaveLength(1);
    expect(net[0]).toMatchObject({ url: 'http://localhost:4000/', method: 'GET', status: 200 });
  });

  it('rejects unknown refs', async () => {
    const d = new FakeDriver([loginPage()]);
    await d.open('http://localhost:3000/login');
    await expect(d.click('e99')).rejects.toThrow(DriverError);
    await expect(d.type('nope', 'x')).rejects.toThrow(/unknown element ref/);
  });

  it('records press and scroll', async () => {
    const d = new FakeDriver([loginPage()]);
    await d.open('http://localhost:3000/login');
    await d.press('Enter');
    expect(d.pressedKey).toBe('Enter');
    await d.scroll({ ref: 'e3', dy: 200 });
    expect(d.scrolled).toEqual({ ref: 'e3', dx: undefined, dy: 200 });
    await expect(d.scroll({ ref: 'e99' })).rejects.toThrow(DriverError);
  });

  it('wait validates selectors without sleeping', async () => {
    const d = new FakeDriver([loginPage()]);
    await d.open('http://localhost:3000/login');
    await d.wait({ ms: 50 }); // no-op, fast
    await d.wait({ selector: '#e1' });
    await expect(d.wait({ selector: '#missing' })).rejects.toThrow(/not found/);
  });

  it('eval is restricted: disabled by default, tiny whitelist when enabled', async () => {
    const d = new FakeDriver([loginPage()]);
    await d.open('http://localhost:3000/login');
    await expect(d.eval('() => document.title')).rejects.toThrow(/disabled by browser policy/);

    const allowed = new FakeDriver([loginPage()], true);
    await allowed.open('http://localhost:3000/login');
    expect(await allowed.eval('() => document.title')).toBe('Login');
    expect(await allowed.eval('() => location.href')).toBe('http://localhost:3000/login');
    expect(await allowed.eval(`() => 'hello'`)).toBe('hello');
    await expect(allowed.eval('() => localStorage.clear()')).rejects.toThrow(/supports only/);
  });

  it('round-trips console entries', async () => {
    const d = new FakeDriver([loginPage()]);
    await d.open('http://localhost:3000/login');
    d.pushConsole({ type: 'error', text: 'boom', location: 'app.js:1' });
    const entries = await d.consoleEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'error', text: 'boom' });
    expect(typeof entries[0].ts).toBe('number');
  });

  it('tracks a history stack for goBack/goForward/reload', async () => {
    const d = new FakeDriver([loginPage()]);
    await d.open('http://localhost:3000/login');
    await d.open('http://localhost:3000/other');
    expect((await d.snapshot()).url).toBe('http://localhost:3000/other');

    await d.goBack();
    expect((await d.snapshot()).url).toBe('http://localhost:3000/login');

    // At the start of history: no-op, not an error.
    await d.goBack();
    expect((await d.snapshot()).url).toBe('http://localhost:3000/login');

    await d.goForward();
    expect((await d.snapshot()).url).toBe('http://localhost:3000/other');

    // Past the end: no-op.
    await d.goForward();
    expect((await d.snapshot()).url).toBe('http://localhost:3000/other');

    await d.reload();
    expect((await d.snapshot()).url).toBe('http://localhost:3000/other');
    await d.close();
  });

  it('emits synthetic JPEG frames on a screencast interval until stopped', async () => {
    const d = new FakeDriver([loginPage()]);
    await d.open('http://localhost:3000/login');
    const frames: Buffer[] = [];
    await d.startScreencast((jpeg) => frames.push(jpeg));
    expect(d.screencastActive).toBe(true);
    const start = Date.now();
    for (;;) {
      if (frames.length >= 2) break;
      if (Date.now() - start > 5000) throw new Error('timed out waiting for fake screencast frames');
      await new Promise((r) => setTimeout(r, 50));
    }
    for (const f of frames) expect(f.subarray(0, 2)).toEqual(JPEG_MAGIC);
    await d.stopScreencast();
    expect(d.screencastActive).toBe(false);
    const count = frames.length;
    await new Promise((r) => setTimeout(r, 1200));
    expect(frames.length).toBe(count);
    await d.close();
  });

  it('writes recording placeholders into the given dir', async () => {
    const d = new FakeDriver([loginPage()]);
    await d.open('http://localhost:3000/login');
    const dir = await mkdtemp(join(tmpdir(), 'fake-rec-'));
    await d.startRecording({ video: true, trace: true, dir });
    expect((await stat(join(dir, 'video.webm'))).isFile()).toBe(true);
    expect((await readFile(join(dir, 'video.webm'))).length).toBeGreaterThan(0);
    expect((await stat(join(dir, 'trace.zip'))).isFile()).toBe(true);
    const stopped = await d.stopRecording();
    expect(stopped.videoPath).toBe(join(dir, 'video.webm'));
    expect(stopped.tracePath).toBe(join(dir, 'trace.zip'));
    // Stopping again with nothing recording returns empty paths.
    expect(await d.stopRecording()).toEqual({});
    await d.close();
  });
});
