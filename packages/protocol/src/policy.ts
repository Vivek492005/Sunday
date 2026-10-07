import { z } from 'zod';

/**
 * S3: per-boot token required on sensitive RPCs. The daemon generates a
 * random token at boot; the spawning extension passes it via the
 * SUNDAY_DAEMON_BOOT_TOKEN env var and includes it in these params.
 * Any other local process on the socket without the token is rejected.
 */
export const bootTokenParam = {
  /** Per-boot daemon token (see SUNDAY_DAEMON_BOOT_TOKEN). */
  bootToken: z.string().min(1).optional(),
};

/** Policy approval surface (Part A, risk class M). Dangerous tools
 *  (`dangerous: true` in their ToolDefinition — MCP tools, `remember`) are
 *  denied by the PolicyGate until explicitly approved; these methods let the
 *  extension approve/revoke per session and list the current posture. */
export const POLICY_METHODS = {
  'policy/approve': {
    params: z.object({ tool: z.string().min(1), ...bootTokenParam }),
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
