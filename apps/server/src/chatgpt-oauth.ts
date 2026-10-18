import { constants as cryptoConstants, createPublicKey, createVerify, randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const AUTHORIZATION_ENDPOINT = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN_ENDPOINT = 'https://auth.openai.com/api/accounts/oauth/token';
const JWKS_ENDPOINT = 'https://auth.openai.com/.well-known/jwks.json';
const REVOCATION_ENDPOINT = 'https://auth.openai.com/api/accounts/oauth/revoke';
const MODELS_ENDPOINT = 'https://api.openai.com/v1/models';
const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'] as const;
const credentialSchema = z.object({
  profileId: z.string().min(1),
  ownerPrincipalId: z.string().min(1),
  email: z.string().email().optional(),
  issuer: z.string().url(),
  subject: z.string().min(1),
  clientId: z.string().min(1),
  extAgentHostId: z.string().min(1),
  idToken: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  tokenType: z.string().min(1),
  scopes: z.array(z.string()),
  expiresAt: z.number().finite(),
});
const fileSchema = z.object({
  version: z.literal(1),
  hostId: z.string().min(1),
  credentials: z.array(credentialSchema),
});
type StoredCredential = z.infer<typeof credentialSchema>;
type CredentialFile = z.infer<typeof fileSchema>;

export interface ChatGPTProfile {
  profileId: string;
  ownerPrincipalId: string;
  email?: string;
  subject: string;
  clientId: string;
  scopes: string[];
  planUsageEnabled: boolean;
  expiresAt: number;
}

export interface ChatGPTModel {
  slug: string;
  displayName: string;
}

interface PendingAuthorization {
  attemptId: string;
  profileId: string;
  ownerPrincipalId: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  verifier: string;
  createdAt: number;
  existing: boolean;
}

interface CompletedAttempt {
  attemptId: string;
  profileId: string;
  ownerPrincipalId: string;
  status: 'completed' | 'failed';
  profile?: ChatGPTProfile;
  error?: string;
  expiresAt: number;
}

interface OAuthServiceOptions {
  callbackUrl: string;
  storagePath?: string;
  appName?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string | undefined;
  id_token?: string | undefined;
  token_type?: string | undefined;
  expires_in?: number | undefined;
  scope?: string | undefined;
}

interface IdTokenClaims {
  issuer: string;
  subject: string;
  email?: string;
}

export class ChatGPTOAuthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ChatGPTOAuthError';
  }
}

/** Keep provider diagnostics actionable without sending OpenAI's response body to the browser. */
export function oauthRedirectCode(error: unknown): string {
  if (!(error instanceof ChatGPTOAuthError)) return 'oauth-failed';
  if (error.code === 'code-exchange-failed' && /unsupported_country_region_territory|country, region, or territory not supported/iu.test(error.message)) {
    return 'unsupported-region';
  }
  return error.code;
}

function defaultStoragePath(): string {
  const root = process.env.LOCALAPPDATA ?? process.env.APPDATA ?? join(homedir(), '.config');
  return join(root, 'collab-workbench', 'chatgpt-oauth.json');
}

function base64Url(value: Uint8Array): string { return Buffer.from(value).toString('base64url'); }

function parseJson(value: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new ChatGPTOAuthError('invalid-token', `${label} is not valid JSON`);
  }
}

function decodeSegment(value: string, label: string): Record<string, unknown> {
  return parseJson(Buffer.from(value, 'base64url').toString('utf8'), label);
}

