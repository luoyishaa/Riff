import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatGPTOAuthError, ChatGPTOAuthService, oauthRedirectCode } from '../src/chatgpt-oauth.js';

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = keyPair.publicKey.export({ format: 'jwk' });
const issuedClientId = 'oaiapp_test-issued';
let temporaryDirectories: string[] = [];

function jwt(nonce: string, subject = 'chatgpt-subject'): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', kid: 'test-key', typ: 'JWT' });
  const claims = encode({ iss: 'https://auth.openai.com', aud: issuedClientId, sub: subject, email: 'pro@example.com', nonce, exp: Math.floor(Date.now() / 1000) + 3600 });
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  signer.end();
  return `${header}.${claims}.${signer.sign(keyPair.privateKey).toString('base64url')}`;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function service(fetchImpl: typeof fetch, now: () => number = () => Date.now()): Promise<{ oauth: ChatGPTOAuthService; storagePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'collab-oauth-'));
  temporaryDirectories.push(directory);
  const storagePath = join(directory, 'credentials.json');
  return { storagePath, oauth: new ChatGPTOAuthService({ callbackUrl: 'http://127.0.0.1:8787/api/auth/chatgpt/callback', storagePath, now, fetchImpl }) };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('ChatGPT OAuth plan connection', () => {
  it('classifies an unsupported-region exchange failure without exposing provider details to the redirect', () => {
    const error = new ChatGPTOAuthError('code-exchange-failed', 'OpenAI token exchange returned HTTP 403: {"error":{"code":"unsupported_country_region_territory"}}');
    expect(oauthRedirectCode(error)).toBe('unsupported-region');
    expect(oauthRedirectCode(new ChatGPTOAuthError('code-exchange-failed', 'OpenAI token exchange returned HTTP 500'))).toBe('code-exchange-failed');
  });

  it('uses dynamic registration, validates the ID token, and stores only a public profile result', async () => {
    let tokenCalls = 0;
    let expectedNonce = '';
    const { oauth, storagePath } = await service(async (input, init) => {
      if (String(input).includes('/.well-known/jwks.json')) return response({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] });
      tokenCalls += 1;
      const body = String(init?.body ?? '');
      expect(body).toContain('grant_type=authorization_code');
      expect(body).toContain(`client_id=${issuedClientId}`);
      return response({ access_token: 'access-token-1', refresh_token: 'refresh-token-1', id_token: jwt(expectedNonce), token_type: 'Bearer', expires_in: 3600, scope: 'openid email offline_access resource.invoke chatgpt.tokens.use.direct' });
    });
    const started = await oauth.begin('human-alice');
    const authorization = new URL(started.authorizationUrl);
    expectedNonce = authorization.searchParams.get('nonce')!;
    expect(authorization.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(authorization.searchParams.get('agent_name_hint')).toBe('Collaborative Workbench');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct');
    const profile = await oauth.complete(new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'authorization-code', client_id: issuedClientId }));
    expect(profile.planUsageEnabled).toBe(true);
    expect(profile.clientId).toBe(issuedClientId);
    expect(await oauth.accessToken('human-alice', started.profileId)).toBe('access-token-1');
    expect(tokenCalls).toBe(1);
    expect((await oauth.profiles('human-alice'))[0]).not.toHaveProperty('accessToken');
    const stored = await readFile(storagePath, 'utf8');
    expect(stored).toContain('refresh-token-1');
    expect(stored).toContain('urn:uuid:');
  });

  it('reuses the issued client and rotates refresh tokens without exposing credentials', async () => {
    let now = 1_700_000_000_000;
    let tokenCalls = 0;
    let expectedNonce = '';
    const { oauth } = await service(async (input, init) => {
      if (String(input).includes('/.well-known/jwks.json')) return response({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] });
      tokenCalls += 1;
      if (tokenCalls === 1) return response({ access_token: 'access-token-1', refresh_token: 'refresh-token-1', id_token: jwt(expectedNonce), expires_in: 1, scope: 'openid email offline_access resource.invoke chatgpt.tokens.use.direct' });
      expect(String(init?.body ?? '')).toContain('grant_type=refresh_token');
      return response({ access_token: 'access-token-2', refresh_token: 'refresh-token-2', expires_in: 3600, scope: 'openid email offline_access resource.invoke chatgpt.tokens.use.direct' });
    }, () => now);
    const started = await oauth.begin('human-alice', 'profile-one');
    const authorization = new URL(started.authorizationUrl);
    expectedNonce = authorization.searchParams.get('nonce')!;
    const profile = await oauth.complete(new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'code', client_id: issuedClientId }));
    expect(profile.profileId).toBe('profile-one');
    now += 5_000;
    expect(await oauth.accessToken('human-alice', 'profile-one')).toBe('access-token-2');
    // Reauthorization reuses the issued client ID and omits the initial registration hint.
    const second = await oauth.begin('human-alice', 'profile-one');
    expect(new URL(second.authorizationUrl).searchParams.get('client_id')).toBe(issuedClientId);
    expect(new URL(second.authorizationUrl).searchParams.get('agent_name_hint')).toBeNull();
    expect(now).toBeGreaterThan(1_700_000_000_000);
  });

  it('keeps a valid sign-in but blocks inference when the plan scope was not granted', async () => {
    let expectedNonce = '';
    const blocked = await service(async (input) => {
      if (String(input).includes('/.well-known/jwks.json')) return response({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] });
      return response({ access_token: 'access-token', refresh_token: 'refresh-token', id_token: jwt(expectedNonce), expires_in: 3600, scope: 'openid email offline_access resource.invoke' });
    });
    const second = await blocked.oauth.begin('human-bob');
    const secondUrl = new URL(second.authorizationUrl);
    expectedNonce = secondUrl.searchParams.get('nonce')!;
    await blocked.oauth.complete(new URLSearchParams({ state: secondUrl.searchParams.get('state')!, code: 'code', client_id: issuedClientId }));
    await expect(blocked.oauth.accessToken('human-bob', second.profileId)).rejects.toMatchObject<ChatGPTOAuthError>({ code: 'plan-scope-missing' });
  });

  it('clears a profile after a terminal refresh-token error', async () => {
    let expectedNonce = '';
    let now = 1_700_000_000_000;
    let exchange = true;
    const { oauth } = await service(async (input) => {
      if (String(input).includes('/.well-known/jwks.json')) return response({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] });
      if (!exchange) return response({ error: 'invalid_grant' }, 400);
      exchange = false;
      return response({ access_token: 'access-token', refresh_token: 'refresh-token', id_token: jwt(expectedNonce), expires_in: 1, scope: 'openid email offline_access resource.invoke chatgpt.tokens.use.direct' });
    }, () => now);
    const started = await oauth.begin('human-carol');
    const url = new URL(started.authorizationUrl);
    expectedNonce = url.searchParams.get('nonce')!;
    await oauth.complete(new URLSearchParams({ state: url.searchParams.get('state')!, code: 'code', client_id: issuedClientId }));
    now += 5_000;
    await expect(oauth.accessToken('human-carol', started.profileId)).rejects.toMatchObject<ChatGPTOAuthError>({ code: 'refresh-token-invalid' });
    expect(await oauth.profiles('human-carol')).toHaveLength(0);
  });
});
