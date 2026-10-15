import { describe, expect, it } from 'vitest';
import { YjsDocument, type Clock, type IdGenerator } from '@collab/kernel';
import { approvalDecision, MemoryReviewRepository, ReviewService, type ReviewEvent } from '../src/index.js';

class FixedClock implements Clock {
  constructor(private readonly value: number) {}
  now(): number { return this.value; }
}

class SequenceIds implements IdGenerator {
  private index = 0;
  next(): string { this.index += 1; return `id-${this.index}`; }
}

function setup(initialText = 'alpha beta gamma') {
  const doc = new YjsDocument('doc-1', initialText);
  const repository = new MemoryReviewRepository();
  const events: ReviewEvent[] = [];
  const service = new ReviewService({
    clock: new FixedClock(100),
    ids: new SequenceIds(),
    repository,
    documents: { getDocument: (docId) => docId === doc.id ? doc : undefined },
    emit: (event) => events.push(event),
  });
  return { doc, repository, service, events };
}

describe('review domain', () => {
  it('creates threads and messages with the shared commenter permission', () => {
    const { service } = setup();
    const thread = service.createThread({
      docId: 'doc-1', scope: { type: 'document' }, kind: 'discussion', createdBy: 'alice', createdByRole: 'commenter',
    });
    expect(thread.ok).toBe(true);
    if (!thread.ok) return;
    const message = service.addMessage({
      threadId: thread.value.id, authorId: 'alice', body: 'Please review this.', authorRole: 'commenter',
    });
    expect(message.ok).toBe(true);
    expect(service.createThread({
      docId: 'doc-1', scope: { type: 'document' }, kind: 'discussion', createdBy: 'viewer', createdByRole: 'viewer',
    }).error).toBe('permission-denied');
  });

  it('accepts a suggestion and preserves the origin metadata', () => {
    const { doc, service, repository } = setup();
    const anchor = service.createAnchor('doc-1', 6, 10);
    expect(anchor.ok).toBe(true);
    if (!anchor.ok) return;
    const suggestion = service.createSuggestion({
      docId: 'doc-1', authorId: 'carol', anchor: anchor.value, newText: 'BETA', authorEffectiveRole: 'suggester',
    });
    expect(suggestion.ok).toBe(true);
    if (!suggestion.ok) return;
    const accepted = service.acceptSuggestion('doc-1', suggestion.value.suggestion.id, 'alice', 'editor');
    expect(accepted.ok).toBe(true);
    expect(doc.getText()).toBe('alpha BETA gamma');
    expect(repository.getSuggestion(suggestion.value.suggestion.id)?.status).toBe('accepted');
  });

  it('marks a suggestion stale when a concurrent edit changes its quote', () => {
    const { doc, service, repository } = setup();
    const anchor = service.createAnchor('doc-1', 6, 10);
    expect(anchor.ok).toBe(true);
    if (!anchor.ok) return;
    const suggestion = service.createSuggestion({ docId: 'doc-1', authorId: 'carol', anchor: anchor.value, newText: 'BETA' });
    expect(suggestion.ok).toBe(true);
    if (!suggestion.ok) return;
    doc.replace(6, 10, 'delta');
    service.refreshPending('doc-1');
    expect(repository.getSuggestion(suggestion.value.suggestion.id)?.status).toBe('stale');
    expect(service.acceptSuggestion('doc-1', suggestion.value.suggestion.id, 'alice', 'editor').error).toBe('invalid-state');
  });

  it('invalidates an overlapping pending suggestion after acceptance', () => {
    const { service, repository } = setup('abcdef');
    const first = service.createAnchor('doc-1', 0, 3);
    const second = service.createAnchor('doc-1', 2, 5);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const a = service.createSuggestion({ docId: 'doc-1', authorId: 'carol', anchor: first.value, newText: 'X' });
    const b = service.createSuggestion({ docId: 'doc-1', authorId: 'carol', anchor: second.value, newText: 'Y' });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(service.acceptSuggestion('doc-1', a.value.suggestion.id, 'alice', 'editor').ok).toBe(true);
    expect(repository.getSuggestion(b.value.suggestion.id)?.status).toBe('stale');
  });

  it('invalidates overlap even when the replacement leaves the other quote intact', () => {
    const { service, repository } = setup('abcdef');
    const first = service.createAnchor('doc-1', 0, 2);
    const second = service.createAnchor('doc-1', 1, 3);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const a = service.createSuggestion({ docId: 'doc-1', authorId: 'carol', anchor: first.value, newText: 'ab' });
    const b = service.createSuggestion({ docId: 'doc-1', authorId: 'carol', anchor: second.value, newText: 'Z' });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(service.acceptSuggestion('doc-1', a.value.suggestion.id, 'alice', 'editor').ok).toBe(true);
    expect(repository.getSuggestion(b.value.suggestion.id)?.status).toBe('stale');
  });

  it('derives batch progress from its suggestion states', () => {
    const { service } = setup();
    const thread = service.createThread({ docId: 'doc-1', scope: { type: 'document' }, kind: 'task', createdBy: 'alice' });
    expect(thread.ok).toBe(true);
    if (!thread.ok) return;
    const batch = service.createBatch(thread.value.id, 'alice');
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    const anchor = service.createAnchor('doc-1', 0, 5);
    expect(anchor.ok).toBe(true);
    if (!anchor.ok) return;
    const suggestion = service.createSuggestion({ docId: 'doc-1', threadId: thread.value.id, batchId: batch.value.id, authorId: 'carol', anchor: anchor.value, newText: 'ALPHA' });
    expect(suggestion.ok).toBe(true);
    expect(service.getBatchProgress(batch.value.id)).toEqual({ ok: true, value: { total: 1, pending: 1, accepted: 0, rejected: 0, stale: 0 } });
  });

  it('processes remaining batch suggestions in order and reports stale overlap', () => {
    const { service } = setup('abcdef');
    const thread = service.createThread({ docId: 'doc-1', scope: { type: 'document' }, kind: 'task', createdBy: 'alice' });
    expect(thread.ok).toBe(true);
    if (!thread.ok) return;
    const batch = service.createBatch(thread.value.id, 'alice');
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    const first = service.createAnchor('doc-1', 0, 3);
    const second = service.createAnchor('doc-1', 2, 5);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const a = service.createSuggestion({ docId: 'doc-1', threadId: thread.value.id, batchId: batch.value.id, authorId: 'carol', anchor: first.value, newText: 'X' });
    const b = service.createSuggestion({ docId: 'doc-1', threadId: thread.value.id, batchId: batch.value.id, authorId: 'carol', anchor: second.value, newText: 'Y' });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const result = service.acceptBatchRemaining(batch.value.id, 'alice', 'editor');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((item) => item.status)).toEqual(['accepted', 'stale']);
    expect(result.value[1]?.error).toBe('stale-anchor');
  });
});

describe('approval policies', () => {
  it('requires editor effective role for auto-accept', () => {
    const suggestion = {
      id: 's', docId: 'd', authorId: 'agent', authorKind: 'agent' as const,
      anchor: { start: { type: '', tname: 'content', item: null, assoc: 0 }, end: { type: '', tname: 'content', item: null, assoc: -1 }, quote: 'A' },
      newText: 'B', status: 'pending' as const, createdAt: 1,
    };
    const policy = { docId: 'd', rules: [{ match: { authorKind: 'agent' as const }, action: 'auto-accept' as const }] };
    expect(approvalDecision(policy, suggestion, 'suggester')).toBe('require-approval');
    expect(approvalDecision(policy, suggestion, 'editor')).toBe('auto-accept');
  });
});