function toProfile(value: StoredCredential): ChatGPTProfile {
  return {
    profileId: value.profileId,
    ownerPrincipalId: value.ownerPrincipalId,
    ...(value.email === undefined ? {} : { email: value.email }),
    subject: value.subject,
    clientId: value.clientId,
    scopes: [...value.scopes],
    planUsageEnabled: value.scopes.includes('chatgpt.tokens.use.direct'),
    expiresAt: value.expiresAt,
  };
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

function issuerAudienceMatches(audience: unknown, clientId: string): boolean {
  return typeof audience === 'string' ? audience === clientId : Array.isArray(audience) && audience.includes(clientId);
}

function signatureAlgorithm(algorithm: string): { name: string; options?: { padding: number; saltLength: number } } {
  if (algorithm === 'RS256') return { name: 'sha256' };
  if (algorithm === 'PS256') {
    return { name: 'sha256', options: { padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST } };
  }
  throw new ChatGPTOAuthError('invalid-token', `Unsupported ID token algorithm: ${algorithm}`);
}

async function verifyIdToken(token: string, clientId: string, nonce: string, fetchImpl: typeof fetch, now: number): Promise<IdTokenClaims> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw new ChatGPTOAuthError('invalid-token', 'ID token is not a JWT');
  const header = decodeSegment(parts[0]!, 'ID token header');
  const claims = decodeSegment(parts[1]!, 'ID token claims');
  const kid = typeof header.kid === 'string' ? header.kid : undefined;
  const algorithm = typeof header.alg === 'string' ? header.alg : undefined;
  if (!kid || !algorithm) throw new ChatGPTOAuthError('invalid-token', 'ID token is missing key metadata');
  const jwksResponse = await fetchImpl(JWKS_ENDPOINT);
  if (!jwksResponse.ok) throw new ChatGPTOAuthError('jwks-unavailable', `OpenAI JWKS returned HTTP ${jwksResponse.status}`);
  const jwks: unknown = await jwksResponse.json();
  const keys = z.object({ keys: z.array(z.record(z.unknown())) }).parse(jwks).keys;
  const jwk = keys.find((key) => key.kid === kid);
  if (!jwk) throw new ChatGPTOAuthError('invalid-token', 'ID token signing key was not found');
  const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  const verifier = createVerify(signatureAlgorithm(algorithm).name);
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  const signature = Buffer.from(parts[2]!, 'base64url');
  const algorithmConfig = signatureAlgorithm(algorithm);
  const valid = algorithmConfig.options === undefined
    ? verifier.verify(publicKey, signature)
    : verifier.verify({ key: publicKey, ...algorithmConfig.options }, signature);
  if (!valid) throw new ChatGPTOAuthError('invalid-token', 'ID token signature is invalid');
  if (claims.iss !== ISSUER || !issuerAudienceMatches(claims.aud, clientId) || claims.nonce !== nonce) throw new ChatGPTOAuthError('invalid-token', 'ID token issuer, audience, or nonce is invalid');
  if (typeof claims.exp !== 'number' || claims.exp <= now / 1000) throw new ChatGPTOAuthError('invalid-token', 'ID token has expired');
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) throw new ChatGPTOAuthError('invalid-token', 'ID token is missing subject');
  return {
    issuer: ISSUER,
    subject: claims.sub,
    ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
  };
}

export class ChatGPTOAuthService {
  private readonly storagePath: string;
  private readonly appName: string;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly completed = new Map<string, CompletedAttempt>();
  private readonly refreshes = new Map<string, Promise<StoredCredential>>();
  private file: CredentialFile | undefined;

