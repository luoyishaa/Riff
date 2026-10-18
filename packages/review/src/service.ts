import {
  can,
  createAnchor,
  err,
  minRole,
  resolveAnchor,
  type Clock,
  type DocumentHandle,
  type IdGenerator,
  type Principal,
  type Result,
  type Role,
} from '@collab/kernel';
import { approvalDecision } from './policy.js';
import { decideBatchRemaining, getBatchProgress } from './batch.js';
import type { ReviewRepository } from './repository.js';
import type {
  AddMessageInput,
  ApprovalPolicy,
  Batch,
  BatchItemDecision,
  BatchProgress,
  CreateSuggestionInput,
  DocumentVersion,
  UpdateSuggestionInput,
  CreateThreadInput,
  Message,
  ReviewError,
  ReviewEvent,
  Suggestion,
  Thread,
} from './types.js';

export interface DocumentProvider {
  getDocument(docId: string): DocumentHandle | undefined;
}

export interface ReviewServiceOptions {
  clock: Clock;
  ids: IdGenerator;
  repository: ReviewRepository;
  documents: DocumentProvider;
  emit?: (event: ReviewEvent) => void;
}

export interface SuggestionDecision {
  suggestion: Suggestion;
  resolution: 'exact' | 'relocated' | 'detached';
}

function transact<T>(repository: ReviewRepository, work: () => T): T {
  return repository.transaction ? repository.transaction(work) : work();
}

function notify(options: ReviewServiceOptions, event: ReviewEvent): void {
  options.emit?.(event);
}

function withRole(role: Role | undefined, action: Parameters<typeof can>[1]): Result<void, ReviewError> {
  return role === undefined || can(role, action) ? { ok: true, value: undefined } : err('permission-denied');
}

/** Compute an agent's role for one run from both role grants. */
export function effectiveRole(grantedRole: Role, triggerRole: Role): Role {
  return minRole(grantedRole, triggerRole);
}

export class ReviewService {
  private readonly subscriptions = new Map<string, () => void>();
  private readonly mutedDocuments = new Set<string>();

  constructor(private readonly options: ReviewServiceOptions) {}

  createThread(input: CreateThreadInput): Result<Thread, ReviewError> {
    const permission = withRole(input.createdByRole, 'comment');
    if (!permission.ok) return permission;
    if (!this.options.documents.getDocument(input.docId)) return err('document-not-found');
    const thread: Thread = {
      id: this.options.ids.next(),
      docId: input.docId,
      scope: input.scope,
      kind: input.kind,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      status: 'open',
      createdBy: input.createdBy,
      createdAt: this.options.clock.now(),
    };
    this.options.repository.saveThread(thread);
    notify(this.options, { type: 'thread.created', thread });
    return { ok: true, value: thread };
  }

  resolveThread(threadId: string, actorRole?: Role): Result<Thread, ReviewError> {
    const permission = withRole(actorRole, 'comment');
    if (!permission.ok) return permission;
    const thread = this.options.repository.getThread(threadId);
    if (!thread) return err('thread-not-found');
    if (thread.status === 'resolved') return err('invalid-state');
    const resolved: Thread = { ...thread, status: 'resolved' };
    this.options.repository.saveThread(resolved);
    notify(this.options, { type: 'thread.resolved', thread: resolved });
    return { ok: true, value: resolved };
  }

  addMessage(input: AddMessageInput): Result<Message, ReviewError> {
    const permission = withRole(input.authorRole, 'comment');
    if (!permission.ok) return permission;
    const thread = this.options.repository.getThread(input.threadId);
    if (!thread) return err('thread-not-found');
    if (thread.status === 'resolved') return err('thread-resolved');
    const message: Message = {
      id: this.options.ids.next(),
      threadId: input.threadId,
      authorId: input.authorId,
      body: input.body,
      mentions: input.mentions ? [...input.mentions] : [],
      createdAt: this.options.clock.now(),
      status: 'visible',
    };
    this.options.repository.saveMessage(message);
    notify(this.options, { type: 'message.created', message });
    return { ok: true, value: message };
  }

