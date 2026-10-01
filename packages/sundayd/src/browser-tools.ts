// sundayd — browser_* agent tools (§18, Phase 6).
//
// The model drives the browser through these tools; each one delegates to the
// managed browserd child process via BrowserdManager. Tools are registered
// ONLY through registerBrowserTools() — they are NOT part of the default
// registry, so the browser is off by default unless the host opts in. Every
// tool is marked dangerous (needs explicit user approval, §9.6) and goes
// through the PolicyGate like every other tool.

import { err, type Tool, type ToolRegistry } from '@sunday/tools';
import type { AxNode } from '@sunday/protocol';
import type { BrowserdManager } from './browserd.js';
import { BrowserdClosedError, BrowserdRpcError, BrowserdTimeoutError } from './browserd.js';

const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const MAX_SNAPSHOT_NODES = 200;

function rpcErrorMessage(e: unknown): string {
  if (e instanceof BrowserdRpcError) return e.message;
  if (e instanceof BrowserdTimeoutError) return e.message;
  if (e instanceof BrowserdClosedError) return 'browserd is not running';
  return (e as Error)?.message ?? String(e);
}

/** Format an accessibility-tree snapshot as cheap readable lines. */
function formatSnapshot(url: string | null, title: string, nodes: AxNode[]): string {
  const lines = [`page: ${url ?? '(no page open)'} — ${title || '(untitled)'}`];
  let count = 0;
  const walk = (ns: AxNode[], depth: number): void => {
    for (const n of ns) {
      if (count >= MAX_SNAPSHOT_NODES) {
        lines.push(`…[${count}+ nodes, truncated]`);
        return;
      }
      count++;
      const name = n.name ? ` "${n.name}"` : '';
      const extra = [n.value !== undefined ? `value="${n.value.slice(0, 40)}"` : '', n.visible ? '' : 'hidden']
        .filter(Boolean)
        .join(' ');
      lines.push(`${'  '.repeat(depth)}${n.ref} [${n.role}]${name}${extra ? ' ' + extra : ''}`);
      if (n.children) walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return lines.join('\n');
}

function formatConsole(entries: Array<{ type: string; text: string; location?: string }>): string {
  if (!entries.length) return '(no console entries)';
  return entries.map((e) => `[${e.type}] ${e.text}${e.location ? ` (${e.location})` : ''}`).join('\n');
}

function formatNetwork(requests: Array<{ method: string; status?: number; url: string }>): string {
  if (!requests.length) return '(no network requests)';
  return requests.map((r) => `${r.method} ${r.status ?? '???'} ${r.url}`).join('\n');
}

interface BrowserToolSpec {
  name: string;
  method: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Per-tool RPC timeout override. */
  timeoutMs?: number;
  format: (result: any) => { output: string; metadata?: Record<string, unknown> };
}

function defineTool(manager: BrowserdManager, spec: BrowserToolSpec): Tool {
  return {
    definition: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      dangerous: true,
    },
    async execute(rawArgs) {
      const args = rawArgs as Record<string, unknown>;
      try {
        const timeout =
          spec.timeoutMs ??
          (spec.name === 'browser_verify_ui'
            ? (typeof args.readyTimeoutMs === 'number' ? args.readyTimeoutMs : DEFAULT_RPC_TIMEOUT_MS) +
              60_000
            : DEFAULT_RPC_TIMEOUT_MS);
        const result = await manager.rpc(spec.method, args, timeout);
        const { output, metadata } = spec.format(result);
        return metadata ? { output, metadata } : { output };
      } catch (e) {
        return err(`browser tool ${spec.name} failed: ${rpcErrorMessage(e)}`);
      }
    },
  };
}

/** All 13 browser tools (§18.2 + §18.3 macro). */
export function createBrowserTools(manager: BrowserdManager): Tool[] {
  const specs: BrowserToolSpec[] = [
    {
      name: 'browser_open',
      method: 'browser/open',
      description:
        'Open a URL in the agent browser. Returns needsApproval when navigating to a new origin for the first time — re-run with approve:true to allow it (localhost and user-approved domains never ask).',
      parameters: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', description: 'URL to open (http/https; file:// is blocked).' },
          approve: {
            type: 'boolean',
            description: 'Approve a previously reported new origin for this session.',
          },
        },
      },
      format: (r: any) =>
        r.needsApproval
          ? {
              output: `needs approval: new origin ${r.origin}. Re-run browser_open with approve:true to allow navigation for this session.`,
              metadata: { needsApproval: true, origin: r.origin },
            }
          : { output: `opened ${r.url}${r.title ? ` — ${r.title}` : ''}` },
    },
    {
      name: 'browser_snapshot',
      method: 'browser/snapshot',
      description:
        'Read the accessibility-tree snapshot of the current page: stable element refs (e1, e2, …) with roles and names. Token-cheap primary observation; use browser_screenshot for pixels.',
      parameters: { type: 'object', properties: {} },
      format: (r: any) => ({ output: formatSnapshot(r.url ?? null, r.title ?? '', r.nodes ?? []) }),
    },
    {
      name: 'browser_click',
      method: 'browser/click',
      description: 'Click an element by its snapshot ref (e.g. "e3").',
      parameters: {
        type: 'object',
        required: ['ref'],
        properties: { ref: { type: 'string', description: 'Element ref from browser_snapshot.' } },
      },
      format: (r: any) => ({ output: `clicked ${r.ref ?? ''}`.trim() }),
    },
    {
      name: 'browser_type',
      method: 'browser/type',
      description: 'Type text into an element by ref. Set submit:true to press Enter afterwards.',
      parameters: {
        type: 'object',
        required: ['ref', 'text'],
        properties: {
          ref: { type: 'string', description: 'Element ref from browser_snapshot.' },
          text: { type: 'string', description: 'Text to type.' },
          submit: { type: 'boolean', description: 'Press Enter after typing.' },
        },
      },
      format: () => ({ output: 'typed text into element' }),
    },
    {
      name: 'browser_press',
      method: 'browser/press',
      description: 'Press a keyboard key (e.g. "Enter", "Escape", "Tab", "ArrowDown").',
      parameters: {
        type: 'object',
        required: ['key'],
        properties: { key: { type: 'string', description: 'Key name.' } },
      },
      format: (r: any) => ({ output: `pressed ${r.key ?? 'key'}` }),
    },
    {
      name: 'browser_scroll',
      method: 'browser/scroll',
      description: 'Scroll the page (dx/dy pixels) or scroll an element into view by ref.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref to scroll into view.' },
          dx: { type: 'number', description: 'Horizontal scroll pixels.' },
          dy: { type: 'number', description: 'Vertical scroll pixels (default 500).' },
        },
      },
      format: () => ({ output: 'scrolled' }),
    },
    {
      name: 'browser_wait',
      method: 'browser/wait',
      description: 'Wait: a fixed delay (ms) or until a CSS selector appears (selector + timeoutMs).',
      parameters: {
        type: 'object',
        properties: {
          ms: { type: 'integer', description: 'Fixed delay in milliseconds.', minimum: 0, maximum: 60000 },
          selector: { type: 'string', description: 'CSS selector to wait for.' },
          timeoutMs: { type: 'integer', description: 'Selector wait timeout.', minimum: 1, maximum: 120000 },
        },
      },
      format: () => ({ output: 'wait complete' }),
    },
    {
      name: 'browser_eval',
      method: 'browser/eval',
      description:
        'RESTRICTED: evaluate a stringified function in page context. Denied unless the browser was started with eval explicitly enabled.',
      parameters: {
        type: 'object',
        required: ['fn'],
        properties: {
          fn: { type: 'string', description: 'Stringified function, e.g. "() => document.title".' },
          arg: { description: 'Optional argument passed to the function.' },
        },
      },
      format: (r: any) => ({ output: `eval result: ${JSON.stringify(r.result)}` }),
    },
    {
      name: 'browser_screenshot',
      method: 'browser/screenshot',
      description:
        'Capture a PNG screenshot of the current page. The PNG bytes are in metadata.png (base64); the text output is a short summary.',
      parameters: {
        type: 'object',
        properties: { fullPage: { type: 'boolean', description: 'Capture the full scrollable page.' } },
      },
      format: (r: any) => ({
        output: `screenshot captured (${r.bytes} bytes PNG)`,
        metadata: { png: r.png, bytes: r.bytes },
      }),
    },
    {
      name: 'browser_console',
      method: 'browser/console',
      description: 'Read recent console entries from the page (log/warn/error). Key for verify loops.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: 'Max entries (default 100).', minimum: 1, maximum: 500 } },
      },
      format: (r: any) => ({ output: formatConsole(r.entries ?? []) }),
    },
    {
      name: 'browser_network',
      method: 'browser/network',
      description: 'Read recent network requests from the page (method, status, URL).',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: 'Max entries (default 100).', minimum: 1, maximum: 500 } },
      },
      format: (r: any) => ({ output: formatNetwork(r.requests ?? []) }),
    },
    {
      name: 'browser_close',
      method: 'browser/close',
      description: 'Close the agent browser (releases the profile; a later tool call relaunches it).',
      parameters: { type: 'object', properties: {} },
      format: () => ({ output: 'browser closed' }),
    },
    {
      name: 'browser_verify_ui',
      method: 'browser/verify_ui',
      description:
        '§18.3 macro: wait for the dev server to be ready, open the URL, snapshot, run checks (text_present, no_console_errors, element_visible, title_contains), screenshot, and return a pass/fail report. Composed server-side.',
      parameters: {
        type: 'object',
        required: ['url', 'checks'],
        properties: {
          url: { type: 'string', description: 'URL to verify.' },
          checks: {
            type: 'array',
            description: 'Checks to run.',
            items: {
              type: 'object',
              required: ['kind'],
              properties: {
                kind: {
                  type: 'string',
                  enum: ['text_present', 'no_console_errors', 'element_visible', 'title_contains'],
                },
                text: { type: 'string', description: 'For text_present / title_contains / element_visible.' },
                ref: { type: 'string', description: 'For element_visible: snapshot ref.' },
              },
            },
            minItems: 1,
            maxItems: 20,
          },
          readyTimeoutMs: {
            type: 'integer',
            description: 'How long to wait for the dev server (default 30000).',
            minimum: 1,
            maximum: 300000,
          },
          approve: { type: 'boolean', description: 'Approve a new origin (see browser_open).' },
        },
      },
      format: (r: any) => {
        if (r.needsApproval) {
          return {
            output: `verify_ui needs approval: new origin ${r.origin}. Re-run with approve:true.`,
            metadata: { needsApproval: true, origin: r.origin },
          };
        }
        const checks = (r.checks ?? []) as Array<{ kind: string; passed: boolean; detail?: string }>;
        const passed = checks.filter((c) => c.passed).length;
        const lines = [
          `verify_ui ${r.url}: ${r.ok ? 'PASS' : 'FAIL'} (${passed}/${checks.length} checks, ${r.consoleErrors} console errors)`,
          ...checks.map((c) => `  ${c.passed ? '✓' : '✗'} ${c.kind}${c.detail ? ` — ${c.detail}` : ''}`),
        ];
        return {
          output: lines.join('\n'),
          metadata: { ok: r.ok, checks: r.checks, consoleErrors: r.consoleErrors, screenshotPng: r.screenshotPng },
        };
      },
    },
  ];
  return specs.map((s) => defineTool(manager, s));
}

export const BROWSER_TOOL_NAMES = [
  'browser_open',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_wait',
  'browser_eval',
  'browser_screenshot',
  'browser_console',
  'browser_network',
  'browser_close',
  'browser_verify_ui',
] as const;

/**
 * Register the browser_* tools on a registry. The host (cli/daemon wiring)
 * calls this only when the browser is opted in — browserd stays a lazy child
 * process spawned on first tool use.
 */
export function registerBrowserTools(registry: ToolRegistry, manager: BrowserdManager): void {
  for (const t of createBrowserTools(manager)) registry.register(t);
}
