import { z } from 'zod';

export const principalSchema = z.object({
  id: z.string(),
  kind: z.enum(['human', 'agent']),
  displayName: z.string(),
  ownerId: z.string().optional(),
  /** Stable account handle used for lookup and workspace invitations. */
  handle: z.string().min(1).max(80).optional(),
  /** Optional unverified directory email; it is not a login credential. */
  email: z.string().email().max(320).optional(),
});
/** Credentials for a database-backed human account. */
export const registerPrincipalSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  handle: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
  email: z.string().trim().email().max(320).optional(),
  password: z.string().min(8).max(200),
}).strict();
/** Profile edits never accept credentials. */
export const updateAccountSchema = registerPrincipalSchema.omit({ password: true, handle: true }).extend({
  handle: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u).optional(),
});
export const authLoginSchema = z.object({
  identifier: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(200),
}).strict();
export const switchAccountSchema = z.object({ principalId: z.string().min(1) }).strict();
export const documentSchema = z.object({ id: z.string(), title: z.string(), text: z.string(), workspaceId: z.string().optional() });
/** Immutable text captured immediately before a suggestion was accepted. */
export const documentVersionSchema = z.object({
  id: z.string(),
  docId: z.string(),
  suggestionId: z.string(),
  kind: z.enum(['suggestion', 'restore']).optional(),
  phase: z.enum(['before', 'after']).optional(),
  sourceVersionId: z.string().optional(),
  threadId: z.string().optional(),
  text: z.string(),
  createdBy: z.string(),
  createdAt: z.number().int(),
}).strict();
export const createWorkspaceSchema = z.object({ title: z.string().trim().min(1).max(120) }).strict();
/** Editable workspace metadata. Only the title is mutable in this milestone. */
export const updateWorkspaceSchema = z.object({ title: z.string().trim().min(1).max(120) }).strict();
/** Destructive workspace deletion requires an exact title confirmation. */
export const deleteWorkspaceSchema = z.object({ confirmTitle: z.string().trim().min(1).max(120) }).strict();
export const workspaceMemberSchema = z.object({ principalId: z.string().min(1), role: z.enum(['viewer', 'commenter', 'suggester', 'editor', 'owner']) }).strict();
/** A pending invitation can grant any workspace role below owner. */
export const workspaceInvitationSchema = z.object({
  /** Stable account handle entered by the inviter. principalId is retained for old clients. */
  identifier: z.string().trim().min(1).max(120).optional(),
  principalId: z.string().min(1).optional(),
  role: z.enum(['viewer', 'commenter', 'suggester', 'editor']),
}).strict()
  .refine((value) => value.identifier !== undefined || value.principalId !== undefined, { message: 'An account identifier is required' })
  .refine((value) => value.identifier === undefined || value.principalId === undefined, { message: 'Use identifier instead of principalId' });
export const createDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  text: z.string().max(200000).default(''),
  workspaceId: z.string().min(1).optional(),
}).strict();
export const localProjectFileSchema = z.object({
  relativePath: z.string().min(1).max(1000),
  text: z.string().max(200000),
  size: z.number().int().nonnegative().optional(),
  mtimeMs: z.number().finite().nonnegative().optional(),
}).strict();
export const localProjectBindSchema = z.object({
  path: z.string().trim().min(1).optional(),
  files: z.array(localProjectFileSchema).max(1000).optional(),
}).strict().refine((value) => value.path !== undefined || value.files !== undefined, { message: 'Either path or files is required' });
export const localProjectSyncSchema = z.object({
  relativePath: z.string().min(1).max(1000).optional(),
  text: z.string().max(200000).optional(),
  mtimeMs: z.number().finite().nonnegative().optional(),
}).strict();
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
export const updateSuggestionSchema = z.object({ newText: z.string().max(200000) }).strict();
const adapterConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mock') }).strict(),
  z.object({
    type: z.literal('openai-compatible'),
    baseUrl: z.string().url(),
    apiKeyEnv: z.string().min(1),
    model: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal('openai-responses'),
    baseUrl: z.string().url(),
    accessTokenEnv: z.string().min(1),
    model: z.string().min(1),
    profileId: z.string().min(1).optional(),
    ownerPrincipalId: z.string().min(1).optional(),
  }).strict(),
  z.object({
    type: z.literal('cli'),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    timeoutMs: z.number().int().positive().max(300_000).optional(),
    includeSystemInPrompt: z.boolean().optional(),
  }).strict(),
]);
/** Agent settings accepted by the document agent configuration endpoint. */
export const agentConfigSchema = z.object({
  principalId: z.string().min(1).optional(),
  adapter: adapterConfigSchema,
  grantedRole: z.enum(['viewer', 'commenter', 'suggester', 'editor', 'owner']),
  contextStrategy: z.enum(['selection', 'window', 'full']),
  accessPolicy: z.enum(['public', 'private']).default('public'),
}).strict();
/** Session-only connection for a document agent. API keys never enter the persisted config. */
export const agentProviderConnectSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('codex'),
    grantedRole: z.enum(['viewer', 'commenter', 'suggester', 'editor', 'owner']).optional(),
    contextStrategy: z.enum(['selection', 'window', 'full']).optional(),
    accessPolicy: z.enum(['public', 'private']).optional(),
  }).strict(),
  z.object({
    provider: z.literal('claude'),
    grantedRole: z.enum(['viewer', 'commenter', 'suggester', 'editor', 'owner']).optional(),
    contextStrategy: z.enum(['selection', 'window', 'full']).optional(),
    accessPolicy: z.enum(['public', 'private']).optional(),
  }).strict(),
  z.object({
    provider: z.literal('openai-compatible'),
    baseUrl: z.string().url(),
    model: z.string().min(1),
    apiKey: z.string().min(1).max(10000),
    grantedRole: z.enum(['viewer', 'commenter', 'suggester', 'editor', 'owner']).optional(),
    contextStrategy: z.enum(['selection', 'window', 'full']).optional(),
    accessPolicy: z.enum(['public', 'private']).optional(),
  }).strict(),
]);
/**
 * A process-local provider connection. API keys are accepted only at this
 * boundary and are never part of a persisted agent configuration or response.
 */
