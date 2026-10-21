import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../src/server.js';

let app: FastifyInstance;
let base: string;

/** Opens a document's event stream as `principalId` and collects the event names it delivers. */
async function openEvents(principalId: string): Promise<{ next: (type: string) => Promise<void>; close: () => void }> {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/docs/demo-doc/events`, { headers: { 'x-principal-id': principalId }, signal: controller.signal });
  if (!response.body) throw new Error('the event stream has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  return {
    next: async (type) => {
      while (!received.includes(`event: ${type}\n`)) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`the stream ended before ${type}`);
        received += decoder.decode(chunk.value, { stream: true });
      }
    },
    close: () => controller.abort(),
  };
}

describe('membership change notices', () => {
  beforeAll(async () => {
    app = createServer({ dbPath: ':memory:', allowLegacyIdentityHeader: true, logger: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await app.close(); });

  it('tells open documents of the project when a member role changes', async () => {
    const stream = await openEvents('bob');
    try {
      const changed = await app.inject({
        method: 'PUT',
        url: '/api/workspaces/demo-space/members/dan',
        headers: { 'content-type': 'application/json', 'x-principal-id': 'alice' },
        payload: { role: 'suggester' },
      });
      expect(changed.statusCode).toBe(200);
      await stream.next('members.changed');
    } finally {
      stream.close();
    }
    const document = await app.inject({ method: 'GET', url: '/api/docs/demo-doc', headers: { 'x-principal-id': 'dan' } });
    expect(document.json()).toMatchObject({ role: 'suggester' });
  });
});
