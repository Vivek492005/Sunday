import { z } from 'zod';

/** JSON-RPC 2.0 envelope schemas + builders. Transport is NDJSON over stdio
 *  (one JSON object per line); framing lives in sundayd / sunday-agent. */

export const jsonRpcIdSchema = z.union([z.string().min(1), z.number().int()]);
export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;

const envelopeSchema = z.object({ jsonrpc: z.literal('2.0') });

export const jsonRpcRequestSchema = envelopeSchema.extend({
  id: jsonRpcIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;

export const jsonRpcNotificationSchema = envelopeSchema.extend({
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type JsonRpcNotification = z.infer<typeof jsonRpcNotificationSchema>;

export const jsonRpcErrorObjectSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JsonRpcErrorObject = z.infer<typeof jsonRpcErrorObjectSchema>;

const responseBaseSchema = envelopeSchema.extend({
  id: jsonRpcIdSchema,
  result: z.unknown().optional(),
  error: jsonRpcErrorObjectSchema.optional(),
});

// A Response MUST carry exactly one of result / error (JSON-RPC 2.0 §5).
// Note: `z.unknown()` accepts a missing key (missing ≡ undefined), so key
// presence is enforced explicitly with `in` — exact over NDJSON, where JSON
// has no undefined.
export const jsonRpcResponseSchema = responseBaseSchema.superRefine((o, ctx) => {
  const raw = o as Record<string, unknown>;
  const hasResult = 'result' in raw;
  const hasError = 'error' in raw;
  if (hasResult === hasError) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'JSON-RPC response must contain exactly one of "result" or "error"',
    });
  }
});
export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>;

/** Standard JSON-RPC codes plus Sunday application codes (-32000…-32099). */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // Sunday application errors
  PolicyDenied: -32000, // §9.6 — tool call blocked by policy
  RateLimited: -32001, // §10.6 — visible rate limit; retry after data.retryAfterMs
  ModelUnavailable: -32002, // provider/model down or key missing
  SessionNotFound: -32003,
  TurnCancelled: -32004,
  RunNotFound: -32005, // Parallel Agents phase: orchestrate/status|merge|resolveConflict on an unknown runId
  ProtocolMismatch: -32010, // sunday/hello version negotiation failed
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Parse one inbound NDJSON line into a validated envelope. */
export function parseMessage(
  line: string,
):
  | { kind: 'request'; message: JsonRpcRequest }
  | { kind: 'notification'; message: JsonRpcNotification }
  | { kind: 'response'; message: JsonRpcResponse }
  | { kind: 'invalid'; raw: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: 'invalid', raw: line };
  }
  const asRequest = jsonRpcRequestSchema.safeParse(parsed);
  if (asRequest.success) return { kind: 'request', message: asRequest.data };
  // A valid envelope carrying an `id` that failed request-parsing is malformed;
  // surface it as invalid instead of misclassifying it as a notification.
  const asNotification = jsonRpcNotificationSchema.safeParse(parsed);
  if (asNotification.success && !('id' in (parsed as Record<string, unknown>))) {
    return { kind: 'notification', message: asNotification.data };
  }
  const asResponse = jsonRpcResponseSchema.safeParse(parsed);
  if (asResponse.success) return { kind: 'response', message: asResponse.data };
  return { kind: 'invalid', raw: line };
}

export function createRequest(id: JsonRpcId, method: string, params?: unknown): JsonRpcRequest {
  return params === undefined
    ? { jsonrpc: '2.0', id, method }
    : { jsonrpc: '2.0', id, method, params };
}

export function createNotification(method: string, params?: unknown): JsonRpcNotification {
  return params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params };
}

export function successResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}
