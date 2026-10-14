import Fastify from 'fastify';
import { can } from '@collab/kernel';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { DocumentStore } from './infra/document-store.js';

const app = Fastify({ logger: true });
const store = new DocumentStore();
store.seed();
const sockets = new Map<string, Set<WebSocket>>();
const subscriptions = new Set<string>();
function json(ws: WebSocket, value: unknown): void { ws.send(JSON.stringify(value)); }
function ensureSubscription(docId: string): void {
  if (subscriptions.has(docId)) return;
  const record = store.get(docId); if (!record) return;
  subscriptions.add(docId);
  record.handle.subscribe(({ update, origin }) => {
    store.persistUpdate(docId, update);
    const payload = JSON.stringify({ type: 'sync', update: Buffer.from(update).toString('base64') });
    for (const socket of sockets.get(docId) ?? []) if (socket !== origin && socket.readyState === socket.OPEN) socket.send(payload);
  });
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
