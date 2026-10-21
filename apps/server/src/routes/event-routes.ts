import type { FastifyInstance } from 'fastify';
import type { DocumentEvent } from '@collab/protocol';
import { documentAccess, type ServerContext } from '../context.js';

const HEARTBEAT_MS = 15_000;

/** Server-sent events for one document. Events are change notices; clients refetch what changed. */
export function registerEventRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Params: { id: string } }>('/api/docs/:id/events', async (request, reply) => {
    if (!documentAccess(ctx, request, reply, request.params.id, 'view')) return reply;
    ctx.collaboration.open(request.params.id);
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    // Open the stream now rather than with the first event, so clients know they are subscribed.
    reply.raw.flushHeaders();
    const send = (event: DocumentEvent): void => { reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); };
    const unsubscribe = ctx.events.subscribe(request.params.id, send);
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), HEARTBEAT_MS);
    request.raw.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
    return reply;
  });
}
