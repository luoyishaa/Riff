import { z } from 'zod';

export const roleSchema = z.enum(['viewer', 'commenter', 'suggester', 'editor', 'owner']);
/** Roles a member can be invited with or an agent can be granted; ownership is never handed out. */
export const collaboratorRoleSchema = roleSchema.exclude(['owner']);
export const contextStrategySchema = z.enum(['selection', 'window', 'full']);
export const accessPolicySchema = z.enum(['public', 'private']);
export const modelProviderIdSchema = z.enum(['codex-cli', 'claude-code', 'openrouter', 'deepseek', 'openai-api', 'openai-compatible']);

const handleSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const emailSchema = z.string().trim().email().max(320);

/** Credentials for a database-backed human account. */
export const registerPrincipalSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  handle: handleSchema,
  email: emailSchema.optional(),
  password: z.string().min(8).max(200),
}).strict();
/** Profile edits never accept credentials. */
export const updateAccountSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  handle: handleSchema.optional(),
  email: emailSchema.optional(),
}).strict();
export const authLoginSchema = z.object({
  identifier: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(200),
}).strict();

export const createWorkspaceSchema = z.object({ title: z.string().trim().min(1).max(120) }).strict();
export const updateWorkspaceSchema = z.object({ title: z.string().trim().min(1).max(120) }).strict();
/** Destructive workspace deletion requires an exact title confirmation. */
export const deleteWorkspaceSchema = z.object({ confirmTitle: z.string().trim().min(1).max(120) }).strict();
export const updateMemberRoleSchema = z.object({ role: roleSchema }).strict();
/** The invitee is named by account handle or email; the invitation stays pending until accepted. */
export const workspaceInvitationSchema = z.object({
  identifier: z.string().trim().min(1).max(320),
  role: collaboratorRoleSchema,
}).strict();

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
  z.object({
    type: z.literal('range'),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    /** The selected text; lets the server find it again if edits shifted the offsets. */
    quote: z.string().min(1).max(200000).optional(),
  }),
  z.object({ type: z.literal('document') }),
]);
export const createThreadSchema = z.object({
  kind: z.enum(['discussion', 'task']).default('discussion'),
  agentId: z.string().optional(),
  scope: threadScopeSchema.default({ type: 'document' }),
  /** Optional first message, posted in the same request so the thread is never empty. */
  body: z.string().min(1).max(20000).optional(),
}).strict();
export const createMessageSchema = z.object({ body: z.string().min(1).max(20000) }).strict();
export const createSuggestionSchema = z.object({
  threadId: z.string().optional(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  newText: z.string().max(200000),
  rationale: z.string().max(1000).optional(),
}).strict();
export const updateSuggestionSchema = z.object({ newText: z.string().max(200000) }).strict();

/** Partial update of how an agent participates; its connection is changed via bind-provider. */
export const agentPolicySchema = z.object({
  grantedRole: collaboratorRoleSchema.optional(),
  contextStrategy: contextStrategySchema.optional(),
  accessPolicy: accessPolicySchema.optional(),
  /** Model id for API-key connections. */
  model: z.string().trim().min(1).max(200).optional(),
}).strict();
export const createAgentSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  grantedRole: collaboratorRoleSchema,
  contextStrategy: contextStrategySchema.default('window'),
  accessPolicy: accessPolicySchema.default('public'),
  /** Bind a connected model provider right away; without it the agent uses the mock adapter. */
  providerId: modelProviderIdSchema.optional(),
  model: z.string().trim().min(1).max(200).optional(),
}).strict();

/**
 * A process-local provider connection. API keys are accepted only at this
 * boundary and are never part of a persisted agent configuration or response.
 */
export const modelProviderConnectSchema = z.object({
  apiKey: z.string().min(1).max(10000),
  model: z.string().trim().min(1).max(200),
  baseUrl: z.string().url().optional(),
}).strict();
export const modelProviderBindingSchema = z.object({
  providerId: modelProviderIdSchema,
  model: z.string().trim().min(1).max(200).optional(),
  grantedRole: collaboratorRoleSchema.optional(),
  contextStrategy: contextStrategySchema.optional(),
  accessPolicy: accessPolicySchema.optional(),
}).strict();

export type Role = z.infer<typeof roleSchema>;
export type CollaboratorRole = z.infer<typeof collaboratorRoleSchema>;
export type ContextStrategy = z.infer<typeof contextStrategySchema>;
export type AccessPolicy = z.infer<typeof accessPolicySchema>;
export type ModelProviderId = z.infer<typeof modelProviderIdSchema>;
export type RegisterPrincipalInput = z.infer<typeof registerPrincipalSchema>;
export type LocalProjectFileInput = z.infer<typeof localProjectFileSchema>;
export type LocalProjectBindInput = z.infer<typeof localProjectBindSchema>;
export type CreateThreadInput = z.input<typeof createThreadSchema>;
export type CreateSuggestionInput = z.infer<typeof createSuggestionSchema>;
