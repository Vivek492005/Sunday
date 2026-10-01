import { z } from 'zod';

/** Model catalogue surface (§10). Adapters register here; the router picks. */

export const modelInfoSchema = z.object({
  id: z.string().min(1), // e.g. "openrouter:meta-llama/llama-3.3-70b-instruct"
  provider: z.string().min(1), // "openrouter" | "groq"
  label: z.string().min(1),
  contextWindow: z.number().int().positive(),
  supportsTools: z.boolean(),
});
export type ModelInfo = z.infer<typeof modelInfoSchema>;

export const MODELS_METHODS = {
  'models/list': {
    params: z.object({}),
    result: z.object({ models: z.array(modelInfoSchema) }),
  },
} as const;
