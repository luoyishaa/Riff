import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

describe('database authentication routes', () => {
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.COLLAB_DB_PATH = ':memory:';
    delete process.env.COLLAB_DEV_AUTH_BYPASS;
    ({ app } = await import('../src/main.js'));
  });

  afterAll(async () => { await app.close(); });

  it('registers, restores a cookie session, and logs out', async () => {
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { displayName: 'Route User', handle: 'route-user', email: 'route@example.test', password: 'correct horse battery' },
    });
    expect(registered.statusCode).toBe(201);
    const cookie = registered.headers['set-cookie'];
    expect(cookie).toBeTruthy();

    const session = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie: Array.isArray(cookie) ? cookie[0] : cookie } });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ authenticated: true, principal: { handle: 'route-user' }, session: { transport: 'cookie' } });

    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: Array.isArray(cookie) ? cookie[0] : cookie } });
    expect(logout.statusCode).toBe(200);
    const afterLogout = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie: Array.isArray(cookie) ? cookie[0] : cookie } });
    expect(afterLogout.json()).toMatchObject({ authenticated: false, principal: null });
  });

  it('rejects wrong credentials and does not trust the legacy header by default', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'route-user', password: 'wrong password' },
    });
    expect(response.statusCode).toBe(401);
    const legacy = await app.inject({ method: 'GET', url: '/api/account', headers: { 'x-principal-id': 'alice' } });
    expect(legacy.statusCode).toBe(403);
    const directory = await app.inject({ method: 'GET', url: '/api/principals' });
    expect(directory.statusCode).toBe(403);
  });

  it('switches directly to a locally saved account credential', async () => {
    const origin = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { displayName: 'Origin User', handle: 'origin-user', password: 'origin user password' },
    });
    expect(origin.statusCode).toBe(201);
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { displayName: 'Switch User', handle: 'switch-user', password: 'switch user password' },
    });
    expect(registered.statusCode).toBe(201);
    const initialCookie = registered.headers['set-cookie'];
    const switched = await app.inject({
      method: 'POST',
      url: '/api/auth/switch',
      headers: { cookie: Array.isArray(initialCookie) ? initialCookie[0] : initialCookie },
      payload: { identifier: 'origin-user', password: 'origin user password' },
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toMatchObject({ principal: { handle: 'origin-user' }, session: { transport: 'cookie' } });
    const switchedCookie = switched.headers['set-cookie'];
    expect(switchedCookie).toBeTruthy();
    const session = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: Array.isArray(switchedCookie) ? switchedCookie[0] : switchedCookie },
    });
    expect(session.json()).toMatchObject({ authenticated: true, principal: { handle: 'origin-user' } });
    const originalSession = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: Array.isArray(initialCookie) ? initialCookie[0] : initialCookie },
    });
    expect(originalSession.json()).toMatchObject({ authenticated: true, principal: { handle: 'switch-user' } });
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/auth/switch',
      payload: { identifier: 'origin-user', password: 'wrong password' },
    });
    expect(rejected.statusCode).toBe(401);
  });

  it('lets a passwordless legacy seed principal claim its existing handle once', async () => {
    const claimed = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { displayName: 'Alice Chen', handle: 'alice', password: 'seed account password' },
    });
    expect(claimed.statusCode).toBe(201);
    expect(claimed.json()).toMatchObject({ principal: { id: 'alice', handle: 'alice', displayName: 'Alice Chen' } });
    const cookie = claimed.headers['set-cookie'];
    const workspaces = await app.inject({ method: 'GET', url: '/api/workspaces', headers: { cookie: Array.isArray(cookie) ? cookie[0] : cookie } });
    expect(workspaces.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'demo-space' })]));
  });

  it('renames a workspace and requires an exact title before deletion', async () => {
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { displayName: 'Workspace Owner', handle: 'workspace-owner', password: 'workspace owner password' },
    });
    expect(registered.statusCode).toBe(201);
    const cookie = registered.headers['set-cookie'];
    const headers = { cookie: Array.isArray(cookie) ? cookie[0] : cookie };
    const created = await app.inject({ method: 'POST', url: '/api/workspaces', headers, payload: { title: 'Draft Space' } });
    expect(created.statusCode).toBe(200);
    const workspaceId = created.json().id as string;
    const createdDocument = await app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/documents`, headers, payload: { title: 'Draft document', text: 'Draft content' } });
    expect(createdDocument.statusCode).toBe(200);
    const documentId = createdDocument.json().id as string;

    const renamed = await app.inject({ method: 'PATCH', url: `/api/workspaces/${workspaceId}`, headers, payload: { title: 'Published Space' } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ id: workspaceId, title: 'Published Space' });

    const mismatch = await app.inject({ method: 'DELETE', url: `/api/workspaces/${workspaceId}`, headers, payload: { confirmTitle: 'Draft Space' } });
    expect(mismatch.statusCode).toBe(409);
    const deleted = await app.inject({ method: 'DELETE', url: `/api/workspaces/${workspaceId}`, headers, payload: { confirmTitle: 'Published Space' } });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true, workspaceId });
    const afterDelete = await app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}`, headers });
    expect(afterDelete.statusCode).toBe(404);
    const deletedDocument = await app.inject({ method: 'GET', url: `/api/docs/${documentId}`, headers });
    expect(deletedDocument.statusCode).toBe(404);
  });
});
