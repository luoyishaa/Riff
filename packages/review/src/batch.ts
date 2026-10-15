import { can, err, type Result, type Role } from '@collab/kernel';
import type { ReviewRepository } from './repository.js';
import type { BatchItemDecision, BatchProgress, ReviewError, SuggestionStatus } from './types.js';

export interface BatchDecisionHost {
  readonly repository: ReviewRepository;
  acceptSuggestion(docId: string, suggestionId: string, deciderId: string, deciderRole: Role): Result<unknown, ReviewError>;
  rejectSuggestion(suggestionId: string, deciderId: string, deciderRole: Role): Result<{ status: SuggestionStatus }, ReviewError>;
}

export function getBatchProgress(repository: ReviewRepository, batchId: string): Result<BatchProgress, ReviewError> {
  const batch = repository.getBatch(batchId);
  if (!batch) return err('batch-not-found');
  const docId = repository.getThread(batch.threadId)?.docId ?? '';
  const suggestions = repository.listSuggestions(docId).filter((suggestion) => suggestion.batchId === batchId);
  const count = (status: SuggestionStatus): number => suggestions.filter((suggestion) => suggestion.status === status).length;
  return { ok: true, value: { total: suggestions.length, pending: count('pending'), accepted: count('accepted'), rejected: count('rejected'), stale: count('stale') } };
}

export function decideBatchRemaining(
  host: BatchDecisionHost,
  batchId: string,
  deciderId: string,
  deciderRole: Role,
  action: 'accept' | 'reject',
): Result<BatchItemDecision[], ReviewError> {
  if (!can(deciderRole, 'approve')) return err('permission-denied');
  const batch = host.repository.getBatch(batchId);
  if (!batch) return err('batch-not-found');
  const thread = host.repository.getThread(batch.threadId);
  if (!thread) return err('thread-not-found');
  const items: BatchItemDecision[] = [];
  for (const suggestion of host.repository.listSuggestions(thread.docId).filter((item) => item.batchId === batchId)) {
    const current = host.repository.getSuggestion(suggestion.id) ?? suggestion;
    if (current.status !== 'pending') {
      items.push({ suggestionId: current.id, status: current.status, ...(current.status === 'stale' ? { error: 'stale-anchor' } : {}) });
      continue;
    }
    if (action === 'reject') {
      const result = host.rejectSuggestion(current.id, deciderId, deciderRole);
      if (result.ok) items.push({ suggestionId: current.id, status: result.value.status });
      continue;
    }
    const result = host.acceptSuggestion(thread.docId, current.id, deciderId, deciderRole);
    const updated = host.repository.getSuggestion(current.id);
    if (updated) items.push({ suggestionId: current.id, status: updated.status, ...(result.ok ? {} : { error: result.error }) });
  }
  return { ok: true, value: items };
}
