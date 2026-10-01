import { z } from 'zod';

/** Sessions (§9.3). A session is a persistent conversation + working context;
 *  turns stream inside it via `chat/send` / `chat/event`. */

export const sessionSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  createdAt: z.string(), // ISO-8601
  updatedAt: z.string(), // ISO-8601
  cwd: z.string().optional(),
  model: z.string().optional(), // model id override for this session
});
export type Session = z.infer<typeof sessionSchema>;

export const SESSION_METHODS = {
  'session/create': {
    params: z.object({
      title: z.string().optional(),
      cwd: z.string().optional(),
      model: z.string().optional(),
    }),
    result: z.object({ session: sessionSchema }),
  },
  'session/list': {
    params: z.object({}),
    result: z.object({ sessions: z.array(sessionSchema) }),
  },
  'session/restore': {
    params: z.object({ sessionId: z.string().min(1) }),
    result: z.object({ session: sessionSchema }),
  },
  'session/close': {
    params: z.object({ sessionId: z.string().min(1) }),
    result: z.object({ ok: z.literal(true) }),
  },
} as const;
