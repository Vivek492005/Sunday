import { z } from 'zod';
import { contentPartSchema } from './content.js';

/** Tool contract (§9.8). `parameters` is a JSON Schema object; implementations
 *  validate arguments against it before executing. */
export const toolDefinitionSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'tool name must be snake_case'),
  description: z.string().min(1),
  parameters: z.record(z.unknown()),
  dangerous: z.boolean().optional(), // needs explicit user approval (§9.6)
});
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;

export const toolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.unknown()),
});
export type ToolCall = z.infer<typeof toolCallSchema>;

export const toolResultSchema = z.object({
  toolCallId: z.string().min(1),
  content: z.array(contentPartSchema),
  isError: z.boolean().default(false),
});
export type ToolResult = z.infer<typeof toolResultSchema>;

export const TOOLS_METHODS = {
  'tools/list': {
    params: z.object({}),
    result: z.object({ tools: z.array(toolDefinitionSchema) }),
  },
} as const;
