import type { Anchor, PrincipalKind, Role } from '@collab/kernel';

export type ThreadScope =
  | { type: 'range'; anchor: Anchor }
  | { type: 'document' };

export type ThreadKind = 'discussion' | 'task';
export type ThreadStatus = 'open' | 'resolved';

export interface Thread {
  id: string;
  docId: string;
  scope: ThreadScope;
  kind: ThreadKind;
  agentId?: string;
  status: ThreadStatus;
  createdBy: string;
  createdAt: number;
}

export interface Message {
  id: string;
  threadId: string;
  authorId: string;
  body: string;
  mentions: string[];
  createdAt: number;
  /** Withdrawn messages remain in the thread so the conversation history stays stable. */
  status?: 'visible' | 'withdrawn';
  withdrawnAt?: number;
  withdrawnBy?: string;
}

export type SuggestionStatus = 'pending' | 'accepted' | 'rejected' | 'stale';

export interface Suggestion {
  id: string;
  docId: string;
  threadId?: string;
  batchId?: string;
  authorId: string;
  /** Optional because callers may only know the principal id at this boundary. */
  authorKind?: PrincipalKind;
  anchor: Anchor;
  newText: string;
  rationale?: string;
  status: SuggestionStatus;
  decidedBy?: string;
  decidedAt?: number;
  createdAt: number;
  /** A pending suggestion can be withdrawn by its author before review. */
  withdrawnAt?: number;
  withdrawnBy?: string;
}

export interface Batch {
  id: string;
  threadId: string;
  createdBy: string;
  createdAt: number;
}

/**
 * Immutable text captured immediately before an accepted suggestion changes a
 * document. The snapshot is tied to the suggestion so a reviewer can return
 * the document to the state that preceded that change.
 */
export interface DocumentVersion {
  id: string;
  docId: string;
  suggestionId: string;
  threadId?: string;
  text: string;
  createdBy: string;
  createdAt: number;
}

export interface BatchProgress {
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
  stale: number;
}

export interface BatchItemDecision {
  suggestionId: string;
  status: SuggestionStatus;
  error?: ReviewError;
}

export interface ApprovalRuleMatch {
  authorKind?: PrincipalKind;
  authorId?: string;
  maxChangedChars?: number;
}

export type ApprovalAction = 'auto-accept' | 'require-approval';

export interface ApprovalRule {
  match: ApprovalRuleMatch;
  action: ApprovalAction;
}

export interface ApprovalPolicy {
  docId: string;
  rules: ApprovalRule[];
}

export type ApprovalDecision = 'auto-accept' | 'require-approval';

export type ReviewEvent =
  | { type: 'thread.created'; thread: Thread }
  | { type: 'thread.resolved'; thread: Thread }
  | { type: 'message.created'; message: Message }
  | { type: 'message.updated'; message: Message }
  | { type: 'suggestion.created'; suggestion: Suggestion }
  | { type: 'suggestion.updated'; suggestion: Suggestion }
  | { type: 'batch.created'; batch: Batch };

export type ReviewError =
  | 'thread-not-found'
  | 'message-not-found'
  | 'suggestion-not-found'
  | 'batch-not-found'
  | 'document-not-found'
  | 'permission-denied'
  | 'thread-resolved'
  | 'invalid-state'
  | 'stale-anchor'
  | 'detached-anchor'
  | 'range-out-of-bounds'
  | 'version-not-found'
  | 'structure-loss';

export interface CreateThreadInput {
  docId: string;
  scope: ThreadScope;
  kind: ThreadKind;
  agentId?: string;
  createdBy: string;
  createdByRole?: Role;
}

export interface AddMessageInput {
  threadId: string;
  authorId: string;
  body: string;
  mentions?: string[];
  authorRole?: Role;
}

export interface CreateSuggestionInput {
  docId: string;
  threadId?: string;
  batchId?: string;
  authorId: string;
  authorKind?: PrincipalKind;
  anchor: Anchor;
  newText: string;
  rationale?: string;
  authorEffectiveRole?: Role;
}

export interface UpdateSuggestionInput {
  suggestionId: string;
  newText: string;
  editorId: string;
  editorRole: Role;
}
