import { z } from 'zod';

/**
 * `scheduler/*` — Group A, A5: scheduled tasks.
 *
 * The IDE manages cron schedules (`scheduler/create|update|delete|list`);
 * sundayd fires due schedules on its 60s loop and reports via
 * `scheduler/status` (+ `scheduler/event` notifications). Run records
 * live under ~/.sunday/schedules/runs/<name>/.
 */

export const scheduleDefSchema = z.object({
  name: z.string().min(1).max(64),
  cron: z.string().min(1),
  prompt: z.string().min(1),
  enabled: z.boolean(),
});
export type ScheduleDef = z.infer<typeof scheduleDefSchema>;

export const scheduleStatusSchema = scheduleDefSchema.extend({
  lastRunAt: z.string().optional(),
  lastStatus: z.string().optional(),
});

export const scheduleRunSchema = z.object({
  name: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  status: z.enum(['completed', 'failed', 'skipped-overlap']),
  result: z.string().optional(),
  error: z.string().optional(),
});

/** Method registry for `scheduler/*` — same shape as the other `*_METHODS`. */
export const SCHEDULER_METHODS = {
  'scheduler/list': {
    params: z.object({}),
    result: z.object({ schedules: z.array(scheduleStatusSchema) }),
  },
  'scheduler/create': {
    params: z.object({
      name: z.string().min(1).max(64),
      cron: z.string().min(1),
      prompt: z.string().min(1).max(8000),
    }),
    result: z.object({ schedule: scheduleDefSchema }),
  },
  'scheduler/update': {
    params: z.object({
      name: z.string().min(1).max(64),
      enabled: z.boolean().optional(),
      cron: z.string().min(1).optional(),
      prompt: z.string().min(1).max(8000).optional(),
    }),
    result: z.object({ schedule: scheduleDefSchema }),
  },
  'scheduler/delete': {
    params: z.object({ name: z.string().min(1).max(64) }),
    result: z.object({ deleted: z.literal(true) }),
  },
  'scheduler/status': {
    params: z.object({}),
    result: z.object({
      schedules: z.array(scheduleStatusSchema),
      running: z.array(z.string()),
    }),
  },
  'scheduler/run-now': {
    params: z.object({ name: z.string().min(1).max(64) }),
    result: z.object({ run: scheduleRunSchema }),
  },
} as const;
export type SchedulerMethodName = keyof typeof SCHEDULER_METHODS;
