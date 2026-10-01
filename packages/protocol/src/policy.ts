import { z } from 'zod';

/** Policy approval surface (Part A, risk class M). Dangerous tools
 *  (`dangerous: true` in their ToolDefinition — MCP tools, `remember`) are
 *  denied by the PolicyGate until explicitly approved; these methods let the
 *  extension approve/revoke per session and list the current posture. */
export const POLICY_METHODS = {
  'policy/approve': {
    params: z.object({ tool: z.string().min(1) }),
    result: z.object({ ok: z.literal(true) }),
  },
  'policy/revoke': {
    params: z.object({ tool: z.string().min(1) }),
    result: z.object({ ok: z.literal(true) }),
  },
  'policy/list': {
    params: z.object({}),
    result: z.object({
      dangerous: z.array(z.string()),
      approved: z.array(z.string()),
    }),
  },
} as const;
export type PolicyMethodName = keyof typeof POLICY_METHODS;