  withdrawMessage(messageId: string, actorId: string, actorRole: Role): Result<Message, ReviewError> {
    const permission = withRole(actorRole, 'comment');
    if (!permission.ok) return permission;
    const message = this.options.repository.getMessage(messageId);
    if (!message) return err('message-not-found');
    if (message.authorId !== actorId) return err('permission-denied');
    if (message.status === 'withdrawn') return err('invalid-state');
    const withdrawn: Message = { ...message, status: 'withdrawn', withdrawnAt: this.options.clock.now(), withdrawnBy: actorId };
    this.options.repository.saveMessage(withdrawn);
    notify(this.options, { type: 'message.updated', message: withdrawn });
    return { ok: true, value: withdrawn };
  }

  createBatch(threadId: string, createdBy: string): Result<Batch, ReviewError> {
    const thread = this.options.repository.getThread(threadId);
    if (!thread) return err('thread-not-found');
    if (thread.status === 'resolved') return err('thread-resolved');
    const batch: Batch = {
      id: this.options.ids.next(),
      threadId,
      createdBy,
      createdAt: this.options.clock.now(),
    };
    this.options.repository.saveBatch(batch);
    notify(this.options, { type: 'batch.created', batch });
    return { ok: true, value: batch };
  }

  getBatchProgress(batchId: string): Result<BatchProgress, ReviewError> {
    return getBatchProgress(this.options.repository, batchId);
  }

  acceptBatchRemaining(batchId: string, deciderId: string, deciderRole: Role): Result<BatchItemDecision[], ReviewError> {
    return decideBatchRemaining(this.batchHost(), batchId, deciderId, deciderRole, 'accept');
  }

  rejectBatchRemaining(batchId: string, deciderId: string, deciderRole: Role): Result<BatchItemDecision[], ReviewError> {
    return decideBatchRemaining(this.batchHost(), batchId, deciderId, deciderRole, 'reject');
  }

  /** List immutable pre-acceptance snapshots for a document, oldest first. */
  listDocumentVersions(docId: string, viewerRole?: Role): Result<DocumentVersion[], ReviewError> {
    const permission = withRole(viewerRole, 'view');
    if (!permission.ok) return permission;
    if (!this.options.documents.getDocument(docId)) return err('document-not-found');
    return { ok: true, value: this.options.repository.listDocumentVersions(docId) };
  }

  /** Restore a document to the text captured before an accepted suggestion. */
  restoreDocumentVersion(versionId: string, actorId: string, actorRole: Role): Result<DocumentVersion, ReviewError> {
    if (!can(actorRole, 'edit')) return err('permission-denied');
    const version = this.options.repository.getDocumentVersion(versionId);
    if (!version) return err('version-not-found');
    const document = this.options.documents.getDocument(version.docId);
    if (!document) return err('document-not-found');
    const applied = document.replace(0, document.getText().length, version.text, { principalId: actorId, versionId });
    if (!applied.ok) return err('range-out-of-bounds');
    return { ok: true, value: version };
  }

  private batchHost() {
    return {
      repository: this.options.repository,
      acceptSuggestion: this.acceptSuggestion.bind(this),
      rejectSuggestion: this.rejectSuggestion.bind(this),
    };
  }

  createSuggestion(
    input: CreateSuggestionInput,
    policy?: ApprovalPolicy,
    author?: Principal,
  ): Result<SuggestionDecision, ReviewError> {
    const permission = withRole(input.authorEffectiveRole, 'suggest');
    if (!permission.ok) return permission;
    const document = this.options.documents.getDocument(input.docId);
    if (!document) return err('document-not-found');
    if (input.threadId !== undefined) {
      const thread = this.options.repository.getThread(input.threadId);
      if (!thread) return err('thread-not-found');
      if (thread.docId !== input.docId) return err('document-not-found');
      if (thread.status === 'resolved') return err('thread-resolved');
    }
    if (input.batchId !== undefined) {
      const batch = this.options.repository.getBatch(input.batchId);
      if (!batch) return err('batch-not-found');
      const batchThread = this.options.repository.getThread(batch.threadId);
      if (!batchThread || batchThread.docId !== input.docId) return err('document-not-found');
    }
    const suggestion: Suggestion = {
      id: this.options.ids.next(),
      docId: input.docId,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      ...(input.batchId === undefined ? {} : { batchId: input.batchId }),
      authorId: input.authorId,
      ...(input.authorKind === undefined ? {} : { authorKind: input.authorKind }),
      anchor: input.anchor,
      newText: input.newText,
      ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
      status: 'pending',
      createdAt: this.options.clock.now(),
    };
    this.options.repository.saveSuggestion(suggestion);
    notify(this.options, { type: 'suggestion.created', suggestion });

    const role = input.authorEffectiveRole ?? 'viewer';
    if (approvalDecision(policy, suggestion, role, author) === 'auto-accept') {
      const accepted = this.acceptSuggestion(input.docId, suggestion.id, input.authorId, role);
      if (accepted.ok) return accepted;
      if (accepted.error === 'stale-anchor') {
        const stale = this.options.repository.getSuggestion(suggestion.id);
        if (stale) return { ok: true, value: { suggestion: stale, resolution: 'detached' } };
      }
      return accepted;
    }
    return { ok: true, value: { suggestion, resolution: 'exact' } };
  }

