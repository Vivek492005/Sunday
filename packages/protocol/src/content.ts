import { z } from 'zod';

/** Message content parts. More part types (image, file) arrive in later phases;
 *  the discriminated union keeps the wire format extensible. */
export const textPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});
export type TextPart = z.infer<typeof textPartSchema>;

export const contentPartSchema = z.discriminatedUnion('type', [textPartSchema]);
export type ContentPart = z.infer<typeof contentPartSchema>;
