import { z } from 'zod';

/** Message content parts. The discriminated union keeps the wire format
 *  extensible: new part types add a `type` literal here. */
export const textPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});
export type TextPart = z.infer<typeof textPartSchema>;

/**
 * Image content part.
 *
 * Shape: `{ type: 'image', dataUrl }` where `dataUrl` is a fully-prefixed
 * data: URL, e.g. `data:image/jpeg;base64,/9j/…`. The single-field shape is
 * deliberate: the mime type and the base64 payload travel together, so a
 * part can never end up with a mime that disagrees with its payload (the
 * `{ data, mimeType }` two-field alternative invites exactly that bug).
 * Keep individual images modest — the webview downscales pasted images to
 * ~1568px max dimension (JPEG q0.85) before they reach the wire.
 */
export const imagePartSchema = z.object({
  type: z.literal('image'),
  dataUrl: z.string().min(1),
});
export type ImagePart = z.infer<typeof imagePartSchema>;

export const contentPartSchema = z.discriminatedUnion('type', [
  textPartSchema,
  imagePartSchema,
]);
export type ContentPart = z.infer<typeof contentPartSchema>;
