import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DriverError,
  type ConsoleEntry,
  type Driver,
  type NetworkEntry,
  type OpenResult,
  type RecordingStartOptions,
  type RecordingStopResult,
  type ScreencastFrameHandler,
  type SnapshotResult,
  type AxNode,
} from './driver.js';

/**
 * Accessibility-tree snapshot script, injected into the page. Walks the DOM
 * in document order, mints stable `data-sr` refs (e.g. "e12") on observable
 * elements, and returns a compact serializable tree. Actions resolve refs via
 * the `[data-sr="…"]` selector, so a ref always points at the same element it
 * was minted for (until the DOM mutates).
 */
const SNAPSHOT_SCRIPT = `() => {
  const out = [];
  let n = 0;
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','HEAD']);
  function roleOf(el) {
    const tag = el.tagName;
    if (el.getAttribute('role')) return el.getAttribute('role');
    switch (tag) {
      case 'A': return 'link';
      case 'BUTTON': return 'button';
      case 'INPUT': {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
        if (t === 'hidden') return null;
        return 'textbox';
      }
      case 'SELECT': return 'combobox';
      case 'TEXTAREA': return 'textbox';
      case 'IMG': return 'img';
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return 'heading';
      case 'FORM': return 'form';
      case 'NAV': return 'navigation';
      case 'MAIN': return 'main';
      case 'TABLE': return 'table';
      default: return null;
    }
  }
  function nameOf(el, role) {
    const labelled = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title');
    if (labelled) return labelled.trim().slice(0, 100);
    if (role === 'textbox' || role === 'combobox') {
      const ph = el.getAttribute('placeholder');
      if (ph) return ph.trim().slice(0, 100);
    }
    const text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    return text ? text.slice(0, 100) : undefined;
  }
  function visible(el) {
    if (el.getAttribute('type') === 'hidden') return false;
    const rects = el.getClientRects();
    if (!rects.length) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }
  function walk(el, parent) {
    if (el.nodeType !== 1 || SKIP.has(el.tagName)) return;
    const role = roleOf(el);
    const kids = [];
    for (const child of el.children) walk(child, kids);
    if (!role) {
      // Transparent container: hoist observable children.
      for (const k of kids) parent.push(k);
      return;
    }
    const ref = 'e' + (n++);
    el.setAttribute('data-sr', ref);
    const node = { ref, role, visible: visible(el) };
    const name = nameOf(el, role);
    if (name) node.name = name;
    if ((role === 'textbox' || role === 'combobox') && 'value' in el) node.value = String(el.value).slice(0, 500);
    if (role === 'checkbox' || role === 'radio') node.checked = !!el.checked;
    if (el.disabled) node.disabled = true;
    if (kids.length) node.children = kids;
    parent.push(node);
  }
  walk(document.documentElement, out);
  return out;
}`;

export interface PlaywrightDriverOptions {
  workspaceRoot?: string;
  headless?: boolean;
  /** Extra Chromium launch args. */
  args?: string[];
}

/** Own profile dir per workspace: ~/.sunday/browser/<sha16(workspaceRoot)>. */
export function profileDirFor(workspaceRoot?: string): string {
  const hash = createHash('sha256').update(workspaceRoot ?? 'default').digest('hex').slice(0, 16);
  return join(homedir(), '.sunday', 'browser', hash);
}

/**
 * PlaywrightDriver — real Chromium controlled via Playwright (§18.2).
 * The `playwright` module is loaded with a dynamic import on first use, so
 * merely importing this module never touches the browser stack.
 */
export class PlaywrightDriver implements Driver {
  readonly name = 'playwright';
  private ctx: any | undefined;
  private page: any | undefined;
  private readonly consoleBuf: ConsoleEntry[] = [];
  private readonly networkBuf: NetworkEntry[] = [];
  private readonly evalAllowed: boolean;
  /** Active CDP screencast session, if any. */
  private cdp: any | undefined;
  /** Last URL navigated to — used to restore the page after a video relaunch. */
  private lastUrl: string | null = null;
  /**
   * Video recording dir. recordVideo is a context-launch option, so a
   * video request on an already-launched context relaunches it.
   */
  private videoDir: string | undefined;
  private videoActive = false;
  private tracingActive = false;
  private recordingDir: string | undefined;

  constructor(private readonly opts: PlaywrightDriverOptions = {}, evalAllowed = false) {
    this.evalAllowed = evalAllowed;
  }

  /** Load playwright lazily — the ONLY place the module is touched. */
  private async loadPlaywright(): Promise<any> {
    return (await import('playwright')) as any;
  }