  acceptSuggestion(
    docId: string,
    suggestionId: string,
    deciderId: string,
    deciderRole: Role,
  ): Result<SuggestionDecision, ReviewError> {
    if (!can(deciderRole, 'approve')) return err('permission-denied');
    const suggestion = this.options.repository.getSuggestion(suggestionId);
    if (!suggestion) return err('suggestion-not-found');
    if (suggestion.docId !== docId) return err('document-not-found');
    if (suggestion.status !== 'pending' || suggestion.withdrawnAt !== undefined) return err('invalid-state');
    const document = this.options.documents.getDocument(docId);
    if (!document) return err('document-not-found');
    const resolution = resolveAnchor(document, suggestion.anchor);
    if (resolution.status !== 'exact') {
      const stale: Suggestion = {
        ...suggestion,
        status: 'stale',
        decidedBy: deciderId,
        decidedAt: this.options.clock.now(),
      };
      this.options.repository.saveSuggestion(stale);
      notify(this.options, { type: 'suggestion.updated', suggestion: stale });
      return err('stale-anchor');
    }
    const accepted: Suggestion = {
      ...suggestion,
      status: 'accepted',
      decidedBy: deciderId,
      decidedAt: this.options.clock.now(),
    };
    // Capture overlap before applying the edit. Relative positions can still
    // resolve exactly after a replacement that happens to preserve the other
    // quote, but overlapping suggestions must nevertheless become stale.
    const overlapping = this.options.repository.listSuggestions(docId)
      .filter((candidate) => candidate.status === 'pending' && candidate.id !== suggestionId)
      .filter((candidate) => {
        const candidateResolution = resolveAnchor(document, candidate.anchor);
        return candidateResolution.status === 'exact'
          && candidateResolution.start < resolution.end
          && resolution.start < candidateResolution.end;
      });
    const origin = { principalId: deciderId, suggestionId };
    const snapshot: DocumentVersion = {
      id: this.options.ids.next(),
      docId,
      suggestionId,
      ...(suggestion.threadId === undefined ? {} : { threadId: suggestion.threadId }),
      text: document.getText(),
      createdBy: deciderId,
      createdAt: this.options.clock.now(),
    };
    this.mutedDocuments.add(docId);
    let applied: Result<void, 'range-out-of-bounds'>;
    try {
      applied = transact(this.options.repository, () => {
        this.options.repository.saveDocumentVersion(snapshot);
        const result = document.replace(resolution.start, resolution.end, suggestion.newText, origin);
        if (!result.ok) return result;
        this.options.repository.saveSuggestion(accepted);
        for (const candidate of overlapping) {
          const stale: Suggestion = {
            ...candidate,
            status: 'stale',
            decidedAt: this.options.clock.now(),
          };
          this.options.repository.saveSuggestion(stale);
          notify(this.options, { type: 'suggestion.updated', suggestion: stale });
        }
        return result;
      });
    } finally {
      this.mutedDocuments.delete(docId);
    }
    if (!applied.ok) return err('range-out-of-bounds');
    notify(this.options, { type: 'suggestion.updated', suggestion: accepted });
    this.refreshPending(docId);
    return { ok: true, value: { suggestion: accepted, resolution: 'exact' } };
  }