  constructor(private readonly options: OAuthServiceOptions) {
    this.storagePath = options.storagePath ?? defaultStoragePath();
    this.appName = options.appName ?? 'Riff';
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async begin(ownerPrincipalId: string, profileId?: string): Promise<{ attemptId: string; authorizationUrl: string; profileId: string }> {
    const file = await this.load();
    const chosenProfileId = profileId ?? `chatgpt-${randomUUID()}`;
    const existing = file.credentials.find((item) => item.profileId === chosenProfileId && item.ownerPrincipalId === ownerPrincipalId);
    const clientId = existing?.clientId ?? DYNAMIC_CLIENT_ID;
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(new Uint8Array(await webcrypto.subtle.digest('SHA-256', Buffer.from(verifier))));
    const pending: PendingAuthorization = {
      attemptId: randomUUID(), profileId: chosenProfileId, ownerPrincipalId, clientId,
      redirectUri: this.options.callbackUrl, state: base64Url(randomBytes(24)), nonce: base64Url(randomBytes(24)), verifier,
      createdAt: this.now(), existing: existing !== undefined,
    };
    this.pending.set(pending.state, pending);
    const params = new URLSearchParams({
      client_id: clientId,
      ext_agent_host_id: file.hostId,
      response_type: 'code',
      redirect_uri: pending.redirectUri,
      scope: SCOPES.join(' '),
      resource: RESOURCE,
      state: pending.state,
      nonce: pending.nonce,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    });
    if (existing === undefined) params.set('agent_name_hint', this.appName);
    else {
      if (existing.idToken) params.set('id_token_hint', existing.idToken);
      if (existing.email) params.set('login_hint', existing.email);
    }
    return { attemptId: pending.attemptId, authorizationUrl: `${AUTHORIZATION_ENDPOINT}?${params.toString()}`, profileId: chosenProfileId };
  }

  async complete(query: URLSearchParams): Promise<ChatGPTProfile> {
    const state = query.get('state');
    if (!state) throw new ChatGPTOAuthError('invalid-callback', 'OAuth callback is missing state');
    const pending = this.pending.get(state);
    if (!pending) throw new ChatGPTOAuthError('invalid-callback', 'OAuth state is unknown or expired');
    this.pending.delete(state);
    const callbackError = query.get('error');
    if (callbackError) throw this.finishFailure(pending, new ChatGPTOAuthError(callbackError, query.get('error_description') ?? callbackError));
    const code = query.get('code');
    if (!code) throw this.finishFailure(pending, new ChatGPTOAuthError('invalid-callback', 'OAuth callback is missing code'));
    const callbackClientId = query.get('client_id');
    if (pending.existing && callbackClientId !== null && callbackClientId !== pending.clientId) throw this.finishFailure(pending, new ChatGPTOAuthError('client-mismatch', 'OAuth callback client does not match the selected account'));
    const clientId = callbackClientId ?? pending.clientId;
    if (!pending.existing && (callbackClientId === null || callbackClientId === DYNAMIC_CLIENT_ID)) throw this.finishFailure(pending, new ChatGPTOAuthError('registration-incomplete', 'OpenAI did not return an issued client ID'));
    try {
      const token = await this.exchangeCode(clientId, code, pending.verifier, pending.redirectUri);
      if (!token.id_token) throw new ChatGPTOAuthError('invalid-token-response', 'OpenAI token response did not include an ID token');
      const claims = await verifyIdToken(token.id_token, clientId, pending.nonce, this.fetchImpl, this.now());
      const scopes = (token.scope ?? query.get('scope') ?? '').split(/\s+/u).filter(Boolean);
      const old = (await this.load()).credentials.find((item) => item.profileId === pending.profileId && item.ownerPrincipalId === pending.ownerPrincipalId);
      if (old && old.subject !== claims.subject) throw new ChatGPTOAuthError('account-mismatch', 'OAuth identity does not match the selected account');
      const credential: StoredCredential = {
        profileId: pending.profileId, ownerPrincipalId: pending.ownerPrincipalId,
        ...(claims.email === undefined ? {} : { email: claims.email }), issuer: claims.issuer, subject: claims.subject,
        clientId, extAgentHostId: (await this.load()).hostId, idToken: token.id_token, accessToken: token.access_token,
        refreshToken: token.refresh_token ?? old?.refreshToken ?? '', tokenType: token.token_type ?? 'Bearer', scopes,
        expiresAt: this.now() + (token.expires_in ?? 3600) * 1000,
      };
      if (!credential.refreshToken) throw new ChatGPTOAuthError('invalid-token-response', 'OAuth response did not include a refresh token');
      await this.saveCredential(credential);
      const profile = toProfile(credential);
      this.completed.set(pending.attemptId, { attemptId: pending.attemptId, profileId: pending.profileId, ownerPrincipalId: pending.ownerPrincipalId, status: 'completed', profile, expiresAt: this.now() + 10 * 60_000 });
      return profile;
    } catch (error) {
      throw this.finishFailure(pending, error instanceof ChatGPTOAuthError ? error : new ChatGPTOAuthError('oauth-failed', errorMessage(error)));
    }
  }

  attempt(attemptId: string, ownerPrincipalId: string): CompletedAttempt | { status: 'pending'; attemptId: string } | undefined {
    const completed = this.completed.get(attemptId);
    if (completed) return completed.ownerPrincipalId === ownerPrincipalId ? completed : undefined;
    const pending = [...this.pending.values()].find((item) => item.attemptId === attemptId && item.ownerPrincipalId === ownerPrincipalId);
    return pending ? { status: 'pending', attemptId } : undefined;
  }

  async profiles(ownerPrincipalId: string): Promise<ChatGPTProfile[]> {
    return (await this.load()).credentials.filter((item) => item.ownerPrincipalId === ownerPrincipalId).map(toProfile);
  }

  hasPlanProfile(ownerPrincipalId: string, profileId: string): boolean {
    const profile = this.file?.credentials.find((item) => item.ownerPrincipalId === ownerPrincipalId && item.profileId === profileId);
    return profile?.scopes.includes('chatgpt.tokens.use.direct') ?? false;
  }

  async accessToken(ownerPrincipalId: string, profileId: string): Promise<string> {
    const credential = (await this.load()).credentials.find((item) => item.ownerPrincipalId === ownerPrincipalId && item.profileId === profileId);
    if (!credential) throw new ChatGPTOAuthError('profile-not-found', 'ChatGPT account is not connected');
    if (!credential.scopes.includes('chatgpt.tokens.use.direct')) throw new ChatGPTOAuthError('plan-scope-missing', 'ChatGPT plan usage was not authorized');
    if (credential.expiresAt > this.now() + 60_000) return credential.accessToken;
    return (await this.refresh(ownerPrincipalId, profileId)).accessToken;
  }

  async models(ownerPrincipalId: string, profileId: string): Promise<ChatGPTModel[]> {
    const accessToken = await this.accessToken(ownerPrincipalId, profileId);
    const response = await this.fetchImpl(MODELS_ENDPOINT, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new ChatGPTOAuthError('models-failed', `OpenAI model list returned HTTP ${response.status}`);
    const body: unknown = await response.json();
    const models = z.object({ models: z.array(z.object({ slug: z.string().min(1), display_name: z.string().min(1), visibility: z.string().optional() })).optional() }).safeParse(body);
    if (!models.success) throw new ChatGPTOAuthError('models-failed', 'OpenAI model list response is invalid');
    return (models.data.models ?? []).filter((model) => model.visibility === undefined || model.visibility === 'list').map((model) => ({ slug: model.slug, displayName: model.display_name }));
  }

  async revoke(ownerPrincipalId: string, profileId: string): Promise<void> {
    const file = await this.load();
    const credential = file.credentials.find((item) => item.ownerPrincipalId === ownerPrincipalId && item.profileId === profileId);
    if (!credential) return;
    const body = new URLSearchParams({ token: credential.refreshToken, token_type_hint: 'refresh_token', client_id: credential.clientId });
    const response = await this.fetchImpl(REVOCATION_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!response.ok && response.status >= 500) throw new ChatGPTOAuthError('revocation-failed', `OpenAI revocation returned HTTP ${response.status}`);
    file.credentials = file.credentials.filter((item) => item !== credential);
    await this.write(file);
  }

  private async refresh(ownerPrincipalId: string, profileId: string): Promise<StoredCredential> {
    const key = `${ownerPrincipalId}:${profileId}`;
    const active = this.refreshes.get(key);
    if (active) return active;
    const request = this.performRefresh(ownerPrincipalId, profileId).finally(() => this.refreshes.delete(key));
    this.refreshes.set(key, request);
    return request;
  }

  private async performRefresh(ownerPrincipalId: string, profileId: string): Promise<StoredCredential> {
    const file = await this.load();
    const current = file.credentials.find((item) => item.ownerPrincipalId === ownerPrincipalId && item.profileId === profileId);
    if (!current) throw new ChatGPTOAuthError('profile-not-found', 'ChatGPT account is not connected');
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: current.clientId, refresh_token: current.refreshToken, resource: RESOURCE });
    const response = await this.fetchImpl(TOKEN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!response.ok) {
      const detail = await response.text();
      if (response.status === 400 && /invalid_grant|invalid_refresh_token|refresh_token_(?:expired|invalidated|reused)/iu.test(detail)) {
        file.credentials = file.credentials.filter((item) => item !== current);
        await this.write(file);
        throw new ChatGPTOAuthError('refresh-token-invalid', 'ChatGPT authorization expired; sign in again');
      }
      throw new ChatGPTOAuthError('refresh-failed', `OpenAI token refresh returned HTTP ${response.status}`);
    }
    const token = await this.parseTokenResponse(response, false);
    const replacement: StoredCredential = { ...current, accessToken: token.access_token, refreshToken: token.refresh_token ?? current.refreshToken, idToken: token.id_token ?? current.idToken, tokenType: token.token_type ?? current.tokenType, scopes: (token.scope ?? current.scopes.join(' ')).split(/\s+/u).filter(Boolean), expiresAt: this.now() + (token.expires_in ?? 3600) * 1000 };
    await this.saveCredential(replacement);
    return replacement;
  }