  private async ensureLaunched(): Promise<void> {
    if (this.ctx) return;
    const { chromium } = await this.loadPlaywright();
    const userDataDir = profileDirFor(this.opts.workspaceRoot);
    const baseOpts: Record<string, unknown> = {
      headless: this.opts.headless ?? true,
      // §18.2: never touch the user's real profile; no passwords, no downloads.
      acceptDownloads: false,
      args: this.opts.args ?? [],
    };
    if (this.videoDir) {
      // Video recording is a context-launch option (no mid-session enable).
      baseOpts.recordVideo = { dir: this.videoDir };
    }
    // Prefer the user's installed Chrome/Chromium (keeps installs small);
    // fall back to playwright's bundled chromium.
    const attempts: Array<Record<string, unknown>> = [{ channel: 'chrome' }, { channel: 'chromium' }, {}];
    let lastErr: unknown;
    for (const attempt of attempts) {
      try {
        this.ctx = await chromium.launchPersistentContext(userDataDir, { ...baseOpts, ...attempt });
        break;
      } catch (err) {
        lastErr = err;
        if (!('channel' in attempt)) throw err; // bundled chromium failed too — give up
      }
    }
    if (!this.ctx) {
      throw new DriverError(
        `playwright: could not launch any chromium: ${(lastErr as Error)?.message ?? lastErr}`,
      );
    }
    this.videoActive = this.videoDir !== undefined;
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    this.attachPageListeners(this.page);
  }

  /** (Re)attach console/network capture to a page — also used after the
   *  video-recording relaunch and the post-video fresh page. */
  private attachPageListeners(page: any): void {
    page.on('console', (msg: any) => {
      this.consoleBuf.push({
        type: msg.type() as ConsoleEntry['type'],
        text: String(msg.text()).slice(0, 2000),
        location: msg.location()?.url,
        ts: Date.now(),
      });
      if (this.consoleBuf.length > 200) this.consoleBuf.shift();
    });
    page.on('response', (res: any) => {
      const req = res.request();
      this.networkBuf.push({
        url: req.url(),
        method: req.method(),
        status: res.status(),
        ts: Date.now(),
      });
      if (this.networkBuf.length > 200) this.networkBuf.shift();
    });
  }

  /**
   * Relaunch the persistent context with video recording enabled. The profile
   * (cookies, storage) survives; the open page is restored from lastUrl.
   */
  private async relaunchWithVideo(): Promise<void> {
    const url = this.lastUrl;
    await this.stopScreencast().catch(() => undefined);
    await this.ctx?.close().catch(() => undefined);
    this.ctx = undefined;
    this.page = undefined;
    this.tracingActive = false; // tracing belonged to the old context
    await this.ensureLaunched();
    if (url) {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    }
  }

  private async ensurePage(): Promise<any> {
    await this.ensureLaunched();
    return this.page;
  }

  private refSelector(ref: string): string {
    if (!/^e\d+$/.test(ref)) throw new DriverError(`bad element ref: ${ref}`);
    return `[data-sr="${ref}"]`;
  }

  async open(url: string): Promise<OpenResult> {
    const page = await this.ensurePage();
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (!res) throw new DriverError(`navigation produced no response: ${url}`);
    this.lastUrl = page.url();
    return { url: page.url(), title: await page.title() };
  }

  async snapshot(): Promise<SnapshotResult> {
    const page = await this.ensurePage();
    const nodes = (await page.evaluate(SNAPSHOT_SCRIPT)) as AxNode[];
    return { url: page.url() || null, title: await page.title(), nodes };
  }

  async click(ref: string): Promise<void> {
    const page = await this.ensurePage();
    await page.click(this.refSelector(ref), { timeout: 10_000 });
  }

  async type(ref: string, text: string, opts?: { submit?: boolean }): Promise<void> {
    const page = await this.ensurePage();
    const sel = this.refSelector(ref);
    await page.fill(sel, text, { timeout: 10_000 });
    if (opts?.submit) await page.press(sel, 'Enter');
  }

  async press(key: string): Promise<void> {
    const page = await this.ensurePage();
    await page.keyboard.press(key);
  }

  async scroll(opts?: { ref?: string; dx?: number; dy?: number }): Promise<void> {
    const page = await this.ensurePage();
    if (opts?.ref) {
      await page.locator(this.refSelector(opts.ref)).scrollIntoViewIfNeeded({ timeout: 10_000 });
      return;
    }
    await page.mouse.wheel(opts?.dx ?? 0, opts?.dy ?? 500);
  }

