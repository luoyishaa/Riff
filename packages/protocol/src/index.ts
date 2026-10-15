import { z } from 'zod';

export const principalSchema = z.object({
  id: z.string(),
  kind: z.enum(['human', 'agent']),
  displayName: z.string(),
  ownerId: z.string().optional(),
});
export const documentSchema = z.object({ id: z.string(), title: z.string(), text: z.string() });
export const threadScopeSchema = z.union([
  z.object({ type: z.literal('range'), start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }),
  z.object({ type: z.literal('document') }),
]);
export const createThreadSchema = z.object({
  kind: z.enum(['discussion', 'task']).default('discussion'),
  agentId: z.string().optional(),
  scope: threadScopeSchema.default({ type: 'document' }),
});
export const createMessageSchema = z.object({ body: z.string().min(1).max(20000) });
export const createSuggestionSchema = z.object({
  threadId: z.string().optional(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  newText: z.string(),
  rationale: z.string().max(1000).optional(),
});
const adapterConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mock') }).strict(),
  z.object({
    type: z.literal('openai-compatible'),
    baseUrl: z.string().url(),
    apiKeyEnv: z.string().min(1),
    model: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal('cli'),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    timeoutMs: z.number().int().positive().max(300_000).optional(),
  }).strict(),
]);
/** Agent settings accepted by the document agent configuration endpoint. */
export const agentConfigSchema = z.object({
  principalId: z.string().min(1).optional(),
  adapter: adapterConfigSchema,
  grantedRole: z.enum(['viewer', 'commenter', 'suggester', 'editor', 'owner']),
  contextStrategy: z.enum(['selection', 'window', 'full']),
}).strict();
export type PrincipalDto = z.infer<typeof principalSchema>;
export type DocumentDto = z.infer<typeof documentSchema>;
export type CreateThreadInput = z.infer<typeof createThreadSchema>;
export type CreateMessageInput = z.infer<typeof createMessageSchema>;
export type CreateSuggestionInput = z.infer<typeof createSuggestionSchema>;
export type AgentConfigInput = z.infer<typeof agentConfigSchema>;
