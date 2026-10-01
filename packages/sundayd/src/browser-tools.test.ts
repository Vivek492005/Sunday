import { describe, expect, it } from 'vitest';
import { ToolRegistry, createDefaultRegistry } from '@sunday/tools';
import { BROWSER_TOOL_NAMES, createBrowserTools, registerBrowserTools } from './browser-tools.js';
import { BrowserdManager, BrowserdRpcError } from './browserd.js';

/** Stub for BrowserdManager — records calls, plays canned results. */
class StubManager {
  calls: Array<{ method: string; params: unknown; timeoutMs: number }> = [];
  handler: (method: string, params: unknown) => unknown = () => ({ ok: true });
  failWith: Error | undefined;
  /** Browser Agent UI phase: master switch + takeover state. */
  browserEnabled = true;
  control: 'agent' | 'user' = 'agent';
  isBrowserEnabled(): boolean {
    return this.browserEnabled;
  }
  async controlState(): Promise<'agent' | 'user'> {
    return this.control;
  }
  async rpc(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<unknown> {
    this.calls.push({ method, params, timeoutMs });
    if (this.failWith) throw this.failWith;
    return this.handler(method, params);
  }
}

function registered(stub?: StubManager): { registry: ToolRegistry; stub: StubManager } {
  const s = stub ?? new StubManager();
  const registry = new ToolRegistry();
  registerBrowserTools(registry, s as unknown as BrowserdManager);
  return { registry, stub: s };
}

const CTX = { cwd: '/tmp/ws' };

describe('browser tools', () => {
  it('registers exactly the 13 browser_* tools, all dangerous', () => {
    const { registry, stub } = registered();
    expect(registry.names().sort()).toEqual([...BROWSER_TOOL_NAMES].sort());
    for (const t of createBrowserTools(new StubManager() as unknown as BrowserdManager)) {
      expect(t.definition.dangerous).toBe(true);
      expect(t.definition.name).toMatch(/^browser_[a-z_]+$/);
    }
  });

  it('is off by default: not in the default registry', () => {
    const names = createDefaultRegistry().names();
    for (const n of BROWSER_TOOL_NAMES) expect(names).not.toContain(n);
  });

  it('browser_open delegates and formats success', async () => {
    const { registry, stub } = registered();
    stub.handler = () => ({ ok: true, url: 'http://localhost:3000/', title: 'App' });
    const r = await registry.call('browser_open', { url: 'http://localhost:3000/' }, CTX);
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain('http://localhost:3000/');
    expect(stub.calls[0]).toMatchObject({ method: 'browser/open', params: { url: 'http://localhost:3000/' } });
  });

  it('browser_open surfaces needsApproval without navigating', async () => {
    const { registry, stub } = registered();
    stub.handler = () => ({ ok: false, needsApproval: true, origin: 'https://example.com' });
    const r = await registry.call('browser_open', { url: 'https://example.com/' }, CTX);
    expect(r.isError).toBeFalsy();
    expect(r.output).toMatch(/needs approval.*https:\/\/example\.com/);
    expect(r.metadata).toMatchObject({ needsApproval: true, origin: 'https://example.com' });
  });

  it('browser_snapshot formats the a11y tree', async () => {
    const { registry, stub } = registered();
    stub.handler = () => ({
      url: 'http://localhost:3000/',
      title: 'App',
      nodes: [
        { ref: 'e0', role: 'heading', name: 'Hi', visible: true },
        { ref: 'e1', role: 'button', name: 'Go', visible: true },
      ],
    });
    const r = await registry.call('browser_snapshot', {}, CTX);
    expect(r.output).toContain('e0 [heading] "Hi"');
    expect(r.output).toContain('e1 [button] "Go"');
  });

  it('browser_screenshot keeps PNG out of text, in metadata', async () => {
    const { registry, stub } = registered();
    stub.handler = () => ({ png: 'aGVsbG8=', bytes: 5 });
    const r = await registry.call('browser_screenshot', {}, CTX);
    expect(r.output).toBe('screenshot captured (5 bytes PNG)');
    expect(r.metadata).toMatchObject({ png: 'aGVsbG8=', bytes: 5 });
  });

  it('browser_verify_ui formats the macro report', async () => {
    const { registry, stub } = registered();
    stub.handler = () => ({
      ok: true,
      url: 'http://localhost:3000/',
      checks: [
        { kind: 'text_present', passed: true },
        { kind: 'no_console_errors', passed: true },
      ],
      consoleErrors: 0,
      screenshotPng: 'abc',
    });
    const r = await registry.call(
      'browser_verify_ui',
      { url: 'http://localhost:3000/', checks: [{ kind: 'no_console_errors' }] },
      CTX,
    );
    expect(r.output).toContain('PASS (2/2 checks, 0 console errors)');
    expect(r.metadata).toMatchObject({ ok: true, consoleErrors: 0 });
    // verify_ui gets a generous RPC timeout (ready wait + macro time).
    expect(stub.calls[0].timeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  it('browser_console / browser_network format entries', async () => {
    const { registry, stub } = registered();
    stub.handler = (method) =>
      method === 'browser/console'
        ? { entries: [{ type: 'error', text: 'boom', location: 'a.js:1' }] }
        : { requests: [{ method: 'GET', status: 200, url: 'http://localhost:3000/' }] };
    const c = await registry.call('browser_console', {}, CTX);
    expect(c.output).toContain('[error] boom (a.js:1)');
    const n = await registry.call('browser_network', {}, CTX);
    expect(n.output).toContain('GET 200 http://localhost:3000/');
  });

  it('action tools delegate with the right method names', async () => {
    const { registry, stub } = registered();
    await registry.call('browser_click', { ref: 'e2' }, CTX);
    await registry.call('browser_type', { ref: 'e1', text: 'hi' }, CTX);
    await registry.call('browser_press', { key: 'Enter' }, CTX);
    await registry.call('browser_close', {}, CTX);
    expect(stub.calls.map((c) => c.method)).toEqual([
      'browser/click',
      'browser/type',
      'browser/press',
      'browser/close',
    ]);
  });

  it('validates arguments against the JSON Schema', async () => {
    const { registry, stub } = registered();
    const r = await registry.call('browser_click', {}, CTX);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/invalid arguments/);
  });

  it('maps child failures to tool errors (not throws)', async () => {
    const { registry, stub } = registered();
    stub.failWith = new BrowserdRpcError(-32000, 'blocked: private network address');
    const r = await registry.call('browser_open', { url: 'http://10.0.0.1/' }, CTX);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/browser tool browser_open failed: blocked: private network/);
  });

  it('double registration throws', () => {
    const { registry, stub } = registered();
    expect(() => registerBrowserTools(registry, stub as unknown as BrowserdManager)).toThrow(
      /already registered/,
    );
  });

  it('refuses every tool when the browser is disabled', async () => {
    const { registry, stub } = registered();
    stub.browserEnabled = false;
    const cases: Array<[string, Record<string, unknown>]> = [
      ['browser_open', { url: 'http://localhost:3000/' }],
      ['browser_snapshot', {}],
      ['browser_click', { ref: 'e1' }],
      ['browser_verify_ui', { url: 'http://localhost:3000/', checks: [{ kind: 'no_console_errors' }] }],
    ];
    for (const [name, args] of cases) {
      const r = await registry.call(name, args, CTX);
      expect(r.isError).toBe(true);
      expect(r.output).toBe('browser is disabled — set sunday.browser.enabled to true to opt in');
    }
    // Nothing reached the child.
    expect(stub.calls).toHaveLength(0);
  });

  it('blocks action tools during user takeover but allows observation', async () => {
    const { registry, stub } = registered();
    stub.control = 'user';
    stub.handler = () => ({ url: 'http://localhost:3000/', title: 'App', nodes: [] });
    const click = await registry.call('browser_click', { ref: 'e1' }, CTX);
    expect(click.isError).toBe(true);
    expect(click.output).toBe('user has taken over the browser — ask them to resume agent control');

    // Observation tools still go through.
    const snap = await registry.call('browser_snapshot', {}, CTX);
    expect(snap.isError).toBeFalsy();
    expect(snap.output).toContain('http://localhost:3000/');
    expect(stub.calls.map((c) => c.method)).toEqual(['browser/snapshot']);
  });

  it('action tools proceed when control is with the agent', async () => {
    const { registry, stub } = registered();
    stub.control = 'agent';
    const r = await registry.call('browser_click', { ref: 'e1' }, CTX);
    expect(r.isError).toBeFalsy();
    expect(stub.calls.map((c) => c.method)).toEqual(['browser/click']);
  });
});
