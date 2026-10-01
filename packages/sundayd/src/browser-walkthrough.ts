// sundayd — browser_walkthrough agent tool (Browser Agent UI phase).
//
// The model narrates what it did in the agent browser; this tool captures
// screenshots per step and assembles a markdown walkthrough artifact:
//   <workspaceDir>/.sunday/artifacts/<sessionId>/walkthrough.md
//   <workspaceDir>/.sunday/artifacts/<sessionId>/media/step-N.png
//
// Registered ONLY through registerBrowserWalkthroughTools() — like the
// browser_* tools it is not part of the default registry. The coordinator
// wires this into the daemon; do not hand-edit cli.ts here.

import { basename, dirname } from 'node:path';
import { err, type Tool, type ToolRegistry, type ToolResult } from '@sunday/tools';
import type { BrowserdManager } from './browserd.js';
import { resolveSessionMediaDir, savePng, writeTextFile } from './browser-media.js';

/**
 * Minimal surface the walkthrough tool needs from the browser manager.
 *
 * Worker 1's Browser Agent UI changes add isBrowserEnabled() and a
 * screenshot() passthrough to BrowserdManager; the real manager satisfies
 * this interface structurally. Tests pass a plain stub.
 */
export interface BrowserWalkthroughManager {
  isBrowserEnabled(): boolean;
  /** Current page screenshot; BrowserdManager may return PNG bytes or base64. */
  screenshot(): Promise<Buffer | string>;
}

const BROWSER_DISABLED_MESSAGE = 'browser is disabled (set sunday.browser.enabled to true)';

function toPngBytes(raw: Buffer | string): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  return Buffer.from(raw, 'base64');
}

interface WalkthroughStep {
  narration: string;
  screenshot: boolean;
}

interface WalkthroughArgs {
  title?: unknown;
  steps?: unknown;
  sessionId?: unknown;
}

function createWalkthroughTool(
  manager: BrowserWalkthroughManager,
  opts: { workspaceDir: string; sessionId?: string },
): Tool {
  const tool: Tool = {
    definition: {
      name: 'browser_walkthrough',
      description:
        'Produce a walkthrough artifact (markdown + screenshots) from the current browser session.',
      parameters: {
        type: 'object',
        required: ['title', 'steps'],
        properties: {
          title: { type: 'string', description: 'Walkthrough title, used as the markdown heading.' },
          steps: {
            type: 'array',
            description:
              'Narrated steps; each step with screenshot:true captures the current page as step-N.png.',
            items: {
              type: 'object',
              required: ['narration', 'screenshot'],
              properties: {
                narration: { type: 'string', description: 'What happened / what the user sees at this step.' },
                screenshot: { type: 'boolean', description: 'Capture a screenshot for this step.' },
              },
            },
          },
          sessionId: {
            type: 'string',
            description:
              'Artifact session id (defaults to browser-<yyyymmdd>-<hhmmss>); artifact lands in .sunday/artifacts/<sessionId>/.',
          },
        },
      },
      dangerous: true,
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      if (!manager.isBrowserEnabled()) return err(BROWSER_DISABLED_MESSAGE);

      const args = rawArgs as WalkthroughArgs;
      if (typeof args.title !== 'string' || args.title.trim().length === 0) {
        return err('browser_walkthrough: title must be a non-empty string');
      }
      if (!Array.isArray(args.steps) || args.steps.length === 0) {
        return err('browser_walkthrough: steps must be a non-empty array');
      }
      const steps: WalkthroughStep[] = [];
      for (const [i, s] of (args.steps as unknown[]).entries()) {
        if (!s || typeof s !== 'object' || typeof (s as { narration?: unknown }).narration !== 'string') {
          return err(`browser_walkthrough: steps[${i}].narration must be a string`);
        }
        steps.push({
          narration: (s as { narration: string }).narration,
          screenshot: (s as { screenshot?: unknown }).screenshot === true,
        });
      }

      const sessionId = typeof args.sessionId === 'string' ? args.sessionId : opts.sessionId;
      const mediaDir = resolveSessionMediaDir(opts.workspaceDir, sessionId);
      const sessionDir = dirname(mediaDir);

      const lines = [`# ${args.title}`, ''];
      let screenshots = 0;
      for (const [i, step] of steps.entries()) {
        const stepNo = i + 1;
        lines.push(`## Step ${stepNo}`, '');
        lines.push(step.narration, '');
        if (step.screenshot) {
          let png: Buffer;
          try {
            png = toPngBytes(await manager.screenshot());
          } catch (e) {
            return err(
              `browser_walkthrough: screenshot for step ${stepNo} failed: ${(e as Error)?.message ?? String(e)}`,
            );
          }
          const saved = savePng(png, mediaDir, `step-${stepNo}`);
          lines.push(`![step ${stepNo}](media/${basename(saved)})`, '');
          screenshots++;
        }
      }
      const md = lines.join('\n').replace(/\n+$/, '\n');
      const path = writeTextFile(sessionDir, 'walkthrough.md', md);
      return {
        output: `walkthrough written to ${path} (${steps.length} steps, ${screenshots} screenshots)`,
        metadata: { path, steps: steps.length, screenshots },
      };
    },
  };
  return tool;
}

export const BROWSER_WALKTHROUGH_TOOL_NAME = 'browser_walkthrough';

/**
 * Register the browser_walkthrough tool on a registry. The host (cli/daemon
 * wiring) calls this alongside registerBrowserTools when the browser is
 * opted in.
 */
export function registerBrowserWalkthroughTools(
  registry: ToolRegistry,
  manager: BrowserdManager,
  opts: { workspaceDir: string; sessionId?: string },
): void {
  registry.register(createWalkthroughTool(manager as unknown as BrowserWalkthroughManager, opts));
}
