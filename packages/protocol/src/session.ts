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
  'session/delete': {
    params: z.object({ sessionId: z.string().min(1) }),
    result: z.object({ ok: z.literal(true), deleted: z.boolean() }),
  },
  // F6 Durable Sessions: rewind, branch, export, checkpoints.
  'session/rewind': {
    params: z.object({ sessionId: z.string().min(1), entryId: z.string().min(1) }),
    result: z.object({
      session: sessionSchema,
      rewoundTo: z.string(),
      droppedEntries: z.number(),
      codeRestored: z.boolean(),
    }),
  },
  'session/branch': {
    params: z.object({
      sessionId: z.string().min(1),
      entryId: z.string().min(1).optional(),
      title: z.string().optional(),
    }),
    result: z.object({ session: sessionSchema, parentSessionId: z.string() }),
  },
  'session/export': {
    params: z.object({
      sessionId: z.string().min(1),
      format: z.enum(['jsonl', 'markdown']),
    }),
    result: z.object({ sessionId: z.string(), format: z.string(), content: z.string() }),
  },
  'session/checkpoint': {
    params: z.object({ sessionId: z.string().min(1), label: z.string().optional() }),
    result: z.object({ checkpointId: z.string(), entryId: z.string() }),
  },
  'session/log': {
    params: z.object({ sessionId: z.string().min(1) }),
    result: z.object({
      sessionId: z.string(),
      entries: z.array(
        z.object({
          seq: z.number(),
          id: z.string(),
          ts: z.string(),
          type: z.string(),
          payload: z.record(z.string(), z.unknown()),
        }),
      ),
    }),
  },
  // F6: settings snapshots & rollback.
  'settings/snapshot': {
    params: z.object({ reason: z.string().optional() }),
    result: z.object({
      snapshot: z
        .object({
          id: z.string(),
          createdAt: z.string(),
          reason: z.string(),
          bytes: z.number(),
        })
        .nullable(),
    }),
  },
  'settings/snapshots': {
    params: z.object({}),
    result: z.object({
      snapshots: z.array(
        z.object({
          id: z.string(),
          createdAt: z.string(),
          reason: z.string(),
          bytes: z.number(),
        }),
      ),
    }),
  },
  'settings/restore': {
    params: z.object({ id: z.string().min(1) }),
    result: z.object({ ok: z.literal(true), backupId: z.string() }),
  },
} as const;