export const modelProviderConnectSchema = z.object({
  apiKey: z.string().min(1).max(10000),
  model: z.string().trim().min(1).max(200),
  baseUrl: z.string().url().optional(),
}).strict();
export const modelProviderIdSchema = z.enum(['codex-cli', 'claude-code', 'openrouter', 'deepseek', 'openai-api', 'openai-compatible']);
export const modelProviderBindingSchema = z.object({
  providerId: modelProviderIdSchema,
  model: z.string().trim().min(1).max(200).optional(),
  grantedRole: z.enum(['viewer', 'commenter', 'suggester', 'editor', 'owner']).optional(),
  contextStrategy: z.enum(['selection', 'window', 'full']).optional(),
  accessPolicy: z.enum(['public', 'private']).optional(),
}).strict();
export const createAgentSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  provider: z.enum(['mock', 'codex', 'claude', 'openai-compatible']),
  grantedRole: z.enum(['viewer', 'commenter', 'suggester', 'editor']),
  contextStrategy: z.enum(['selection', 'window', 'full']).default('window'),
  accessPolicy: z.enum(['public', 'private']).default('public'),
  baseUrl: z.string().url().optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1).max(10000).optional(),
}).strict();
export type PrincipalDto = z.infer<typeof principalSchema>;
export type RegisterPrincipalInput = z.infer<typeof registerPrincipalSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
export type AuthLoginInput = z.infer<typeof authLoginSchema>;
export type SwitchAccountInput = z.infer<typeof switchAccountSchema>;
export type DocumentDto = z.infer<typeof documentSchema>;
export type DocumentVersionDto = z.infer<typeof documentVersionSchema>;
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;
export type DeleteWorkspaceInput = z.infer<typeof deleteWorkspaceSchema>;
export type WorkspaceMemberInput = z.infer<typeof workspaceMemberSchema>;
export type WorkspaceInvitationInput = z.infer<typeof workspaceInvitationSchema>;
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
export type LocalProjectBindInput = z.infer<typeof localProjectBindSchema>;
export type LocalProjectSyncInput = z.infer<typeof localProjectSyncSchema>;
export type CreateThreadInput = z.infer<typeof createThreadSchema>;
export type CreateMessageInput = z.infer<typeof createMessageSchema>;
export type CreateSuggestionInput = z.infer<typeof createSuggestionSchema>;
export type UpdateSuggestionInput = z.infer<typeof updateSuggestionSchema>;
export type AgentConfigInput = z.infer<typeof agentConfigSchema>;
export type AgentProviderConnectInput = z.infer<typeof agentProviderConnectSchema>;
export type ModelProviderConnectInput = z.infer<typeof modelProviderConnectSchema>;
export type ModelProviderBindingInput = z.infer<typeof modelProviderBindingSchema>;
export type CreateAgentInput = z.infer<typeof createAgentSchema>;