  updateSuggestion(input: UpdateSuggestionInput): Result<Suggestion, ReviewError> {
    if (!can(input.editorRole, 'approve')) return err('permission-denied');
    const suggestion = this.options.repository.getSuggestion(input.suggestionId);
    if (!suggestion) return err('suggestion-not-found');
    if (suggestion.status !== 'pending' || suggestion.withdrawnAt !== undefined) return err('invalid-state');
    const updated: Suggestion = { ...suggestion, newText: input.newText };
    this.options.repository.saveSuggestion(updated);
    notify(this.options, { type: 'suggestion.updated', suggestion: updated });
    return { ok: true, value: updated };
  }

  rejectSuggestion(
    suggestionId: string,
    deciderId: string,
    deciderRole: Role,
  ): Result<Suggestion, ReviewError> {
    if (!can(deciderRole, 'approve')) return err('permission-denied');
    const suggestion = this.options.repository.getSuggestion(suggestionId);
    if (!suggestion) return err('suggestion-not-found');
    if (suggestion.status !== 'pending' || suggestion.withdrawnAt !== undefined) return err('invalid-state');
    const rejected: Suggestion = {
      ...suggestion,
      status: 'rejected',
      decidedBy: deciderId,
      decidedAt: this.options.clock.now(),
    };
    this.options.repository.saveSuggestion(rejected);
    notify(this.options, { type: 'suggestion.updated', suggestion: rejected });
    return { ok: true, value: rejected };
  }

  withdrawSuggestion(suggestionId: string, actorId: string, actorRole: Role): Result<Suggestion, ReviewError> {
    // Withdrawing an existing suggestion is a cleanup action, so a member who
    // can participate in the thread may retract their own pending suggestion
    // even if their suggestion privilege was later reduced.
    const permission = withRole(actorRole, 'comment');
    if (!permission.ok) return permission;
    const suggestion = this.options.repository.getSuggestion(suggestionId);
    if (!suggestion) return err('suggestion-not-found');
    if (suggestion.authorId !== actorId) return err('permission-denied');
    if (suggestion.status !== 'pending' || suggestion.withdrawnAt !== undefined) return err('invalid-state');
    const withdrawn: Suggestion = { ...suggestion, withdrawnAt: this.options.clock.now(), withdrawnBy: actorId };
    this.options.repository.saveSuggestion(withdrawn);
    notify(this.options, { type: 'suggestion.updated', suggestion: withdrawn });
    return { ok: true, value: withdrawn };
  }

  /** Mark pending suggestions whose anchors no longer resolve exactly as stale. */
  refreshPending(docId: string): Suggestion[] {
    const document = this.options.documents.getDocument(docId);
    if (!document) return [];
    const stale: Suggestion[] = [];
    for (const suggestion of this.options.repository.listSuggestions(docId)) {
      if (suggestion.status !== 'pending' || suggestion.withdrawnAt !== undefined) continue;
      if (resolveAnchor(document, suggestion.anchor).status === 'exact') continue;
      const updated: Suggestion = { ...suggestion, status: 'stale', decidedAt: this.options.clock.now() };
      this.options.repository.saveSuggestion(updated);
      notify(this.options, { type: 'suggestion.updated', suggestion: updated });
      stale.push(updated);
    }
    return stale;
  }

  /** Subscribe to document edits so pending anchors are rechecked after each update. */
  watchDocument(docId: string): Result<() => void, ReviewError> {
    const document = this.options.documents.getDocument(docId);
    if (!document) return err('document-not-found');
    this.subscriptions.get(docId)?.();
    const unsubscribe = document.subscribe(() => {
      if (this.mutedDocuments.has(docId)) return;
      this.refreshPending(docId);
    });
    this.subscriptions.set(docId, unsubscribe);
    return { ok: true, value: () => { unsubscribe(); this.subscriptions.delete(docId); } };
  }

  /** Utility for creating a range anchor through the injected document handle. */
  createAnchor(docId: string, start: number, end: number): Result<ReturnType<typeof createAnchor>, ReviewError> {
    const document = this.options.documents.getDocument(docId);
    if (!document) return err('document-not-found');
    try {
      return { ok: true, value: createAnchor(document, start, end) };
    } catch {
      return err('range-out-of-bounds');
    }
  }

  /** Effective agent permission is the lower of the configured and triggering roles. */
  static effectiveRole(grantedRole: Role, triggerRole: Role): Role {
    return effectiveRole(grantedRole, triggerRole);
  }
}
