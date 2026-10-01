// @sunday/browserd — navigation security tests (§18.2).
//
// Extends policy.test.ts with threat-model coverage for the agent browser:
// URL scheme gating, private-network blocking (IPv4 + IPv6), the
// approve-once-per-origin flow, page-eval gating, profile-dir isolation, and
// downloads disabled. Everything here is hermetic — no real Chromium is
// launched.

import { PassThrough } from 'node:stream';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BROWSER_METHODS, ErrorCode } from '@sunday/protocol';
import { BrowserdServer } from './server.js';
import { FakeDriver, type FakePage } from './fake-driver.js';
import { profileDirFor } from './playwright-driver.js';
import { BrowserPolicy, BrowserPolicyError } from './policy.js';

describe('browser security: file:// URLs are blocked', () => {
  it.each([
    'file:///etc/passwd',
    'file:///C:/Windows/System32/drivers/etc/hosts',
    'file://localhost/etc/passwd',
    'FILE:///etc/passwd',
  ])('blocks %s', (url) => {
    const policy = new BrowserPolicy();
    expect(() => policy.checkNavigation(url, new Set())).toThrow(BrowserPolicyError);
  });

  it('also refuses non-http(s) schemes', () => {
    const policy = new BrowserPolicy();
    for (const url of ['ftp://example.com/x', 'javascript:alert(1)', 'data:text/html,<h1>x</h1>']) {
      expect(() => policy.checkNavigation(url, new Set())).toThrow(BrowserPolicyError);
    }
  });
});

describe('browser security: private network addresses are blocked', () => {
  it.each([
    'http://192.168.1.5/',
    'http://10.0.0.2/',
    'http://172.16.5.4:8080/',
    'http://169.254.169.254/', // link-local
    'http://[fd00::1]/', // IPv6 unique-local
    'http://[fe80::1]/', // IPv6 link-local
  ])('blocks %s', (url) => {
    const policy = new BrowserPolicy();
    expect(() => policy.checkNavigation(url, new Set())).toThrow(BrowserPolicyError);
  });

  it('allows a private address the user explicitly approved', () => {
    const policy = new BrowserPolicy({ approvedDomains: ['192.168.1.5'] });
    expect(policy.checkNavigation('http://192.168.1.5/', new Set())).toEqual({ kind: 'allow' });
  });

  it('still allows loopback targets', () => {
    const policy = new BrowserPolicy();
    const approved = new Set<string>();
    expect(policy.checkNavigation('http://localhost:34567/', approved)).toEqual({ kind: 'allow' });
    expect(policy.checkNavigation('http://127.0.0.1/', approved)).toEqual({ kind: 'allow' });
  });
});

describe('browser security: approve-once-per-origin', () => {
  it('first navigation needs approval (no navigation); approving allows the rest of the session', () => {
    const policy = new BrowserPolicy();
    const approved = new Set<string>();

    const first = policy.checkNavigation('https://example.com/page', approved);
    expect(first).toEqual({ kind: 'needsApproval', origin: 'https://example.com' });
    // needsApproval must NOT record the approval by itself — the client
    // retries with approve: true after the user consents.
    expect(approved.has('https://example.com')).toBe(false);

    approved.add('https://example.com'); // user-approved retry
    expect(policy.checkNavigation('https://example.com/other', approved)).toEqual({ kind: 'allow' });
    expect(policy.checkNavigation('https://example.com:443/deep', approved)).toEqual({ kind: 'allow' });

    // A different origin still needs its own approval.
    expect(policy.checkNavigation('https://other.example/', approved).kind).toBe('needsApproval');
  });
});

describe('browser security: browser/eval gating', () => {
  interface Frame {
    id?: number;
    result?: unknown;
    error?: { code: number; message: string };
  }

  /** Minimal stdio harness: open localhost, then call browser/eval. */
  async function evalOnce(allowEval: boolean): Promise<Frame> {
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
        if (line) frames.push(JSON.parse(line) as Frame);
      }
    });
    const page: FakePage = {
      url: 'http://localhost:3000/',
      title: 'Dashboard',
      nodes: [],
      consoleEntries: [],
      networkEntries: [],
    };
    const server = new BrowserdServer({
      allowEval,
      createDriver: () => new FakeDriver([page], allowEval),
      onStdinClose: () => undefined,
    });
    server.start(input, output);
    try {
      let nextId = 1;
      const call = async (method: string, params: unknown): Promise<Frame> => {
        const id = nextId++;
        input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        const start = Date.now();
        for (;;) {
          const hit = frames.find((f) => f.id === id);
          if (hit) return hit;
          if (Date.now() - start > 5000) throw new Error(`timeout waiting for ${method}`);
          await new Promise((r) => setTimeout(r, 5));
        }
      };
      await call('browser/open', { url: 'http://localhost:3000/' });
      return call('browser/eval', { fn: '() => document.title' });
    } finally {
      input.end();
    }
  }

  it('refuses browser/eval when the server is constructed with eval disabled (default)', async () => {
    const f = await evalOnce(false);
    expect(f.error?.code).toBe(ErrorCode.PolicyDenied);
    expect(f.error?.message).toMatch(/disabled/);
  });

  it('allows browser/eval only when explicitly enabled', async () => {
    const f = await evalOnce(true);
    expect(f.error).toBeUndefined();
    expect(f.result).toEqual({ result: 'Dashboard' });
  });
});

describe('browser security: profile directory isolation', () => {
  const sundayRoot = join(homedir(), '.sunday', 'browser') + sep;

  it('resolves under ~/.sunday/browser/<sha16(workspaceRoot)>', () => {
    const p = profileDirFor('/some/workspace');
    expect(p.startsWith(sundayRoot)).toBe(true);
    expect(p.slice(sundayRoot.length)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic per workspace and distinct across workspaces', () => {
    expect(profileDirFor('/ws/a')).toBe(profileDirFor('/ws/a'));
    expect(profileDirFor('/ws/a')).not.toBe(profileDirFor('/ws/b'));
  });

  it('never equals the user\'s real browser profile', () => {
    const p = profileDirFor('/some/workspace');
    const realProfiles = [
      join(homedir(), '.config', 'google-chrome'), // Linux Chrome
      join(homedir(), '.config', 'chromium'), // Linux Chromium
      join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome'), // macOS Chrome
    ];
    for (const real of realProfiles) {
      expect(p).not.toBe(real);
      expect(p.startsWith(real + sep)).toBe(false);
    }
    expect(p).not.toBe(homedir());
  });
});

describe('browser security: downloads disabled', () => {
  it('the playwright context options are created with acceptDownloads: false (code-level)', () => {
    const src = readFileSync(new URL('./playwright-driver.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/acceptDownloads:\s*false/);
  });

  it('the browser RPC surface and the driver interface expose no download capability', () => {
    const methods = Object.keys(BROWSER_METHODS);
    expect(methods.some((m) => m.toLowerCase().includes('download'))).toBe(false);
    const driverMethods = Object.getOwnPropertyNames(FakeDriver.prototype).filter((n) => n !== 'constructor');
    expect(driverMethods.some((m) => m.toLowerCase().includes('download'))).toBe(false);
  });
});
