import { resolveAnchor, type Anchor, type DocumentHandle } from '@collab/kernel';
import type { DocumentVersion, Message, Suggestion, Thread } from '@collab/review';
import type { AnchorResolutionDto, DocumentVersionDto, MessageDto, SuggestionDto, ThreadDto } from '@collab/protocol';

export function resolutionDto(document: DocumentHandle | undefined, anchor: Anchor): AnchorResolutionDto {
  if (!document) return { status: 'detached' };
  const resolved = resolveAnchor(document, anchor);
  return resolved.status === 'detached' ? { status: 'detached' } : { status: resolved.status, start: resolved.start, end: resolved.end };
}

/** A withdrawn message keeps its place in the thread but no longer carries its text. */
export function messageDto(message: Message): MessageDto {
  const withdrawn = message.status === 'withdrawn';
  return {
    id: message.id,
    threadId: message.threadId,
    authorId: message.authorId,
    body: withdrawn ? '' : message.body,
    mentions: withdrawn ? [] : message.mentions,
    createdAt: message.createdAt,
    status: withdrawn ? 'withdrawn' : 'visible',
    ...(message.withdrawnAt === undefined ? {} : { withdrawnAt: message.withdrawnAt }),
    ...(message.withdrawnBy === undefined ? {} : { withdrawnBy: message.withdrawnBy }),
  };
}

export function suggestionDto(suggestion: Suggestion, document: DocumentHandle | undefined): SuggestionDto {
  return {
    id: suggestion.id,
    docId: suggestion.docId,
    ...(suggestion.threadId === undefined ? {} : { threadId: suggestion.threadId }),
    ...(suggestion.batchId === undefined ? {} : { batchId: suggestion.batchId }),
    authorId: suggestion.authorId,
    ...(suggestion.authorKind === undefined ? {} : { authorKind: suggestion.authorKind }),
    quote: suggestion.anchor.quote,
    newText: suggestion.newText,
    ...(suggestion.rationale === undefined ? {} : { rationale: suggestion.rationale }),
    status: suggestion.status,
    ...(suggestion.decidedBy === undefined ? {} : { decidedBy: suggestion.decidedBy }),
    ...(suggestion.decidedAt === undefined ? {} : { decidedAt: suggestion.decidedAt }),
    createdAt: suggestion.createdAt,
    ...(suggestion.withdrawnAt === undefined ? {} : { withdrawnAt: suggestion.withdrawnAt }),
    resolved: resolutionDto(document, suggestion.anchor),
  };
}

export function threadDto(thread: Thread, messages: Message[], suggestions: Suggestion[], readAt: number | undefined, document: DocumentHandle | undefined): ThreadDto {
  const activity = [...messages.map((message) => message.createdAt), ...suggestions.map((suggestion) => suggestion.decidedAt ?? suggestion.createdAt)];
  const latestActivityAt = Math.max(thread.createdAt, ...activity);
  return {
    id: thread.id,
    docId: thread.docId,
    kind: thread.kind,
    ...(thread.agentId === undefined ? {} : { agentId: thread.agentId }),
    status: thread.status,
    createdBy: thread.createdBy,
    createdAt: thread.createdAt,
    scope: thread.scope.type === 'document'
      ? { type: 'document' }
      : { type: 'range', quote: thread.scope.anchor.quote, resolved: resolutionDto(document, thread.scope.anchor) },
    messages: messages.map(messageDto),
    latestActivityAt,
    unread: activity.length > 0 && (readAt === undefined || latestActivityAt > readAt),
  };
}

export function versionDto(version: DocumentVersion): DocumentVersionDto {
  return {
    id: version.id,
    docId: version.docId,
    suggestionId: version.suggestionId,
    kind: version.kind ?? 'suggestion',
    ...(version.phase === undefined ? {} : { phase: version.phase }),
    ...(version.sourceVersionId === undefined ? {} : { sourceVersionId: version.sourceVersionId }),
    ...(version.threadId === undefined ? {} : { threadId: version.threadId }),
    text: version.text,
    createdBy: version.createdBy,
    createdAt: version.createdAt,
  };
}