  async wait(opts?: { ms?: number; selector?: string; timeoutMs?: number }): Promise<void> {
    const page = await this.ensurePage();
    if (opts?.selector) {
      await page.waitForSelector(opts.selector, { timeout: opts.timeoutMs ?? 10_000 });
      return;
    }
    await page.waitForTimeout(opts?.ms ?? 500);
  }

  async eval(fn: string, arg?: unknown): Promise<unknown> {
    if (!this.evalAllowed) {
      throw new DriverError('page eval is disabled by browser policy (restricted)');
    }
    const page = await this.ensurePage();
    // Runs in page context only — no node access by construction.
    return page.evaluate(`(${fn})(arg)`, { arg });
  }

  async screenshot(opts?: { fullPage?: boolean }): Promise<Buffer> {
    const page = await this.ensurePage();
    return page.screenshot({ fullPage: opts?.fullPage ?? false, type: 'png' });
  }

  async consoleEntries(limit?: number): Promise<ConsoleEntry[]> {
    await this.ensureLaunched();
    return this.consoleBuf.slice(-(limit ?? 100));
  }

  async networkEntries(limit?: number): Promise<NetworkEntry[]> {
    await this.ensureLaunched();
    return this.networkBuf.slice(-(limit ?? 100));
  }

  async startScreencast(onFrame: ScreencastFrameHandler): Promise<void> {
    const page = await this.ensurePage();
    await this.stopScreencast(); // restarting replaces the previous screencast
    const cdp = await page.context().newCDPSession(page);
    this.cdp = cdp;
    cdp.on('screencastFrame', (ev: { data: string; sessionId: string }) => {
      try {
        onFrame(Buffer.from(ev.data, 'base64'));
      } catch {
        /* a throwing listener must not break the CDP session */
      }
      // Ack every frame or Chromium stops sending them.
      void cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => undefined);
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      everyNthFrame: 1,
      maxWidth: 1280,
      maxHeight: 800,
    });
  }

  async stopScreencast(): Promise<void> {
    const cdp = this.cdp;
    this.cdp = undefined;
    if (cdp) {
      await cdp.send('Page.stopScreencast').catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    }
  }

  async goBack(): Promise<void> {
    const page = await this.ensurePage();
    await page.goBack({ timeout: 10_000 });
  }

  async goForward(): Promise<void> {
    const page = await this.ensurePage();
    await page.goForward({ timeout: 10_000 });
  }

  async reload(): Promise<void> {
    const page = await this.ensurePage();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  }

  async startRecording(opts: RecordingStartOptions): Promise<void> {
    const { dir, video = false, trace = false } = opts;
    await mkdir(dir, { recursive: true });
    this.recordingDir = dir;
    if (video) {
      this.videoDir = dir;
      // recordVideo is a context-launch option: relaunch when the live
      // context wasn't started with it.
      await this.ensureLaunched();
      if (!this.videoActive) await this.relaunchWithVideo();
    }
    if (trace && !this.tracingActive) {
      await this.ensureLaunched();
      await this.ctx.tracing.start({ screenshots: true, snapshots: true });
      this.tracingActive = true;
    }
  }

  async stopRecording(): Promise<RecordingStopResult> {
    const out: RecordingStopResult = {};
    const dir = this.recordingDir;
    if (this.tracingActive && this.ctx && dir) {
      const tracePath = join(dir, 'trace.zip');
      await this.ctx.tracing.stop({ path: tracePath }).catch(() => undefined);
      out.tracePath = tracePath;
      this.tracingActive = false;
    }
    const page = this.page;
    const video = page?.video?.() as { saveAs(p: string): Promise<void> } | undefined;
    if (video && dir) {
      // The video file finalizes on page close: close, save the artifact
      // into the media dir, then keep the session alive with a fresh page.
      const videoPath = join(dir, 'video.webm');
      await page.close().catch(() => undefined);
      await video.saveAs(videoPath).catch(() => undefined);
      out.videoPath = videoPath;
      if (this.ctx) {
        this.page = await this.ctx.newPage().catch(() => undefined);
        if (this.page) this.attachPageListeners(this.page);
      }
    }
    this.recordingDir = undefined;
    return out;
  }

  async close(): Promise<void> {
    await this.stopScreencast().catch(() => undefined);
    await this.ctx?.close().catch(() => undefined);
    this.ctx = undefined;
    this.page = undefined;
    this.videoActive = false;
    this.tracingActive = false;
    this.recordingDir = undefined;
    this.videoDir = undefined;
    this.lastUrl = null;
  }
}
