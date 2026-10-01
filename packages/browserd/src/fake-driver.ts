import {
  DriverError,
  type ConsoleEntry,
  type Driver,
  type NetworkEntry,
  type OpenResult,
  type SnapshotResult,
  type AxNode,
} from './driver.js';

/** A 1x1 transparent PNG — FakeDriver screenshots without a browser. */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** In-memory DOM node. `id` doubles as the stable ref (e.g. "e1"). */
export interface FakeNode {
  id: string;
  role: string;
  name?: string;
  value?: string;
  visible?: boolean;
  children?: FakeNode[];
  /** Test instrumentation — what the driver did to this node. */
  clicked?: boolean;
  typed?: string;
  submitted?: boolean;
}

/** One in-memory page. */
export interface FakePage {
  url: string;
  title: string;
  nodes: FakeNode[];
  consoleEntries?: ConsoleEntry[];
  networkEntries?: NetworkEntry[];
}

function toAx(nodes: FakeNode[]): AxNode[] {
  return nodes.map((n) => {
    const ax: AxNode = { ref: n.id, role: n.role, visible: n.visible ?? true };
    if (n.name !== undefined) ax.name = n.name;
    if (n.value !== undefined) ax.value = n.value;
    if (n.children) ax.children = toAx(n.children);
    return ax;
  });
}

/**
 * FakeDriver — in-memory DOM stub implementing the Driver interface.
 * No browser, no network. Tests construct pages explicitly (or get a blank
 * page per unknown URL) and assert on node instrumentation.
 */
export class FakeDriver implements Driver {
  readonly name = 'fake';
  private pages = new Map<string, FakePage>();
  private current: FakePage | null = null;
  private closedFlag = false;
  private lastKey: string | null = null;
  private lastScroll: { ref?: string; dx?: number; dy?: number } | null = null;
  private readonly evalAllowed: boolean;

  constructor(pages: FakePage[] = [], evalAllowed = false) {
    for (const p of pages) this.pages.set(p.url, p);
    this.evalAllowed = evalAllowed;
  }

  /** Test hook: last key sent via press(). */
  get pressedKey(): string | null {
    return this.lastKey;
  }

  /** Test hook: last scroll arguments. */
  get scrolled(): { ref?: string; dx?: number; dy?: number } | null {
    return this.lastScroll;
  }

  get isClosed(): boolean {
    return this.closedFlag;
  }

  /** Test hook: reach into the fake DOM. */
  pageFor(url: string): FakePage | undefined {
    return this.pages.get(url);
  }

  /** Test hook: append a console entry to the current page. */
  pushConsole(entry: Omit<ConsoleEntry, 'ts'> & { ts?: number }): void {
    this.current?.consoleEntries?.push({ ts: Date.now(), ...entry });
  }

  private findNode(ref: string): FakeNode {
    if (!this.current) throw new DriverError('no page open');
    const stack = [...this.current.nodes];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.id === ref) return n;
      if (n.children) stack.push(...n.children);
    }
    throw new DriverError(`unknown element ref: ${ref}`);
  }

  private findByText(text: string): FakeNode | undefined {
    if (!this.current) return undefined;
    const stack = [...this.current.nodes];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.name?.includes(text) && (n.visible ?? true)) return n;
      if (n.children) stack.push(...n.children);
    }
    return undefined;
  }

  async open(url: string): Promise<OpenResult> {
    this.assertOpen();
    let page = this.pages.get(url);
    if (!page) {
      page = { url, title: url, nodes: [], consoleEntries: [], networkEntries: [] };
      this.pages.set(url, page);
    }
    page.networkEntries ??= [];
    page.networkEntries.push({ url, method: 'GET', status: 200, ts: Date.now() });
    this.current = page;
    return { url: page.url, title: page.title };
  }

  async snapshot(): Promise<SnapshotResult> {
    this.assertOpen();
    // No page open yet → empty snapshot (matches a fresh browser tab).
    if (!this.current) return { url: null, title: '', nodes: [] };
    return { url: this.current.url, title: this.current.title, nodes: toAx(this.current.nodes) };
  }

  async click(ref: string): Promise<void> {
    this.assertOpen();
    this.findNode(ref).clicked = true;
  }

  async type(ref: string, text: string, opts?: { submit?: boolean }): Promise<void> {
    this.assertOpen();
    const node = this.findNode(ref);
    node.typed = text;
    node.value = text;
    if (opts?.submit) node.submitted = true;
  }

  async press(key: string): Promise<void> {
    this.assertOpen();
    this.lastKey = key;
  }

  async scroll(opts?: { ref?: string; dx?: number; dy?: number }): Promise<void> {
    this.assertOpen();
    if (opts?.ref) this.findNode(opts.ref); // validate the ref
    this.lastScroll = { ...opts };
  }

  async wait(opts?: { ms?: number; selector?: string; timeoutMs?: number }): Promise<void> {
    this.assertOpen();
    if (opts?.selector) {
      // Fake selectors: "#id" matches a node id, otherwise substring of role/name.
      const sel = opts.selector;
      const found = sel.startsWith('#')
        ? this.safeFind(sel.slice(1))
        : this.findByText(sel.replace(/^[a-z]+\[name="(.+)"\]$/, '$1'));
      if (!found) throw new DriverError(`wait: selector not found: ${sel}`);
    }
    // ms waits are a no-op in the fake (keeps tests fast); recorded implicitly.
  }

  async eval(fn: string, _arg?: unknown): Promise<unknown> {
    this.assertOpen();
    if (!this.evalAllowed) {
      throw new DriverError('page eval is disabled by browser policy (restricted)');
    }
    // Tiny honest whitelist over the fake DOM — the fake has no JS engine.
    const f = fn.trim();
    if (f === '() => document.title') return this.current?.title ?? null;
    if (f === '() => location.href') return this.current?.url ?? null;
    const lit = f.match(/^\(\) => ['"](.+)['"]$/);
    if (lit) return lit[1];
    throw new DriverError(`FakeDriver eval supports only document.title/location.href/literals, got: ${f}`);
  }

  async screenshot(_opts?: { fullPage?: boolean }): Promise<Buffer> {
    this.assertOpen();
    return Buffer.from(TINY_PNG_BASE64, 'base64');
  }

  async consoleEntries(limit?: number): Promise<ConsoleEntry[]> {
    this.assertOpen();
    const entries = this.current?.consoleEntries ?? [];
    return entries.slice(-(limit ?? 100));
  }

  async networkEntries(limit?: number): Promise<NetworkEntry[]> {
    this.assertOpen();
    const entries = this.current?.networkEntries ?? [];
    return entries.slice(-(limit ?? 100));
  }

  async close(): Promise<void> {
    this.closedFlag = true;
    this.current = null;
  }

  private safeFind(ref: string): FakeNode | undefined {
    try {
      return this.findNode(ref);
    } catch {
      return undefined;
    }
  }

  private assertOpen(): void {
    if (this.closedFlag) throw new DriverError('driver is closed');
  }
}
