import { createRequire } from 'node:module';
import { z } from 'zod';
import {
  BROWSER_METHODS,
  ErrorCode,
  type AxNode,
  type BrowserMethodName,
  type ConsoleEntry,
  type VerifyCheck,
  type VerifyCheckResult,
} from '@sunday/protocol';
import { DriverError, type Driver, type OpenResult } from './driver.js';
import { PlaywrightDriver } from './playwright-driver.js';
import { BrowserPolicy, BrowserPolicyError, type BrowserPolicyOptions } from './policy.js';
import { BrowserRpcError, BrowserTransport } from './transport.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: string };
export const BROWSERD_VERSION: string = pkg.version ?? '0.0.1';

export interface BrowserdConfig extends BrowserPolicyOptions {
  workspaceRoot?: string;
  /** Restricted page eval (§18.2). Default false — browser/eval is denied. */
  allowEval?: boolean;
  headless?: boolean;
  /** How long verify_ui waits for the dev server to become ready. */
  readyTimeoutMs?: number;
  /** Dependency injection (tests). Defaults to a real PlaywrightDriver. */
  createDriver?: () => Driver;
  /**
   * What to do when stdin closes (client hung up). Defaults to closing the
   * driver and process.exit(0). Tests pass a noop so the runner survives.
   */
  onStdinClose?: () => void;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Collect every searchable string from a snapshot subtree. */
function snapshotText(nodes: AxNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: AxNode[]): void => {
    for (const n of ns) {
      if (n.name) out.push(n.name);
      if (n.value) out.push(n.value);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

function findRef(nodes: AxNode[], ref: string): AxNode | undefined {
  for (const n of nodes) {
    if (n.ref === ref) return n;
    const hit = n.children ? findRef(n.children, ref) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

function findText(nodes: AxNode[], text: string): AxNode | undefined {
  for (const n of nodes) {
    if (n.name?.includes(text) && n.visible) return n;
    const hit = n.children ? findText(n.children, text) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

/** Validate inbound params against the BROWSER_METHODS zod schemas. */
function parseBrowser<M extends BrowserMethodName>(
  method: M,
  params: unknown,
): z.infer<(typeof BROWSER_METHODS)[M]['params']> {
  const def = BROWSER_METHODS[method] as { params: z.ZodTypeAny };
  return def.params.parse(params) as z.infer<(typeof BROWSER_METHODS)[M]['params']>;
}

/**
 * browserd — the Sunday browser controller (§18, Phase 6). Speaks `browser/*`
 * JSON-RPC over stdio, owns one Driver (real Playwright Chromium or an
 * injected fake), and enforces the navigation security policy server-side.
 */
export class BrowserdServer {
  private readonly policy: BrowserPolicy;
  private readonly allowEval: boolean;
  private readonly readyTimeoutMs: number;
  private readonly createDriver: () => Driver;
  private readonly workspaceRoot?: string;
  private readonly headless: boolean;
  private readonly onStdinClose?: () => void;
  private driver: Driver | undefined;
  /** Origins the client approved this session (needsApproval → approve). */
  private readonly approvedOrigins = new Set<string>();
  private currentUrl: string | null = null;

  constructor(config: BrowserdConfig = {}) {
    this.policy = new BrowserPolicy({ approvedDomains: config.approvedDomains });
    this.allowEval = config.allowEval ?? false;
    this.readyTimeoutMs = config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.workspaceRoot = config.workspaceRoot;
    this.headless = config.headless ?? true;
    this.onStdinClose = config.onStdinClose;
    this.createDriver =
      config.createDriver ??
      (() => new PlaywrightDriver({ workspaceRoot: this.workspaceRoot, headless: this.headless }, this.allowEval));
  }

  /** Test hook: the live driver, if any. */
  getDriver(): Driver | undefined {
    return this.driver;
  }

  /** Test hook: origins approved via the needsApproval flow. */
  getApprovedOrigins(): string[] {
    return [...this.approvedOrigins];
  }

  start(
    input: NodeJS.ReadableStream = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
  ): void {
    const transport = new BrowserTransport((method, params) => this.dispatch(method, params), input, output, {
      onStdinClose: this.onStdinClose ?? (() => void this.shutdown()),
    });
    transport.start();
  }

  private async shutdown(): Promise<void> {
    await this.driver?.close().catch(() => undefined);
    process.exit(0);
  }

  private ensureDriver(): Driver {
    if (!this.driver) this.driver = this.createDriver();
    return this.driver;
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    if (!(method in BROWSER_METHODS)) {
      throw new BrowserRpcError(ErrorCode.MethodNotFound, `unknown method: ${method}`);
    }
    const name = method as BrowserMethodName;
    switch (name) {
      case 'browser/ping': {
        parseBrowser(name, params);
        const d = this.ensureDriver();
        return { ok: true as const, version: BROWSERD_VERSION, driver: d.name };
      }
      case 'browser/open': {
        const p = parseBrowser(name, params);
        return this.openPage(p.url, p.approve);
      }
      case 'browser/snapshot': {
        parseBrowser(name, params);
        const s = await this.ensureDriver().snapshot();
        this.currentUrl = s.url;
        return s;
      }
      case 'browser/click': {
        const p = parseBrowser(name, params);
        await this.requirePage().click(p.ref);
        return { ok: true as const };
      }
      case 'browser/type': {
        const p = parseBrowser(name, params);
        await this.requirePage().type(p.ref, p.text, { submit: p.submit });
        return { ok: true as const };
      }
      case 'browser/press': {
        const p = parseBrowser(name, params);
        await this.requirePage().press(p.key);
        return { ok: true as const };
      }
      case 'browser/scroll': {
        const p = parseBrowser(name, params);
        await this.requirePage().scroll({ ref: p.ref, dx: p.dx, dy: p.dy });
        return { ok: true as const };
      }
      case 'browser/wait': {
        const p = parseBrowser(name, params);
        await this.requirePage().wait({ ms: p.ms, selector: p.selector, timeoutMs: p.timeoutMs });
        return { ok: true as const };
      }
      case 'browser/eval': {
        const p = parseBrowser(name, params);
        if (!this.allowEval) {
          throw new BrowserRpcError(
            ErrorCode.PolicyDenied,
            'browser/eval is disabled by browser policy (restricted; enable explicitly)',
          );
        }
        const result = await this.requirePage().eval(p.fn, p.arg);
        return { result };
      }
      case 'browser/screenshot': {
        const p = parseBrowser(name, params);
        const png = await this.requirePage().screenshot({ fullPage: p.fullPage });
        return { png: png.toString('base64'), bytes: png.byteLength };
      }
      case 'browser/console': {
        const p = parseBrowser(name, params);
        const entries = await this.requirePage().consoleEntries(p.limit);
        return { entries };
      }
      case 'browser/network': {
        const p = parseBrowser(name, params);
        const requests = await this.requirePage().networkEntries(p.limit);
        return { requests };
      }
      case 'browser/close': {
        parseBrowser(name, params);
        await this.driver?.close().catch(() => undefined);
        this.driver = undefined; // next use relaunches fresh
        this.currentUrl = null;
        return { ok: true as const };
      }
      case 'browser/verify_ui': {
        const p = parseBrowser(name, params);
        return this.verifyUi(p.url, p.checks, p.readyTimeoutMs, p.approve);
      }
      default:
        throw new BrowserRpcError(ErrorCode.MethodNotFound, `unknown method: ${method}`);
    }
  }

  private requirePage(): Driver {
    const d = this.ensureDriver();
    if (!this.currentUrl) throw new DriverError('no page open — call browser/open first');
    return d;
  }

  /**
   * Policy-checked navigation. Returns needsApproval WITHOUT navigating on
   * first sight of a new origin (§18.2); the client retries with approve=true.
   */
  private async openPage(
    url: string,
    approve?: boolean,
  ): Promise<{ ok: boolean; url?: string; title?: string; needsApproval?: boolean; origin?: string }> {
    const decision = this.policy.checkNavigation(url, this.approvedOrigins);
    if (decision.kind === 'needsApproval') {
      if (!approve) {
        return { ok: false, needsApproval: true, origin: decision.origin };
      }
      this.approvedOrigins.add(decision.origin);
    }
    const r: OpenResult = await this.ensureDriver().open(url);
    this.currentUrl = r.url;
    return { ok: true, url: r.url, title: r.title };
  }

  /**
   * §18.3 macro: wait for the dev server to answer → open → snapshot → run
   * checks → screenshot → report. Blocked navigations (BrowserPolicyError)
   * fail fast; unreachable servers are retried until readyTimeoutMs.
   */
  private async verifyUi(
    url: string,
    checks: VerifyCheck[],
    readyTimeoutMs: number | undefined,
    approve: boolean | undefined,
  ): Promise<{
    ok: boolean;
    url?: string;
    needsApproval?: boolean;
    origin?: string;
    checks: VerifyCheckResult[];
    consoleErrors: number;
    screenshotPng?: string;
  }> {
    const timeoutMs = readyTimeoutMs ?? this.readyTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    let opened: OpenResult | undefined;
    let lastErr = 'unknown error';
    // Server-ready wait: poll until the page loads or the deadline passes.
    for (;;) {
      try {
        const r = await this.openPage(url, approve);
        if (r.needsApproval) {
          return { ok: false, needsApproval: true, origin: r.origin, checks: [], consoleErrors: 0 };
        }
        opened = { url: r.url!, title: r.title! };
        break;
      } catch (e) {
        if (e instanceof BrowserPolicyError) throw e; // blocked is not transient
        lastErr = (e as Error)?.message ?? String(e);
        if (Date.now() >= deadline) break;
        await sleep(Math.min(READY_POLL_MS, Math.max(0, deadline - Date.now())));
      }
    }
    if (!opened) {
      throw new BrowserRpcError(
        ErrorCode.InternalError,
        `verify_ui: server not ready at ${url} within ${timeoutMs}ms (last: ${lastErr})`,
      );
    }
    const driver = this.ensureDriver();
    const snap = await driver.snapshot();
    this.currentUrl = snap.url;
    const consoleEntries: ConsoleEntry[] = await driver.consoleEntries(500);
    const results = checks.map((c) => this.runCheck(c, snap.nodes, snap.title, consoleEntries));
    const shot = await driver.screenshot();
    const consoleErrors = consoleEntries.filter((e) => e.type === 'error').length;
    return {
      ok: results.every((r) => r.passed),
      url: opened.url,
      checks: results,
      consoleErrors,
      screenshotPng: shot.toString('base64'),
    };
  }

  private runCheck(
    check: VerifyCheck,
    nodes: AxNode[],
    title: string,
    consoleEntries: ConsoleEntry[],
  ): VerifyCheckResult {
    switch (check.kind) {
      case 'text_present': {
        const hay = snapshotText(nodes).join('\n') + '\n' + title;
        const passed = hay.includes(check.text);
        return { kind: check.kind, passed, detail: passed ? undefined : `text not found: ${check.text}` };
      }
      case 'no_console_errors': {
        const errors = consoleEntries.filter((e) => e.type === 'error');
        return {
          kind: check.kind,
          passed: errors.length === 0,
          detail: errors.length ? `${errors.length} console error(s), first: ${errors[0].text.slice(0, 200)}` : undefined,
        };
      }
      case 'element_visible': {
        if (!check.ref && !check.text) {
          return { kind: check.kind, passed: false, detail: 'element_visible needs ref or text' };
        }
        const node = check.ref ? findRef(nodes, check.ref) : findText(nodes, check.text!);
        if (!node) return { kind: check.kind, passed: false, detail: 'element not found' };
        return { kind: check.kind, passed: node.visible, detail: node.visible ? undefined : 'element is hidden' };
      }
      case 'title_contains': {
        const passed = title.includes(check.text);
        return { kind: check.kind, passed, detail: passed ? undefined : `title "${title}" lacks "${check.text}"` };
      }
    }
  }
}
