// @sunday/protocol — versioned JSON-RPC surface between sunday-agent and sundayd.
// Every method the sidecar speaks is registered here with zod params/result
// schemas, so both ends validate the same shapes (§23).
import { z } from 'zod';

export { PROTOCOL_VERSION, PROTOCOL_NAME } from './version.js';
export * from './jsonrpc.js';
export * from './content.js';
export * from './handshake.js';
export * from './session.js';
export * from './chat.js';
export * from './completion.js';
export * from './tools.js';
export * from './models.js';
export * from './context.js';
export * from './manager.js';
export * from './browser.js';
export * from './browser-panel.js';
export * from './orchestrate.js';
export * from './mcp.js';
export * from './policy.js';
export * from './daemon-paths.js';

import { HANDSHAKE_METHODS } from './handshake.js';
import { SESSION_METHODS } from './session.js';
import { CHAT_METHODS, CHAT_NOTIFICATIONS } from './chat.js';
import { COMPLETION_METHODS } from './completion.js';
import { TOOLS_METHODS } from './tools.js';
import { MODELS_METHODS } from './models.js';
import { CONTEXT_METHODS } from './context.js';
import { MANAGER_METHODS } from './manager.js';
import { BROWSER_METHODS } from './browser.js';
import { BROWSER_PANEL_METHODS } from './browser-panel.js';
import { ORCHESTRATE_METHODS, ORCHESTRATE_NOTIFICATIONS } from './orchestrate.js';
import { MCP_METHODS } from './mcp.js';
import { POLICY_METHODS } from './policy.js';

export const METHODS = {
  ...HANDSHAKE_METHODS,
  ...SESSION_METHODS,
  ...CHAT_METHODS,
  ...COMPLETION_METHODS,
  ...TOOLS_METHODS,
  ...MODELS_METHODS,
  ...CONTEXT_METHODS,
  ...MANAGER_METHODS,
  ...BROWSER_METHODS,
  ...BROWSER_PANEL_METHODS,
  ...ORCHESTRATE_METHODS,
  ...MCP_METHODS,
  ...POLICY_METHODS,
} as const;
export type MethodName = keyof typeof METHODS;
export type MethodParams<M extends MethodName> = z.infer<(typeof METHODS)[M]['params']>;
export type MethodResult<M extends MethodName> = z.infer<(typeof METHODS)[M]['result']>;

export const NOTIFICATIONS = { ...CHAT_NOTIFICATIONS, ...ORCHESTRATE_NOTIFICATIONS } as const;
export type NotificationName = keyof typeof NOTIFICATIONS;

/** Validate inbound params for a known method (throws ZodError on mismatch). */
export function parseParams<M extends MethodName>(method: M, params: unknown): MethodParams<M> {
  const def = METHODS[method];
  if (!def) throw new Error(`unknown method: ${String(method)}`);
  return def.params.parse(params) as MethodParams<M>;
}
