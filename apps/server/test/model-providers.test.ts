import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

describe('model provider registry routes', () => {
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.COLLAB_DB_PATH = ':memory:';
    delete process.env.COLLAB_DEV_AUTH_BYPASS;
    ({ app } = await import('../src/main.js'));
  });

  afterAll(async () => { await app.close(); });

  it('lists providers with a stable disconnected catalog and keeps API keys out of responses', async () => {
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { displayName: 'Provider User', handle: 'provider-user', password: 'provider user password' },
    });
    const cookie = registered.headers['set-cookie'];
    const headers = { cookie: Array.isArray(cookie) ? cookie[0] : cookie };
    const listed = await app.inject({ method: 'GET', url: '/api/model-providers', headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'openrouter', state: 'not-connected' }),
      expect.objectContaining({ id: 'deepseek', state: 'not-connected' }),
      expect.objectContaining({ id: 'openai-api', state: 'not-connected', baseUrl: 'https://api.openai.com/v1' }),
    ]));
    const providers = listed.json().providers as Array<{ id: string; baseUrl?: string }>;
    expect(providers.some((provider) => provider.id === 'openai-chatgpt')).toBe(false);
    expect(providers.find((provider) => provider.id === 'deepseek')).toMatchObject({ baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-flash' });
    const removed = await app.inject({ method: 'POST', url: '/api/model-providers/openai-chatgpt/connect', headers, payload: { apiKey: 'unused', model: 'unused' } });
    expect(removed.statusCode).toBe(404);
    expect(removed.json().error.code).toBe('provider-not-found');
  });

  it('connects and disconnects an OpenAI-compatible provider in process memory', async () => {
    const loggedIn = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: 'provider-user', password: 'provider user password' } });
    const cookie = loggedIn.headers['set-cookie'];
    const headers = { cookie: Array.isArray(cookie) ? cookie[0] : cookie };
    const connected = await app.inject({
      method: 'POST',
      url: '/api/model-providers/openrouter/connect',
      headers,
      payload: { apiKey: 'do-not-return-this-key', model: 'deepseek/deepseek-v3.1' },
    });
    expect(connected.statusCode).toBe(200);
    expect(connected.json()).toMatchObject({ provider: { id: 'openrouter', state: 'connected', detail: '已连接 · deepseek/deepseek-v3.1' }, keyStored: false, sessionOnly: true });
    expect(JSON.stringify(connected.json())).not.toContain('do-not-return-this-key');
    const disconnected = await app.inject({ method: 'DELETE', url: '/api/model-providers/openrouter', headers });
    expect(disconnected.json()).toEqual({ ok: true });
  });

  it('rejects unknown and CLI entries on the API-key connect endpoint', async () => {
    const loggedIn = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: 'provider-user', password: 'provider user password' } });
    const cookie = loggedIn.headers['set-cookie'];
    const headers = { cookie: Array.isArray(cookie) ? cookie[0] : cookie };
    const response = await app.inject({ method: 'POST', url: '/api/model-providers/codex-cli/connect', headers, payload: { apiKey: 'not-used', model: 'codex' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('provider-not-connectable');
  });

  it('uses provider-specific API defaults instead of an unrelated GPT model', async () => {
    const loggedIn = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: 'provider-user', password: 'provider user password' } });
    const cookie = loggedIn.headers['set-cookie'];
    const headers = { cookie: Array.isArray(cookie) ? cookie[0] : cookie };
    const connected = await app.inject({
      method: 'POST',
      url: '/api/model-providers/deepseek/connect',
      headers,
      payload: { apiKey: 'deepseek-key', model: 'deepseek-flash', baseUrl: 'https://example.invalid/v1' },
    });
    expect(connected.statusCode).toBe(200);
    expect(connected.json().provider).toMatchObject({ id: 'deepseek', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-flash', models: [{ slug: 'deepseek-flash', displayName: 'deepseek-flash' }] });
  });
});
