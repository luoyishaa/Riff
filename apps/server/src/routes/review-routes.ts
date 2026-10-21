import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Action } from '@collab/kernel';
import type { Suggestion, ThreadScope } from '@collab/review';
import { createMessageSchema, createSuggestionSchema, createThreadSchema, updateSuggestionSchema } from '@collab/protocol';
import { documentAccess, type Access, type ServerContext } from '../context.js';
import { messageDto, suggestionDto, threadDto } from '../dto.js';
import { fail, parseBody, sendReviewError } from '../http.js';
import { resolveMentions } from '../mentions.js';

type IdParams = { Params: { id: string } };

/**
 * Offsets come from the client's copy of the text, which may be a few edits
 * behind or ahead. With the quote we can confirm them, or find the quote again
 * when it occurs exactly once; otherwise the selection is reported as changed.
 */
export function locateSelection(text: string, selection: { start: number; end: number; quote?: string | undefined }): { start: number; end: number } | undefined {
  const { start, end, quote } = selection;
  if (quote === undefined) return { start, end };
  if (text.slice(start, end) === quote) return { start, end };
  const first = text.indexOf(quote);
  if (first < 0 || text.indexOf(quote, first + 1) >= 0) return undefined;
  return { start: first, end: first + quote.length };
}

export function registerReviewRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { store, reviewStore, reviewService } = ctx;
  const handleOf = (docId: string) => store.get(docId)?.handle;

  /** Access check for a record that belongs to a document through its id. */
  const accessVia = (request: FastifyRequest, reply: FastifyReply, docId: string | undefined, kind: string, action: Action): Access | undefined => {
    if (docId === undefined) { void fail(reply, 404, `${kind}-not-found`, `The ${kind} was not found`); return undefined; }
    return documentAccess(ctx, request, reply, docId, action);
  };
  const threadDoc = (threadId: string) => reviewStore.getThread(threadId)?.docId;
  const suggestionDoc = (suggestionId: string) => reviewStore.getSuggestion(suggestionId)?.docId;

  const postMessage = (threadId: string, docId: string, access: Access, body: string) => reviewService.addMessage({
    threadId,
    authorId: access.principalId,
    body,
    mentions: resolveMentions(body, ctx.visibleMembers(docId, access.principalId)),
    authorRole: access.role,
  });

  app.get<IdParams>('/api/docs/:id/threads', async (request, reply) => {
    const access = documentAccess(ctx, request, reply, request.params.id, 'view');
    if (!access) return reply;
    const document = handleOf(request.params.id);
    const byThread = new Map<string, Suggestion[]>();
    for (const suggestion of reviewStore.listSuggestions(request.params.id)) {
      if (suggestion.threadId !== undefined) byThread.set(suggestion.threadId, [...(byThread.get(suggestion.threadId) ?? []), suggestion]);
    }
    return reviewStore.listThreads(request.params.id).map((thread) => threadDto(
      thread,
      reviewStore.listMessages(thread.id),
      byThread.get(thread.id) ?? [],
      reviewStore.getThreadReadAt(thread.id, access.principalId),
      document,
    ));
  });

  app.post<IdParams>('/api/docs/:id/threads', async (request, reply) => {
    const access = documentAccess(ctx, request, reply, request.params.id, 'comment');
    if (!access) return reply;
    const input = parseBody(createThreadSchema, request.body, reply);
    if (!input) return reply;
    if (input.agentId !== undefined && (store.role(request.params.id, input.agentId) === null || !ctx.agents.isVisible(request.params.id, input.agentId, access.principalId))) {
      return fail(reply, 400, 'invalid-agent', 'The assigned agent is not available to you');
    }
    let scope: ThreadScope;
    if (input.scope.type === 'range') {
      const located = locateSelection(handleOf(request.params.id)?.getText() ?? '', input.scope);
      if (!located) return fail(reply, 409, 'selection-changed', 'The selected text changed before the comment was saved');
      const anchor = reviewService.createAnchor(request.params.id, located.start, located.end);
      if (!anchor.ok) return sendReviewError(reply, anchor.error, 'The selection is outside the document');
      scope = { type: 'range', anchor: anchor.value };
    } else {
      scope = { type: 'document' };
    }
    const created = reviewService.createThread({
      docId: request.params.id,
      scope,
      kind: input.kind,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      createdBy: access.principalId,
      createdByRole: access.role,
    });
    if (!created.ok) return sendReviewError(reply, created.error, 'The thread could not be created');
    const message = input.body === undefined ? undefined : postMessage(created.value.id, request.params.id, access, input.body);
    if (message && !message.ok) return sendReviewError(reply, message.error, 'The first message could not be posted');
    reviewStore.saveThreadReadAt(created.value.id, access.principalId, ctx.now());
    return threadDto(created.value, message?.ok ? [message.value] : [], [], ctx.now(), handleOf(request.params.id));
  });

  app.post<IdParams>('/api/threads/:id/messages', async (request, reply) => {
    const docId = threadDoc(request.params.id);
    const access = accessVia(request, reply, docId, 'thread', 'comment');
    if (!access || docId === undefined) return reply;
    const input = parseBody(createMessageSchema, request.body, reply);
    if (!input) return reply;
    const result = postMessage(request.params.id, docId, access, input.body);
    if (!result.ok) return sendReviewError(reply, result.error, 'The message could not be posted');
    reviewStore.saveThreadReadAt(request.params.id, access.principalId, ctx.now());
    return messageDto(result.value);
  });

  app.post<IdParams>('/api/threads/:id/read', async (request, reply) => {
    const access = accessVia(request, reply, threadDoc(request.params.id), 'thread', 'view');
    if (!access) return reply;
    const readAt = ctx.now();
    reviewStore.saveThreadReadAt(request.params.id, access.principalId, readAt);
    return { ok: true, threadId: request.params.id, readAt };
  });

  app.post<IdParams>('/api/threads/:id/resolve', async (request, reply) => {
    const access = accessVia(request, reply, threadDoc(request.params.id), 'thread', 'comment');
    if (!access) return reply;
    const result = reviewService.resolveThread(request.params.id, access.role);
    return result.ok ? { ok: true, threadId: result.value.id } : sendReviewError(reply, result.error, 'The thread could not be resolved');
  });

  app.post<IdParams>('/api/messages/:id/withdraw', async (request, reply) => {
    const message = reviewStore.getMessage(request.params.id);
    const access = accessVia(request, reply, message === undefined ? undefined : threadDoc(message.threadId), 'message', 'view');
    if (!access) return reply;
    const result = reviewService.withdrawMessage(request.params.id, access.principalId, access.role);
    return result.ok ? messageDto(result.value) : sendReviewError(reply, result.error, 'The message could not be withdrawn');
  });

  app.get<IdParams>('/api/docs/:id/suggestions', async (request, reply) => {
    if (!documentAccess(ctx, request, reply, request.params.id, 'view')) return reply;
    const document = handleOf(request.params.id);
    return reviewStore.listSuggestions(request.params.id).map((suggestion) => suggestionDto(suggestion, document));
  });

  app.post<IdParams>('/api/docs/:id/suggestions', async (request, reply) => {
    const access = documentAccess(ctx, request, reply, request.params.id, 'suggest');
    if (!access) return reply;
    const input = parseBody(createSuggestionSchema, request.body, reply);
    if (!input) return reply;
    const anchor = reviewService.createAnchor(request.params.id, input.start, input.end);
    if (!anchor.ok) return sendReviewError(reply, anchor.error, 'The selection is outside the document');
    const author = store.principal(access.principalId);
    const result = reviewService.createSuggestion({
      docId: request.params.id,
      authorId: access.principalId,
      ...(author === undefined ? {} : { authorKind: author.kind }),
      anchor: anchor.value,
      newText: input.newText,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
      authorEffectiveRole: access.role,
    }, undefined, author);
    return result.ok ? suggestionDto(result.value.suggestion, handleOf(request.params.id)) : sendReviewError(reply, result.error, 'The suggestion could not be created');
  });

  app.patch<IdParams>('/api/suggestions/:id', async (request, reply) => {
    const docId = suggestionDoc(request.params.id);
    const access = accessVia(request, reply, docId, 'suggestion', 'view');
    if (!access || docId === undefined) return reply;
    const input = parseBody(updateSuggestionSchema, request.body, reply);
    if (!input) return reply;
    const result = reviewService.updateSuggestion({ suggestionId: request.params.id, newText: input.newText, editorId: access.principalId, editorRole: access.role });
    return result.ok ? suggestionDto(result.value, handleOf(docId)) : sendReviewError(reply, result.error, 'The suggestion could not be updated');
  });

  for (const action of ['accept', 'reject', 'withdraw'] as const) {
    app.post<IdParams>(`/api/suggestions/:id/${action}`, async (request, reply) => {
      const docId = suggestionDoc(request.params.id);
      const access = accessVia(request, reply, docId, 'suggestion', 'view');
      if (!access || docId === undefined) return reply;
      const result = action === 'accept'
        ? reviewService.acceptSuggestion(docId, request.params.id, access.principalId, access.role)
        : action === 'reject'
          ? reviewService.rejectSuggestion(request.params.id, access.principalId, access.role)
          : reviewService.withdrawSuggestion(request.params.id, access.principalId, access.role);
      if (!result.ok) return sendReviewError(reply, result.error, `The suggestion could not be ${action}ed`);
      const suggestion = 'suggestion' in result.value ? result.value.suggestion : result.value;
      return suggestionDto(suggestion, handleOf(docId));
    });
  }

  app.post<IdParams>('/api/suggestions/:id/regenerate', async (request, reply) => {
    const access = accessVia(request, reply, suggestionDoc(request.params.id), 'suggestion', 'suggest');
    if (!access) return reply;
    return ctx.agents.regenerate(request.params.id, access.principalId)
      ? { ok: true }
      : fail(reply, 400, 'invalid-state', 'Only stale agent suggestions can be regenerated');
  });

  for (const action of ['accept', 'reject'] as const) {
    app.post<IdParams>(`/api/batches/:id/${action}-remaining`, async (request, reply) => {
      const batch = reviewStore.getBatch(request.params.id);
      const access = accessVia(request, reply, batch === undefined ? undefined : threadDoc(batch.threadId), 'batch', 'view');
      if (!access) return reply;
      const result = action === 'accept'
        ? reviewService.acceptBatchRemaining(request.params.id, access.principalId, access.role)
        : reviewService.rejectBatchRemaining(request.params.id, access.principalId, access.role);
      return result.ok ? result.value : sendReviewError(reply, result.error, `The remaining suggestions could not be ${action}ed`);
    });
  }
}
