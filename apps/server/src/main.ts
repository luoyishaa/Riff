import Fastify from 'fastify';
import { can, randomId, systemClock, type Principal, type Role } from '@collab/kernel';
import { ReviewService, type ReviewEvent } from '@collab/review';
import { createMessageSchema, createSuggestionSchema, createThreadSchema } from '@collab/protocol';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { DocumentStore } from './infra/document-store.js';
import { ReviewStore } from './infra/review-store.js';
import { AgentStore } from './infra/agent-store.js';
import { AgentRuntime } from './agent-runtime.js';
import { AppEventBus } from './events.js';
import { resolveMentions } from './mentions.js';

const app = Fastify({ logger: true });
app.removeContentTypeParser('application/json');
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
  const text = typeof body === 'string' ? body : body.toString('utf8');
  if (text.length === 0) {
    done(null, {});
    return;
  }
  try {
    done(null, JSON.parse(text));
  } catch (error) {
    const parseError = error instanceof Error ? error : new Error(String(error));
    Object.assign(parseError, { statusCode: 400 });
    done(parseError);
  }
});
const dbPath = process.env.COLLAB_DB_PATH ?? 'collab.db';
const store = new DocumentStore(dbPath);
store.seed();
const reviewStore = new ReviewStore(store.db);
const agentStore = new AgentStore(store.db);
const eventBus = new AppEventBus();
let agentRuntime: AgentRuntime | undefined;
const reviewService = new ReviewService({
  clock: systemClock,
  ids: randomId,
  repository: reviewStore,
  documents: { getDocument: (docId) => store.get(docId)?.handle },
  emit: (event) => {
    const docId = eventDocId(event);
    if (docId) eventBus.publish({ type: event.type, docId, occurredAt: systemClock.now(), data: eventData(event) });
    agentRuntime?.handle(event);
  },
});
agentRuntime = new AgentRuntime({ store, reviewStore, reviewService, agentStore, eventBus, now: () => systemClock.now(), nextId: () => randomId.next() });
const sockets = new Map<string, Set<WebSocket>>();
const subscriptions = new Set<string>();
function eventDocId(event: ReviewEvent): string {
  if ('thread' in event) return event.thread.docId;
  if ('suggestion' in event) return event.suggestion.docId;
  if ('message' in event) return reviewStore.getThread(event.message.threadId)?.docId ?? '';
  if ('batch' in event) return reviewStore.getThread(event.batch.threadId)?.docId ?? '';
  return '';
}
function eventData(event: ReviewEvent): unknown {
  if ('thread' in event) return event.thread;
  if ('suggestion' in event) return event.suggestion;
  if ('message' in event) return event.message;
  return event.batch;
}
function principal(id: string): Principal | undefined {
  const value = store.principals().find((item) => item.id === id);
  return value;
}
function roleFor(docId: string, principalId: string): Role | null { return store.role(docId, principalId); }
function fail(reply: { code: (status: number) => { send: (value: unknown) => unknown } }, status: number, code: string, message: string): unknown {
  return reply.code(status).send({ error: { code, message } });
}
function json(ws: WebSocket, value: unknown): void { ws.send(JSON.stringify(value)); }
function ensureSubscription(docId: string): void {
  if (subscriptions.has(docId)) return;
  const record = store.get(docId); if (!record) return;
  subscriptions.add(docId);
  record.handle.subscribe(({ update, origin }) => {
    store.persistUpdate(docId, update);
    eventBus.publish({ type: 'document.changed', docId, occurredAt: systemClock.now(), data: { source: origin === undefined ? 'server' : 'client' } });
    const payload = JSON.stringify({ type: 'sync', update: Buffer.from(update).toString('base64') });
    for (const socket of sockets.get(docId) ?? []) if (socket !== origin && socket.readyState === socket.OPEN) socket.send(payload);
  });
}
for (const doc of store.list()) {
  reviewService.watchDocument(doc.id);
  ensureSubscription(doc.id);
}
app.get('/api/principals', async () => store.principals());
app.get('/api/docs', async (request) => {
  const principal = String(request.headers['x-principal-id'] ?? '');
  return store.list().filter((doc) => store.role(doc.id, principal));
});
app.get<{ Params: { id: string } }>('/api/docs/:id', async (request, reply) => {
  const principal = String(request.headers['x-principal-id'] ?? '');
  const record = store.get(request.params.id); if (!record || !store.role(record.id, principal)) return reply.code(404).send({ error: 'not-found' });
  return { id: record.id, title: record.title, text: record.handle.getText(), members: store.members(record.id) };
});
app.get<{ Params: { id: string } }>('/api/docs/:id/threads', async (request, reply) => {
  const principalId = String(request.headers['x-principal-id'] ?? '');
  const role = roleFor(request.params.id, principalId);
  if (!role || !can(role, 'view')) return fail(reply, 403, 'permission-denied', 'Membership is required');
  return reviewStore.listThreads(request.params.id).map((thread) => ({ ...thread, messages: reviewStore.listMessages(thread.id) }));
});
app.get<{ Params: { id: string } }>('/api/docs/:id/suggestions', async (request, reply) => {
  const principalId = String(request.headers['x-principal-id'] ?? '');
  const role = roleFor(request.params.id, principalId);
  if (!role || !can(role, 'view')) return fail(reply, 403, 'permission-denied', 'Membership is required');
  return reviewStore.listSuggestions(request.params.id);
});
app.get<{ Params: { id: string } }>('/api/docs/:id/agents', async (request, reply) => {
  const principalId = String(request.headers['x-principal-id'] ?? '');
  const role = roleFor(request.params.id, principalId);
  if (!role || !can(role, 'view')) return fail(reply, 403, 'permission-denied', 'Membership is required');
  return agentRuntime?.list(request.params.id) ?? [];
});
app.get<{ Params: { id: string } }>('/api/docs/:id/agent-runs', async (request, reply) => {
  const principalId = String(request.headers['x-principal-id'] ?? '');
  const role = roleFor(request.params.id, principalId);
  if (!role || !can(role, 'view')) return fail(reply, 403, 'permission-denied', 'Membership is required');
  return agentStore.listRuns(request.params.id);
});
app.post<{ Params: { id: string } }>('/api/docs/:id/threads', async (request, reply) => {
  const principalId = String(request.headers['x-principal-id'] ?? '');
  const role = roleFor(request.params.id, principalId);
  if (!role || !can(role, 'comment')) return fail(reply, 403, 'permission-denied', 'Commenter role is required');
  const parsed = createThreadSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  if (parsed.data.agentId !== undefined) {
    const assigned = principal(parsed.data.agentId);
    if (!assigned || assigned.kind !== 'agent' || !roleFor(request.params.id, assigned.id)) return fail(reply, 400, 'invalid-agent', 'Assigned agent is not a document member');
  }
  const scope = parsed.data.scope.type === 'document'
    ? { type: 'document' as const }
    : (() => {
      const anchor = reviewService.createAnchor(request.params.id, parsed.data.scope.start, parsed.data.scope.end);
      return anchor.ok ? { type: 'range' as const, anchor: anchor.value } : anchor;
    })();
  if ('ok' in scope && !scope.ok) return fail(reply, 400, scope.error, 'Selection is outside the document');
  const result = reviewService.createThread({ docId: request.params.id, scope: 'anchor' in scope ? scope : { type: 'document' }, kind: parsed.data.kind, ...(parsed.data.agentId === undefined ? {} : { agentId: parsed.data.agentId }), createdBy: principalId, createdByRole: role });
  if (!result.ok) return fail(reply, 400, result.error, 'Unable to create thread');
  return result.value;
});
app.post<{ Params: { id: string } }>('/api/docs/:id/suggestions', async (request, reply) => {
  const principalId = String(request.headers['x-principal-id'] ?? '');
  const role = roleFor(request.params.id, principalId);
  if (!role || !can(role, 'suggest')) return fail(reply, 403, 'permission-denied', 'Suggester role is required');
  const parsed = createSuggestionSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  const anchor = reviewService.createAnchor(request.params.id, parsed.data.start, parsed.data.end);
  if (!anchor.ok) return fail(reply, 400, anchor.error, 'Selection is outside the document');
  const author = principal(principalId);
  const input = { docId: request.params.id, authorId: principalId, anchor: anchor.value, newText: parsed.data.newText, ...(parsed.data.threadId === undefined ? {} : { threadId: parsed.data.threadId }), ...(parsed.data.rationale === undefined ? {} : { rationale: parsed.data.rationale }), ...(author === undefined ? {} : { authorKind: author.kind }), authorEffectiveRole: role };
  const result = reviewService.createSuggestion(input, undefined, author);
  if (!result.ok) return fail(reply, 400, result.error, 'Unable to create suggestion');
  return result.value;
});
app.post<{ Params: { id: string } }>('/api/threads/:id/messages', async (request, reply) => {
  const thread = reviewStore.getThread(request.params.id);
  if (!thread) return fail(reply, 404, 'thread-not-found', 'Thread was not found');
  const principalId = String(request.headers['x-principal-id'] ?? '');
  const role = roleFor(thread.docId, principalId);
  if (!role || !can(role, 'comment')) return fail(reply, 403, 'permission-denied', 'Commenter role is required');
  const parsed = createMessageSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  const mentions = resolveMentions(parsed.data.body, store.members(thread.docId));
  const result = reviewService.addMessage({ threadId: thread.id, authorId: principalId, body: parsed.data.body, mentions, authorRole: role });
  if (!result.ok) return fail(reply, 400, result.error, 'Unable to add message');
  return result.value;
});
app.post<{ Params: { id: string } }>('/api/threads/:id/resolve', async (request, reply) => {
  const thread = reviewStore.getThread(request.params.id);
  if (!thread) return fail(reply, 404, 'thread-not-found', 'Thread was not found');
  const principalId = String(request.headers['x-principal-id'] ?? '');
  const role = roleFor(thread.docId, principalId);
  if (!role || !can(role, 'comment')) return fail(reply, 403, 'permission-denied', 'Commenter role is required');
  const result = reviewService.resolveThread(thread.id, role);
  if (!result.ok) return fail(reply, 400, result.error, 'Unable to resolve thread');
  return result.value;
});
app.post<{ Params: { id: string } }>('/api/suggestions/:id/accept', async (request, reply) => {
  const suggestion = reviewStore.getSuggestion(request.params.id);
  if (!suggestion) return fail(reply, 404, 'suggestion-not-found', 'Suggestion was not found');
  const principalId = String(request.headers['x-principal-id'] ?? '');
  const role = roleFor(suggestion.docId, principalId);
  if (!role) return fail(reply, 403, 'permission-denied', 'Membership is required');
  const result = reviewService.acceptSuggestion(suggestion.docId, suggestion.id, principalId, role);
  if (!result.ok) return fail(reply, 400, result.error, 'Unable to accept suggestion');
  return result.value;
});
app.post<{ Params: { id: string } }>('/api/suggestions/:id/reject', async (request, reply) => {
  const suggestion = reviewStore.getSuggestion(request.params.id);
  if (!suggestion) return fail(reply, 404, 'suggestion-not-found', 'Suggestion was not found');
  const principalId = String(request.headers['x-principal-id'] ?? '');
  const role = roleFor(suggestion.docId, principalId);
  if (!role) return fail(reply, 403, 'permission-denied', 'Membership is required');
  const result = reviewService.rejectSuggestion(suggestion.id, principalId, role);
  if (!result.ok) return fail(reply, 400, result.error, 'Unable to reject suggestion');
  return result.value;
});
app.post<{ Params: { id: string } }>('/api/suggestions/:id/regenerate', async (request, reply) => {
  const suggestion = reviewStore.getSuggestion(request.params.id);
  if (!suggestion) return fail(reply, 404, 'suggestion-not-found', 'Suggestion was not found');
  const principalId = String(request.headers['x-principal-id'] ?? '');
  const role = roleFor(suggestion.docId, principalId);
  if (!role || !can(role, 'suggest')) return fail(reply, 403, 'permission-denied', 'Suggester role is required');
  if (!agentRuntime?.regenerate(suggestion.id, principalId)) return fail(reply, 400, 'invalid-state', 'Only stale agent suggestions can be regenerated');
  return { ok: true };
});
app.post<{ Params: { id: string } }>('/api/batches/:id/accept-remaining', async (request, reply) => {
  const batch = reviewStore.getBatch(request.params.id);
  if (!batch) return fail(reply, 404, 'batch-not-found', 'Batch was not found');
  const thread = reviewStore.getThread(batch.threadId);
  if (!thread) return fail(reply, 404, 'thread-not-found', 'Batch thread was not found');
  const principalId = String(request.headers['x-principal-id'] ?? '');
  const role = roleFor(thread.docId, principalId);
  if (!role) return fail(reply, 403, 'permission-denied', 'Membership is required');
  const result = reviewService.acceptBatchRemaining(batch.id, principalId, role);
  if (!result.ok) return fail(reply, 400, result.error, 'Unable to accept remaining suggestions');
  return result.value;
});
app.post<{ Params: { id: string } }>('/api/batches/:id/reject-remaining', async (request, reply) => {
  const batch = reviewStore.getBatch(request.params.id);
  if (!batch) return fail(reply, 404, 'batch-not-found', 'Batch was not found');
  const thread = reviewStore.getThread(batch.threadId);
  if (!thread) return fail(reply, 404, 'thread-not-found', 'Batch thread was not found');
  const principalId = String(request.headers['x-principal-id'] ?? '');
  const role = roleFor(thread.docId, principalId);
  if (!role) return fail(reply, 403, 'permission-denied', 'Membership is required');
  const result = reviewService.rejectBatchRemaining(batch.id, principalId, role);
  if (!result.ok) return fail(reply, 400, result.error, 'Unable to reject remaining suggestions');
  return result.value;
});
app.get<{ Params: { id: string }; Querystring: { principal?: string } }>('/api/docs/:id/events', async (request, reply) => {
  const principalId = String(request.headers['x-principal-id'] ?? request.query.principal ?? '');
  const role = roleFor(request.params.id, principalId);
  if (!role || !can(role, 'view')) return fail(reply, 403, 'permission-denied', 'Membership is required');
  ensureSubscription(request.params.id);
  reply.hijack();
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (event: import('./events.js').AppEvent): void => { reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); };
  const unsubscribe = eventBus.subscribe(request.params.id, send);
  const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15000);
  request.raw.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  return reply;
});
const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws: WebSocket, _request: import('node:http').IncomingMessage, context: { docId: string; principalId: string }) => {
  const { docId, principalId } = context; const record = store.get(docId); const role = store.role(docId, principalId);
  if (!record || !role) { ws.close(1008, 'not a member'); return; }
  ensureSubscription(docId);
  const group = sockets.get(docId) ?? new Set<WebSocket>(); group.add(ws); sockets.set(docId, group);
  json(ws, { type: 'sync', update: Buffer.from(record.handle.encodeStateAsUpdate()).toString('base64') });
  json(ws, { type: 'members', members: store.members(docId) });
  ws.on('message', (raw: RawData) => {
    let message: { type?: string; update?: string; state?: unknown };
    try { message = JSON.parse(raw.toString()) as typeof message; } catch { return; }
    if (message.type === 'sync' && message.update && can(role, 'edit')) {
      record.handle.applyUpdate(new Uint8Array(Buffer.from(message.update, 'base64')), ws);
    } else if (message.type === 'awareness') {
      const payload = JSON.stringify({ type: 'awareness', principalId, state: message.state });
      for (const socket of group) if (socket !== ws && socket.readyState === socket.OPEN) socket.send(payload);
    }
  });
  ws.on('close', () => group.delete(ws));
});
const httpServer = app.server;
httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const match = url.pathname.match(/^\/ws\/docs\/([^/]+)$/);
  if (!match) { socket.destroy(); return; }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request, { docId: match[1], principalId: url.searchParams.get('principal') ?? '' }));
});
const port = Number(process.env.PORT ?? 8787);
app.listen({ port, host: process.env.HOST ?? '127.0.0.1' }).then(() => app.log.info(`server listening on ${port}`));
