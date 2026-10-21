import type { AccessPolicy, CollaboratorRole, ContextStrategy, ModelProviderId, Role } from './requests.js';

/** Response bodies shared by the server and the web client. */

export interface ApiErrorBody { error: { code: string; message: string } }

export interface PrincipalDto {
  id: string;
  kind: 'human' | 'agent';
  displayName: string;
  ownerId?: string;
  handle?: string;
  email?: string;
}
export interface MemberDto extends PrincipalDto { role: Role }

export interface SessionDto { principalId: string; transport: 'cookie' | 'legacy-header'; expiresAt?: number }
export interface AuthResponse { principal: PrincipalDto; session: SessionDto }
export type SessionStateResponse =
  | { authenticated: true; principal: PrincipalDto; session: SessionDto }
  | { authenticated: false; principal: null; session: null };

export type WorkspaceSource = 'managed' | 'local' | 'imported';
export type DocumentKind = 'text' | 'markdown';
export interface DocumentSummaryDto { id: string; title: string; workspaceId?: string; relativePath?: string; kind: DocumentKind }
export interface WorkspaceDto {
  id: string;
  title: string;
  createdBy: string;
  createdAt: number;
  source: WorkspaceSource;
  /** Only the owner sees the bound server path. */
  rootPath?: string;
  role: Role;
  documents: DocumentSummaryDto[];
}
export type LocalProjectFileStatus = 'imported' | 'synced' | 'updated' | 'conflict' | 'missing';
export interface LocalProjectFileDto { documentId: string; title: string; relativePath: string; size: number; mtimeMs: number; status: LocalProjectFileStatus }
export interface LocalProjectStatusDto { workspaceId: string; source: WorkspaceSource; path?: string; files: LocalProjectFileDto[] }
export interface WorkspaceDetailDto extends WorkspaceDto { members: MemberDto[]; localProject: LocalProjectStatusDto }

export interface OutlineEntryDto { index: number; title: string; start: number; end: number; level?: number }
export interface DocumentDto extends DocumentSummaryDto {
  text: string;
  role: Role;
  outline: OutlineEntryDto[];
  members: MemberDto[];
}

export type AnchorResolutionDto =
  | { status: 'exact' | 'relocated'; start: number; end: number }
  | { status: 'detached' };
export type ThreadScopeDto =
  | { type: 'document' }
  | { type: 'range'; quote: string; resolved: AnchorResolutionDto };
export interface MessageDto {
  id: string;
  threadId: string;
  authorId: string;
  /** Empty once the author withdraws the message. */
  body: string;
  mentions: string[];
  createdAt: number;
  status: 'visible' | 'withdrawn';
  withdrawnAt?: number;
  withdrawnBy?: string;
}
export interface ThreadDto {
  id: string;
  docId: string;
  kind: 'discussion' | 'task';
  agentId?: string;
  status: 'open' | 'resolved';
  createdBy: string;
  createdAt: number;
  scope: ThreadScopeDto;
  messages: MessageDto[];
  /** Latest message or suggestion activity, for ordering. */
  latestActivityAt: number;
  unread: boolean;
}
export type SuggestionStatus = 'pending' | 'accepted' | 'rejected' | 'stale';
export interface SuggestionDto {
  id: string;
  docId: string;
  threadId?: string;
  batchId?: string;
  authorId: string;
  authorKind?: 'human' | 'agent';
  quote: string;
  newText: string;
  rationale?: string;
  status: SuggestionStatus;
  decidedBy?: string;
  decidedAt?: number;
  createdAt: number;
  withdrawnAt?: number;
  resolved: AnchorResolutionDto;
}
export interface BatchItemDecisionDto { suggestionId: string; status: SuggestionStatus; error?: string }
export interface DocumentVersionDto {
  id: string;
  docId: string;
  suggestionId: string;
  kind: 'suggestion' | 'restore';
  phase?: 'before' | 'after';
  sourceVersionId?: string;
  threadId?: string;
  text: string;
  createdBy: string;
  createdAt: number;
}

export type AgentFailureKind = 'permission' | 'timeout' | 'authentication' | 'rate-limit' | 'network' | 'invalid-output' | 'provider' | 'unknown';
export type AgentState = 'working' | 'idle' | 'failed';
export interface AgentSummaryDto {
  id: string;
  displayName: string;
  ownerId?: string;
  adapter: 'mock' | 'openai-compatible' | 'cli';
  /** The model provider this agent is bound to, when it uses one. */
  providerId?: ModelProviderId;
  model?: string;
  contextStrategy: ContextStrategy;
  grantedRole: Role;
  accessPolicy: AccessPolicy;
  state: AgentState;
  /** Threads the agent is currently working on. */
  workingThreadIds: string[];
  error?: string;
  errorKind?: AgentFailureKind;
  /** Whether the viewer may change this agent's configuration. */
  canManage: boolean;
  /** The connection lives only in the running server process. */
  sessionOnly: boolean;
}
export interface CreatedAgentResponse { agent: AgentSummaryDto }

export type ModelProviderState = 'connected' | 'not-connected' | 'unavailable' | 'error';
export interface ModelProviderDto {
  id: ModelProviderId;
  displayName: string;
  kind: 'cli' | 'api-key';
  description: string;
  state: ModelProviderState;
  detail: string;
  baseUrl?: string;
  /** Only the custom endpoint lets the user choose a base URL. */
  baseUrlEditable: boolean;
  defaultModel?: string;
  modelPlaceholder?: string;
  version?: string;
  models?: Array<{ slug: string; displayName: string }>;
}

export interface InvitationDto {
  id: string;
  workspaceId: string;
  workspace?: { id: string; title: string };
  principalId: string;
  invitee?: PrincipalDto;
  invitedBy: string;
  inviter?: PrincipalDto;
  role: CollaboratorRole;
  status: 'pending' | 'accepted' | 'rejected' | 'revoked';
  createdAt: number;
  respondedAt?: number;
}

export interface AccountDto {
  principal: PrincipalDto;
  workspaces: Array<{ id: string; title: string; role: Role }>;
  pendingInvitationCount: number;
}
