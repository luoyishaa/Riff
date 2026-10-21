import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

describe('review withdrawal routes', () => {
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.COLLAB_DB_PATH = ':memory:';
    process.env.COLLAB_DEV_AUTH_BYPASS = '1';
    ({ app } = await import('../src/main.js'));
  });

  afterAll(async () => {
    delete process.env.COLLAB_DEV_AUTH_BYPASS;
    await app.close();
  });

  it('lets an author withdraw their own message and rejects another member', async () => {
    const aliceHeaders = { 'content-type': 'application/json', 'x-principal-id': 'alice' };
    const bobHeaders = { 'content-type': 'application/json', 'x-principal-id': 'bob' };
    const createdThread = await app.inject({
      method: 'POST',
      url: '/api/docs/demo-doc/threads',
      headers: aliceHeaders,
      payload: { kind: 'discussion', scope: { type: 'document' } },
    });
    expect(createdThread.statusCode).toBe(200);
    const threadId = createdThread.json<{ id: string }>().id;

    const createdMessage = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      headers: aliceHeaders,
      payload: { body: '撤回测试' },
    });
    expect(createdMessage.statusCode).toBe(200);
    const messageId = createdMessage.json<{ id: string }>().id;

    const spoofed = await app.inject({ method: 'POST', url: `/api/messages/${messageId}/withdraw`, headers: bobHeaders, payload: {} });
    expect(spoofed.statusCode).toBe(403);
    expect(spoofed.json()).toMatchObject({ error: { code: 'permission-denied' } });

    const withdrawn = await app.inject({ method: 'POST', url: `/api/messages/${messageId}/withdraw`, headers: aliceHeaders, payload: {} });
    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json()).toMatchObject({ id: messageId, status: 'withdrawn', withdrawnBy: 'alice' });

    const repeated = await app.inject({ method: 'POST', url: `/api/messages/${messageId}/withdraw`, headers: aliceHeaders, payload: {} });
    expect(repeated.statusCode).toBe(400);
    expect(repeated.json()).toMatchObject({ error: { code: 'invalid-state' } });

    const listed = await app.inject({ method: 'GET', url: '/api/docs/demo-doc/threads', headers: bobHeaders });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: threadId, messages: [expect.objectContaining({ id: messageId, status: 'withdrawn' })] }),
    ]));
  });
});
