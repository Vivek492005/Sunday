// BrowserdManager — Browser Agent UI phase session controls (Worker 1).
//
// Covers the enabled master switch and the browserd session passthroughs
// (takeover/release/controlState/screencast/frame/recording) against the
// hermetic mini-browserd fixture.

import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { BrowserdClosedError, BrowserdManager } from './browserd.js';

const FIXTURE = fileURLToPath(new URL('./test/fixtures/mini-browserd.mjs', import.meta.url));

const managers: BrowserdManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.stop().catch(() => undefined);
});

function makeManager(extra: Record<string, unknown> = {}): BrowserdManager {
  const m = new BrowserdManager({
    browserdPath: FIXTURE,
    log: () => undefined,
    ...extra,
  });
  managers.push(m);
  return m;
}

describe('BrowserdManager browser gating', () => {
  it('is disabled by default and reads SUNDAY_BROWSER_ENABLED=1', () => {
    const saved = process.env.SUNDAY_BROWSER_ENABLED;
    try {
      delete process.env.SUNDAY_BROWSER_ENABLED;
      expect(new BrowserdManager().isBrowserEnabled()).toBe(false);
      process.env.SUNDAY_BROWSER_ENABLED = '1';
      expect(new BrowserdManager().isBrowserEnabled()).toBe(true);
      process.env.SUNDAY_BROWSER_ENABLED = '0';
      expect(new BrowserdManager().isBrowserEnabled()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.SUNDAY_BROWSER_ENABLED;
      else process.env.SUNDAY_BROWSER_ENABLED = saved;
    }
  });

  it('setBrowserEnabled flips the switch at runtime', () => {
    const m = new BrowserdManager({ browserEnabled: false });
    expect(m.isBrowserEnabled()).toBe(false);
    m.setBrowserEnabled(true);
    expect(m.isBrowserEnabled()).toBe(true);
    m.setBrowserEnabled(false);
    expect(m.isBrowserEnabled()).toBe(false);
  });

  it('explicit browserEnabled option beats the env var', () => {
    const saved = process.env.SUNDAY_BROWSER_ENABLED;
    try {
      process.env.SUNDAY_BROWSER_ENABLED = '1';
      expect(new BrowserdManager({ browserEnabled: false }).isBrowserEnabled()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.SUNDAY_BROWSER_ENABLED;
      else process.env.SUNDAY_BROWSER_ENABLED = saved;
    }
  });
});

describe('BrowserdManager session controls', () => {
  it('passthroughs throw a clear error when browserd is not running', async () => {
    const m = makeManager();
    const calls = [
      () => m.takeover(),
      () => m.releaseControl(),
      () => m.controlState(),
      () => m.startScreencast(),
      () => m.stopScreencast(),
      () => m.latestFrame(),
      () => m.startRecording({ video: true }),
      () => m.stopRecording(),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toThrow(BrowserdClosedError);
      await expect(call()).rejects.toThrow(/browserd is not running/);
    }
  });

  it('takeover / controlState / releaseControl round-trip', async () => {
    const m = makeManager();
    await m.start();
    expect(await m.takeover()).toBe('user');
    expect(await m.controlState()).toBe('user');
    expect(await m.releaseControl()).toBe('agent');
  });

  it('screencast start/stop and latestFrame passthrough', async () => {
    const m = makeManager();
    await m.start();
    await m.startScreencast();
    expect(await m.latestFrame()).toBe('ZmFrZS1mcmFtZQ==');
    await m.stopScreencast();
  });

  it('recording start/stop returns artifact paths', async () => {
    const m = makeManager();
    await m.start();
    await m.startRecording({ video: true, trace: true });
    const r = await m.stopRecording();
    expect(r.ok).toBe(true);
    expect(r.videoPath).toBe('/tmp/media/video.webm');
    expect(r.tracePath).toBe('/tmp/media/trace.zip');
  });
});
