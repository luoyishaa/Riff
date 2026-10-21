import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DocumentStore } from '../src/infra/document-store.js';
import { ReviewStore } from '../src/infra/review-store.js';
import { AgentStore } from '../src/infra/agent-store.js';

describe('DocumentStore.deleteDocument', () => {
  it('removes the document and all document-scoped collaboration data', () => {
    const store = new DocumentStore(':memory:');
    store.upsertPrincipal({ id: 'alice', kind: 'human', displayName: 'Alice' });
    const workspace = store.createWorkspace('space-1', 'Writing', 'alice', 1);
    const document = store.create('doc-1', 'Draft', 'content', [], workspace.id);
    store.setMembership({ docId: document.id, principalId: 'alice', role: 'owner' });

    const review = new ReviewStore(store.db);
    review.createThread({ id: 'thread-1', docId: document.id, scope: { type: 'document' }, kind: 'discussion', status: 'open', createdBy: 'alice', createdAt: 2 });
    review.addMessage({ id: 'message-1', threadId: 'thread-1', authorId: 'alice', body: 'Review this', mentions: [], createdAt: 3 });
    review.saveThreadReadAt('thread-1', 'alice', 4);
    review.saveBatch({ id: 'batch-1', threadId: 'thread-1', createdBy: 'alice', createdAt: 5 });
    review.saveDocumentVersion({ id: 'version-1', docId: document.id, suggestionId: 'suggestion-1', text: 'content', createdBy: 'alice', createdAt: 6 });
    const agent = new AgentStore(store.db);
    agent.save({ agentId: 'agent-1', docId: document.id, textSnapshot: 'content', takenAt: 7 });

    expect(store.deleteDocument(document.id)).toBe(true);
    expect(store.get(document.id)).toBeUndefined();
    expect(store.list()).toHaveLength(0);
    expect(store.db.prepare('SELECT COUNT(*) as count FROM memberships WHERE doc_id = ?').get(document.id)).toEqual({ count: 0 });
    expect(store.db.prepare('SELECT COUNT(*) as count FROM updates WHERE doc_id = ?').get(document.id)).toEqual({ count: 0 });
    expect(review.listThreads(document.id)).toHaveLength(0);
    expect(review.listMessages('thread-1')).toHaveLength(0);
    expect(review.listBatches('thread-1')).toHaveLength(0);
    expect(review.listDocumentVersions(document.id)).toHaveLength(0);
    expect(agent.get('agent-1', document.id)).toBeUndefined();
    expect(store.deleteDocument(document.id)).toBe(false);
  });
});

describe('DELETE /api/docs/:id', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.COLLAB_DB_PATH = ':memory:';
    delete process.env.COLLAB_DEV_AUTH_BYPASS;
    ({ app } = await import('../src/main.js'));
  });

  afterAll(async () => { await app.close(); });

  it('requires an editor and removes the document from the workspace', async () => {
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { displayName: 'Delete Owner', handle: 'delete-owner', password: 'delete owner password' },
    });
    expect(registered.statusCode).toBe(201);
    const cookie = registered.headers['set-cookie'];
    const headers = { cookie: Array.isArray(cookie) ? cookie[0] : cookie };
    const workspace = await app.inject({ method: 'POST', url: '/api/workspaces', headers, payload: { title: 'Delete Space' } });
    const document = await app.inject({ method: 'POST', url: `/api/workspaces/${workspace.json().id}/documents`, headers, payload: { title: 'Delete Me', text: 'draft' } });
    const documentId = document.json().id as string;

    const deleted = await app.inject({ method: 'DELETE', url: `/api/docs/${documentId}`, headers });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true, documentId });
    expect((await app.inject({ method: 'GET', url: `/api/docs/${documentId}`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/workspaces/${workspace.json().id}`, headers })).json().documents).toHaveLength(0);
  });
});
