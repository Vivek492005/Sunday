import { z } from 'zod';
import { contentPartSchema } from './content.js';
import { toolCallSchema, toolResultSchema } from './tools.js';

/** Chat turns (§9). `chat/send` is async: it returns a turnId immediately and
 *  progress streams back as `chat/event` notifications until `turn-end`. */

export const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.array(contentPartSchema).min(1),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof usageSchema>;

const textDeltaEvent = z.object({ type: z.literal('text-delta'), delta: z.string() });
const toolCallEvent = z.object({ type: z.literal('tool-call'), call: toolCallSchema });
const toolResultEvent = z.object({ type: z.literal('tool-result'), result: toolResultSchema });
const usageEvent = z.object({ type: z.literal('usage'), usage: usageSchema });
const turnEndEvent = z.object({
  type: z.literal('turn-end'),
  finishReason: z.enum(['stop', 'cancelled', 'error', 'max-steps']),
});
const turnErrorEvent = z.object({
  type: z.literal('turn-error'),
  code: z.number().int(),
  message: z.string(),
});

export const chatEventSchema = z.discriminatedUnion('type', [
  textDeltaEvent,
  toolCallEvent,
  toolResultEvent,
  usageEvent,
  turnEndEvent,
  turnErrorEvent,
]);
export type ChatEvent = z.infer<typeof chatEventSchema>;

export const chatEventNotificationSchema = z.object({
  turnId: z.string().min(1),
  sessionId: z.string().min(1),
  event: chatEventSchema,
});
export type ChatEventNotification = z.infer<typeof chatEventNotificationSchema>;

export const CHAT_METHODS = {
  'chat/send': {
    params: z.object({
      sessionId: z.string().min(1),
      message: z.union([z.string().min(1), z.array(contentPartSchema).min(1)]),
      model: z.string().optional(),
      effort: z.enum(['low', 'medium', 'high']).optional(), // orchestration depth (Phase 5)
    }),
    result: z.object({ turnId: z.string().min(1) }),
  },
  'chat/cancel': {
    params: z.object({ turnId: z.string().min(1) }),
    result: z.object({ ok: z.literal(true) }),
  },
} as const;

export const CHAT_NOTIFICATIONS = {
  'chat/event': { params: chatEventNotificationSchema },
} as const;
