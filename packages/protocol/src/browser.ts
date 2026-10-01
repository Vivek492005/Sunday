import { z } from 'zod';

/** Browser RPC surface (§18, Phase 6): the `browser/*` methods spoken by the
 *  browserd child process over stdio NDJSON JSON-RPC. Mirrors the
 *  CONTEXT_METHODS shape: params/result zod schemas per method. */

export const axNodeSchema: z.ZodType<AxNode> = z.object({
  /** Stable element ref within the page (e.g. "e12") — the handle for
   *  browser/click, browser/type, browser/scroll. */
  ref: z.string().min(1),
  role: z.string().min(1),
  name: z.string().optional(),
  value: z.string().optional(),
  visible: z.boolean(),
  children: z.array(z.lazy(() => axNodeSchema)).optional(),
});
/** Accessibility-tree node with a stable ref — the primary (token-cheap)
 *  browser observation (§18.2). */
export interface AxNode {
  ref: string;
  role: string;
  name?: string;
  value?: string;
  visible: boolean;
  children?: AxNode[];
}

export const consoleEntrySchema = z.object({
  type: z.enum(['log', 'info', 'warn', 'error', 'debug']),
  text: z.string(),
  location: z.string().optional(),
  ts: z.number().int().nonnegative(),
});
export type ConsoleEntry = z.infer<typeof consoleEntrySchema>;

export const networkEntrySchema = z.object({
  url: z.string(),
  method: z.string(),
  status: z.number().int().optional(),
  ts: z.number().int().nonnegative(),
});
export type NetworkEntry = z.infer<typeof networkEntrySchema>;

/** One check inside the verify_ui macro (§18.3). */
export const verifyCheckSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text_present'), text: z.string().min(1) }),
  z.object({ kind: z.literal('no_console_errors') }),
  z.object({
    kind: z.literal('element_visible'),
    ref: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal('title_contains'), text: z.string().min(1) }),
]);
export type VerifyCheck = z.infer<typeof verifyCheckSchema>;

export const verifyCheckResultSchema = z.object({
  kind: z.string().min(1),
  passed: z.boolean(),
  detail: z.string().optional(),
});
export type VerifyCheckResult = z.infer<typeof verifyCheckResultSchema>;

export const BROWSER_METHODS = {
  'browser/ping': {
    params: z.object({}),
    result: z.object({
      ok: z.literal(true),
      version: z.string().min(1),
      driver: z.string().min(1),
    }),
  },
  'browser/open': {
    params: z.object({
      url: z.string().min(1),
      /** Set when retrying after a needsApproval response — records the
       *  origin as approved for the rest of the session (§18.2). */
      approve: z.boolean().optional(),
    }),
    result: z.object({
      ok: z.boolean(),
      url: z.string().optional(),
      title: z.string().optional(),
      needsApproval: z.boolean().optional(),
      origin: z.string().optional(),
    }),
  },
  'browser/snapshot': {
    params: z.object({}),
    result: z.object({
      url: z.string().nullable(),
      title: z.string(),
      nodes: z.array(axNodeSchema),
    }),
  },
  'browser/click': {
    params: z.object({ ref: z.string().min(1) }),
    result: z.object({ ok: z.literal(true) }),
  },
  'browser/type': {
    params: z.object({
      ref: z.string().min(1),
      text: z.string(),
      submit: z.boolean().optional(),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'browser/press': {
    params: z.object({ key: z.string().min(1) }),
    result: z.object({ ok: z.literal(true) }),
  },
  'browser/scroll': {
    params: z.object({
      ref: z.string().min(1).optional(),
      dx: z.number().optional(),
      dy: z.number().optional(),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'browser/wait': {
    params: z.object({
      ms: z.number().int().nonnegative().max(60_000).optional(),
      selector: z.string().min(1).optional(),
      timeoutMs: z.number().int().positive().max(120_000).optional(),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'browser/eval': {
    params: z.object({
      /** Stringified function body executed in page context. Restricted:
       *  rejected server-side unless the daemon was started with eval
       *  explicitly enabled (§18.2). */
      fn: z.string().min(1).max(4000),
      arg: z.unknown().optional(),
    }),
    result: z.object({ result: z.unknown() }),
  },
  'browser/screenshot': {
    params: z.object({ fullPage: z.boolean().optional() }),
    result: z.object({
      /** PNG bytes, base64-encoded. */
      png: z.string().min(1),
      bytes: z.number().int().nonnegative(),
    }),
  },
  'browser/console': {
    params: z.object({ limit: z.number().int().positive().max(500).optional() }),
    result: z.object({ entries: z.array(consoleEntrySchema) }),
  },
  'browser/network': {
    params: z.object({ limit: z.number().int().positive().max(500).optional() }),
    result: z.object({ requests: z.array(networkEntrySchema) }),
  },
  'browser/close': {
    params: z.object({}),
    result: z.object({ ok: z.literal(true) }),
  },
  /** §18.3 macro: server-ready wait → open → snapshot → checks → screenshot
   *  → report. Composed server-side for weaker models. */
  'browser/verify_ui': {
    params: z.object({
      url: z.string().min(1),
      checks: z.array(verifyCheckSchema).min(1).max(20),
      /** How long to wait for the dev server to become ready. */
      readyTimeoutMs: z.number().int().positive().max(300_000).optional(),
      approve: z.boolean().optional(),
    }),
    result: z.object({
      ok: z.boolean(),
      url: z.string().optional(),
      needsApproval: z.boolean().optional(),
      origin: z.string().optional(),
      checks: z.array(verifyCheckResultSchema),
      consoleErrors: z.number().int().nonnegative(),
      screenshotPng: z.string().optional(),
    }),
  },
} as const;
export type BrowserMethodName = keyof typeof BROWSER_METHODS;