  private async exchangeCode(clientId: string, code: string, verifier: string, redirectUri: string): Promise<TokenResponse> {
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE });
    const response = await this.fetchImpl(TOKEN_ENDPOINT, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!response.ok) {
      const detail = (await response.text()).trim().replace(/\s+/gu, ' ').slice(0, 240);
      throw new ChatGPTOAuthError('code-exchange-failed', detail.length > 0 ? `OpenAI token exchange returned HTTP ${response.status}: ${detail}` : `OpenAI token exchange returned HTTP ${response.status}`);
    }
    return this.parseTokenResponse(response, true);
  }

  private async parseTokenResponse(response: Response, requireIdToken: boolean): Promise<TokenResponse> {
    const body: unknown = await response.json();
    const parsed = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), id_token: z.string().min(1).optional(), token_type: z.string().optional(), expires_in: z.number().positive().optional(), scope: z.string().optional() }).safeParse(body);
    if (!parsed.success) throw new ChatGPTOAuthError('invalid-token-response', 'OpenAI token response is incomplete');
    if (requireIdToken && !parsed.data.id_token) throw new ChatGPTOAuthError('invalid-token-response', 'OpenAI token response did not include an ID token');
    return parsed.data;
  }

  private finishFailure(pending: PendingAuthorization, error: ChatGPTOAuthError): ChatGPTOAuthError {
    this.completed.set(pending.attemptId, { attemptId: pending.attemptId, profileId: pending.profileId, ownerPrincipalId: pending.ownerPrincipalId, status: 'failed', error: error.code, expiresAt: this.now() + 10 * 60_000 });
    return error;
  }

  private async load(): Promise<CredentialFile> {
    if (this.file) return this.file;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.storagePath, 'utf8'));
      const value = fileSchema.safeParse(parsed);
      if (value.success) { this.file = value.data; return value.data; }
    } catch {
      // A missing or malformed local file starts a fresh credential store.
    }
    this.file = { version: 1, hostId: `urn:uuid:${randomUUID()}`, credentials: [] };
    await this.write(this.file);
    return this.file;
  }

  private async saveCredential(credential: StoredCredential): Promise<void> {
    const file = await this.load();
    file.credentials = [...file.credentials.filter((item) => item.profileId !== credential.profileId || item.ownerPrincipalId !== credential.ownerPrincipalId), credential];
    await this.write(file);
  }

  private async write(file: CredentialFile): Promise<void> {
    this.file = file;
    await mkdir(dirname(this.storagePath), { recursive: true });
    const temporaryPath = `${this.storagePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try { await chmod(temporaryPath, 0o600); } catch { /* Windows does not expose Unix file modes. */ }
    await rename(temporaryPath, this.storagePath);
  }
}
