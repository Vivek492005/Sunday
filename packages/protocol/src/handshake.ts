import { z } from 'zod';

/** sunday/hello — version negotiation (§23). The client proposes the protocol
 *  version it speaks; the server answers with the version it will use and
 *  whether the client's proposal was accepted. */

export const helloParamsSchema = z.object({
  protocolVersion: z.number().int().positive(),
  client: z.object({
    name: z.string().min(1), // e.g. "sunday-agent"
    version: z.string().min(1),
    os: z.string().min(1), // process.platform, e.g. "win32"
  }),
});
export type HelloParams = z.infer<typeof helloParamsSchema>;

export const helloResultSchema = z.object({
  protocolVersion: z.number().int().positive(),
  negotiated: z.boolean(), // false when the client asked for a version we don't speak
  server: z.object({
    name: z.literal('sundayd'),
    version: z.string().min(1),
  }),
});
export type HelloResult = z.infer<typeof helloResultSchema>;

export const HANDSHAKE_METHODS = {
  'sunday/hello': { params: helloParamsSchema, result: helloResultSchema },
  'sunday/ping': {
    params: z.object({}),
    result: z.object({ ok: z.literal(true), time: z.string() }),
  },
  'sunday/shutdown': {
    params: z.object({}),
    result: z.object({ ok: z.literal(true) }),
  },
} as const;
