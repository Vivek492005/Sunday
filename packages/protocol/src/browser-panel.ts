import { z } from 'zod';

/** Browser Agent panel RPC surface (Browser Agent UI phase): the
 *  `browser/panel/*` methods spoken by the sunday-agent extension's Agent
 *  Browser webview panel to sundayd. sundayd fans them out to the managed
 *  browserd child via BrowserdManager (packages/sundayd/src/browser-panel.ts).
 *
 *  Additive — mirrors the CONTEXT_METHODS shape (params/result zod schemas
 *  per method) and changes no existing surface. `browser/panel/open` reuses
 *  the browserd `browser/open` result shape so the panel can surface
 *  needsApproval flows. */

const controlSchema = z.enum(['agent', 'user']);

export const BROWSER_PANEL_METHODS = {
  /** Ensure browserd is running (no-op when already running). */
  'browser/panel/ensure': {
    params: z.object({}),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Open a URL in the agent browser (passthrough of browserd `browser/open`). */
  'browser/panel/open': {
    params: z.object({ url: z.string().min(1) }),
    result: z.object({
      ok: z.boolean(),
      url: z.string().optional(),
      title: z.string().optional(),
      needsApproval: z.boolean().optional(),
      origin: z.string().optional(),
    }),
  },
  /** Latest screencast frame (base64 JPEG), null when no frame yet. The
   *  daemon starts the screencast on first call. */
  'browser/panel/frame': {
    params: z.object({}),
    result: z.object({ data: z.string().nullable() }),
  },
  /** Hand control of the browser to the user; agent action tools fail fast
   *  while the user holds control (daemon-enforced). */
  'browser/panel/takeover': {
    params: z.object({}),
    result: z.object({ control: z.literal('user') }),
  },
  /** Hand control back to the agent. */
  'browser/panel/release': {
    params: z.object({}),
    result: z.object({ control: z.literal('agent') }),
  },
  /** Current control holder. */
  'browser/panel/control': {
    params: z.object({}),
    result: z.object({ control: controlSchema }),
  },
  /** One-shot screenshot for display in the panel (base64 PNG). */
  'browser/panel/screenshot': {
    params: z.object({}),
    result: z.object({ data: z.string().min(1) }),
  },
  /** Stop the screencast and close the browser session. */
  'browser/panel/close': {
    params: z.object({}),
    result: z.object({ ok: z.literal(true) }),
  },
  // ------------------------------------------------- F11: browser-verified
  // UI loop (Sunday IDE Ops view). Same browserd RPCs the agent tools call.
  /** Pixel-compare two screenshots (base64 PNGs). */
  'browser/panel/visual-diff': {
    params: z.object({
      beforePng: z.string().min(1),
      afterPng: z.string().min(1),
      threshold: z.number().min(0).max(1).optional(),
    }),
    result: z.object({
      diffPixels: z.number(),
      totalPixels: z.number(),
      diffRatio: z.number(),
      diffPng: z.string().optional(),
      diffPath: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
    }).passthrough(),
  },
  /** axe-core accessibility scan of the current page. */
  'browser/panel/accessibility-scan': {
    params: z.object({}),
    result: z.object({
      violations: z.array(z.object({
        id: z.string(),
        impact: z.string().nullable(),
        description: z.string(),
        nodes: z.number(),
      })).optional(),
      passes: z.number().optional(),
      url: z.string().optional(),
    }).passthrough(),
  },
  /** Capture a URL across the mobile/tablet/desktop viewport matrix. */
  'browser/panel/viewport-matrix': {
    params: z.object({
      url: z.string().min(1),
      viewports: z.array(z.object({
        name: z.string(),
        width: z.number(),
        height: z.number(),
      })).min(1).max(8).optional(),
    }),
    result: z.object({
      shots: z.array(z.object({
        name: z.string(),
        width: z.number(),
        height: z.number(),
        path: z.string().optional(),
        png: z.string().optional(),
      })).optional(),
    }).passthrough(),
  },
} as const;
