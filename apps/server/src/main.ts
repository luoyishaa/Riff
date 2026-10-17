import Fastify from 'fastify';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { can, randomId, roleRank, systemClock, type Principal, type Role } from '@collab/kernel';
import { ReviewService, type ReviewEvent } from '@collab/review';
import type { AdapterConfig, AgentConfig } from '@collab/agent';
import { agentConfigSchema, agentProviderConnectSchema, authLoginSchema, createAgentSchema, createDocumentSchema, createMessageSchema, createSuggestionSchema, createThreadSchema, createWorkspaceSchema, deleteWorkspaceSchema, localProjectBindSchema, localProjectSyncSchema, modelProviderBindingSchema, modelProviderConnectSchema, modelProviderIdSchema, registerPrincipalSchema, switchAccountSchema, updateAccountSchema, updateWorkspaceSchema, workspaceInvitationSchema, workspaceMemberSchema } from '@collab/protocol';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { DocumentStore, type PrincipalRecord } from './infra/document-store.js';
import { ReviewStore } from './infra/review-store.js';
import { AgentStore } from './infra/agent-store.js';
import { AgentRuntime } from './agent-runtime.js';
import { AppEventBus } from './events.js';
import { resolveMentions } from './mentions.js';
import { inspectCliProviders } from './cli-providers.js';
import { canInviteAgent, canManageAgent as canManageAgentPermission, canSeeAgent } from './workspace-permissions.js';
import { LocalProjectService, type LocalProjectFile } from './infra/local-project.js';
import { ChatGPTOAuthError, ChatGPTOAuthService, oauthRedirectCode } from './chatgpt-oauth.js';
import { ModelProviderRegistry, type ModelProviderId } from './model-providers.js';

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
const chatgptOAuth = new ChatGPTOAuthService({
  callbackUrl: process.env.COLLAB_CHATGPT_CALLBACK_URL ?? `http://127.0.0.1:${process.env.PORT ?? '8787'}/api/auth/chatgpt/callback`,
  ...(process.env.COLLAB_CHATGPT_CREDENTIALS_PATH === undefined ? {} : { storagePath: process.env.COLLAB_CHATGPT_CREDENTIALS_PATH }),
});
const modelProviders = new ModelProviderRegistry({});
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
agentRuntime = new AgentRuntime({ store, reviewStore, reviewService, agentStore, eventBus, chatgptOAuth, now: () => systemClock.now(), nextId: () => randomId.next() });
const localProject = new LocalProjectService(store, () => randomId.next(), (docId) => {
  reviewService.watchDocument(docId);
  ensureSubscription(docId);
});
const sockets = new Map<string, Set<WebSocket>>();
const socketPrincipals = new Map<string, Map<WebSocket, string>>();
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
function principal(id: string): PrincipalRecord | undefined {
  const value = store.principals().find((item) => item.id === id);
  return value;
}
function roleFor(docId: string, principalId: string): Role | null { return store.role(docId, principalId); }
function workspaceRoleFor(workspaceId: string, principalId: string): Role | null { return store.workspaceRole(workspaceId, principalId); }
function canManageAgent(docId: string, principalId: string, agentId: string): boolean {
  const role = roleFor(docId, principalId);
  const agent = principal(agentId);
  if (!role || !agent || agent.kind !== 'agent') return false;
  return canManageAgentPermission(role, principalId, agent.ownerId);
}
function agentVisible(docId: string, viewerId: string, agentId: string): boolean {
  const agent = principal(agentId);
  if (!agent || agent.kind !== 'agent') return false;
  const config = agentRuntime?.config(docId, agentId);
  if (config?.accessPolicy !== 'private') return true;
  const viewerRole = roleFor(docId, viewerId);
  return viewerRole !== null && canSeeAgent('private', viewerId, agent.ownerId, viewerRole);
}
function visibleMembers(docId: string, viewerId: string): Array<Principal & { role: Role }> {
  return store.members(docId).filter((member) => member.kind !== 'agent' || agentVisible(docId, viewerId, member.id));
}
function broadcastOnlineMembers(docId: string): void {
  const group = sockets.get(docId);
  const identities = socketPrincipals.get(docId);
  if (!group || !identities) return;
  const onlineIds = new Set(identities.values());
  for (const [socket, viewerId] of identities) {
    if (socket.readyState !== socket.OPEN) continue;
    const members = visibleMembers(docId, viewerId).filter((member) => onlineIds.has(member.id));
    json(socket, { type: 'members', members });
  }
}
function outline(text: string): Array<{ index: number; title: string; start: number; end: number }> {
  const result: Array<{ index: number; title: string; start: number; end: number }> = [];
  let start = 0;
  for (const [index, paragraph] of text.split(/\n{2,}/u).entries()) {
    const title = paragraph.split('\n')[0]?.trim().slice(0, 80) ?? '';
    const end = start + paragraph.length;
    if (title) result.push({ index, title, start, end });
    start = end + 2;
  }
  return result;
}
function agentConfigFromInput(principalId: string, input: {
  adapter: { type: 'mock' } | { type: 'openai-compatible'; baseUrl: string; apiKeyEnv: string; model: string } | { type: 'openai-responses'; baseUrl: string; accessTokenEnv: string; model: string; profileId?: string; ownerPrincipalId?: string } | { type: 'cli'; command: string; args?: string[] | undefined; timeoutMs?: number | undefined; includeSystemInPrompt?: boolean | undefined };
  grantedRole: Role;
  contextStrategy: AgentConfig['contextStrategy'];
  accessPolicy?: AgentConfig['accessPolicy'];
}): AgentConfig {
  let adapter: AdapterConfig;
  if (input.adapter.type === 'mock') adapter = { type: 'mock' };
  else if (input.adapter.type === 'openai-compatible') adapter = { type: 'openai-compatible', baseUrl: input.adapter.baseUrl, apiKeyEnv: input.adapter.apiKeyEnv, model: input.adapter.model };
  else if (input.adapter.type === 'openai-responses') adapter = { type: 'openai-responses', baseUrl: input.adapter.baseUrl, accessTokenEnv: input.adapter.accessTokenEnv, model: input.adapter.model, ...(input.adapter.profileId === undefined ? {} : { profileId: input.adapter.profileId }), ...(input.adapter.ownerPrincipalId === undefined ? {} : { ownerPrincipalId: input.adapter.ownerPrincipalId }) };
  else adapter = {
    type: 'cli',
    command: input.adapter.command,
    ...(input.adapter.args === undefined ? {} : { args: input.adapter.args }),
    ...(input.adapter.timeoutMs === undefined ? {} : { timeoutMs: input.adapter.timeoutMs }),
    ...(input.adapter.includeSystemInPrompt === undefined ? {} : { includeSystemInPrompt: input.adapter.includeSystemInPrompt }),
  };
  return { principalId, adapter, grantedRole: input.grantedRole, contextStrategy: input.contextStrategy, accessPolicy: input.accessPolicy ?? 'public' };
}
function publicAgentConfig(config: AgentConfig): AgentConfig & { sessionOnly?: boolean } {
  if (config.adapter.type === 'openai-compatible' && config.adapter.apiKeyEnv === '__COLLAB_SESSION_API_KEY__') {
    return { ...config, adapter: { ...config.adapter, apiKeyEnv: 'session' }, sessionOnly: true };
  }
  if (config.adapter.type === 'openai-responses' && config.adapter.accessTokenEnv === '__COLLAB_CHATGPT_ACCESS_TOKEN__') {
    return { ...config, adapter: { ...config.adapter, accessTokenEnv: 'session' }, sessionOnly: true };
  }
  return config;
}
function fail(reply: { code: (status: number) => { send: (value: unknown) => unknown } }, status: number, code: string, message: string): unknown {
  return reply.code(status).send({ error: { code, message } });
}
const sessionCookieName = 'collab_session';
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const allowLegacyIdentityHeader = process.env.COLLAB_DEV_AUTH_BYPASS === '1';
function cookieValue(cookieHeader: string | string[] | undefined, name: string): string | undefined {
  const value = Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader;
  if (!value) return undefined;
  for (const part of value.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}
function sessionHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
function passwordHash(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `scrypt$16384$8$1$${salt}$${derived}`;
}
function passwordMatches(password: string, encoded: string): boolean {
  const [algorithm, nText, rText, pText, salt, expectedHex] = encoded.split('$');
  if (algorithm !== 'scrypt' || nText !== '16384' || rText !== '8' || pText !== '1' || !salt || !expectedHex) return false;
  try {
    const expected = Buffer.from(expectedHex, 'hex');
    const actual = scryptSync(password, salt, expected.length, { N: Number(nText), r: Number(rText), p: Number(pText) });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch { return false; }
}
function principalIdFromHeaders(headers: IncomingHttpHeaders): string {
  const token = cookieValue(headers.cookie, sessionCookieName);
  if (token) {
    const sessionPrincipalId = store.principalIdForAuthSession(sessionHash(token), Date.now());
    if (sessionPrincipalId) return sessionPrincipalId;
  }
  if (allowLegacyIdentityHeader) {
    const legacy = headers['x-principal-id'];
    return Array.isArray(legacy) ? legacy[0] ?? '' : legacy ?? '';
  }
  return '';
}
function principalIdFromIncoming(request: IncomingMessage, fallback = ''): string {
  const fromCookie = principalIdFromHeaders(request.headers);
  if (fromCookie) return fromCookie;
  return allowLegacyIdentityHeader ? fallback : '';
}
function setSessionCookie(reply: { header: (name: string, value: string) => unknown }, token: string): void {
  reply.header('Set-Cookie', `${sessionCookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(sessionLifetimeMs / 1000)}`);
}
function clearSessionCookie(reply: { header: (name: string, value: string) => unknown }): void {
  reply.header('Set-Cookie', `${sessionCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}
function createSession(principalId: string, reply: { header: (name: string, value: string) => unknown }): { principalId: string; expiresAt: number } {
  const token = randomBytes(32).toString('base64url');
  const createdAt = Date.now();
  const expiresAt = createdAt + sessionLifetimeMs;
  store.createAuthSession(sessionHash(token), principalId, createdAt, expiresAt);
  setSessionCookie(reply, token);
  return { principalId, expiresAt };
}
function authResponse(principalValue: PrincipalRecord, session: { principalId: string; expiresAt: number }): unknown {
  return { principal: principalValue, session: { principalId: session.principalId, transport: 'cookie' as const, expiresAt: session.expiresAt } };
}
function authenticateAccount(identifier: string, password: string): PrincipalRecord | undefined {
  const account = store.humanPrincipalByIdentifier(identifier);
  const credential = account === undefined ? undefined : store.principalPasswordHash(account.id);
  if (!account || !credential || !passwordMatches(password, credential)) return undefined;
  return account;
}
function json(ws: WebSocket, value: unknown): void { ws.send(JSON.stringify(value)); }
function ensureSubscription(docId: string): void {
  if (subscriptions.has(docId)) return;
  const record = store.get(docId); if (!record) return;
  subscriptions.add(docId);
  record.handle.subscribe(({ update, origin }) => {
    store.persistUpdate(docId, update);
    localProject.onDocumentUpdate(docId, origin);
    eventBus.publish({ type: 'document.changed', docId, occurredAt: systemClock.now(), data: { source: origin === undefined ? 'server' : 'client' } });
    const payload = JSON.stringify({ type: 'sync', update: Buffer.from(update).toString('base64') });
    for (const socket of sockets.get(docId) ?? []) if (socket !== origin && socket.readyState === socket.OPEN) socket.send(payload);
  });
}
for (const doc of store.list()) {
  reviewService.watchDocument(doc.id);
  ensureSubscription(doc.id);
}
app.post('/api/auth/register', async (request, reply) => {
  const parsed = registerPrincipalSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  const handle = parsed.data.handle.trim().toLocaleLowerCase();
  const email = parsed.data.email?.trim().toLocaleLowerCase();
  const existing = store.humanPrincipalByHandle(handle);
  if (existing && store.principalPasswordHash(existing.id) !== undefined) return fail(reply, 409, 'account-handle-taken', 'Account handle is already registered');
  if (!existing && store.principalHandleTaken(handle)) return fail(reply, 409, 'account-handle-taken', 'Account handle is already registered');
  if (email !== undefined && store.principalEmailTaken(email, existing?.id)) return fail(reply, 409, 'account-email-taken', 'Account email is already registered');
  if (existing) {
    const claimed: PrincipalRecord = { ...existing, displayName: parsed.data.displayName, handle, ...(email === undefined ? {} : { email }) };
    store.upsertPrincipal(claimed);
    store.setPrincipalPasswordHash(existing.id, passwordHash(parsed.data.password));
    return reply.code(201).send(authResponse(claimed, createSession(existing.id, reply)));
  }
  const id = `human-${randomId.next().slice(0, 12)}`;
  const value: PrincipalRecord = { id, kind: 'human', displayName: parsed.data.displayName, handle, ...(email === undefined ? {} : { email }) };
  store.upsertPrincipal(value);
  store.setPrincipalPasswordHash(id, passwordHash(parsed.data.password));
  const session = createSession(id, reply);
  return reply.code(201).send(authResponse(value, session));
});
app.post('/api/auth/login', async (request, reply) => {
  const parsed = authLoginSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  const account = authenticateAccount(parsed.data.identifier, parsed.data.password);
  if (!account) return fail(reply, 401, 'invalid-credentials', 'Invalid account identifier or password');
  const session = createSession(account.id, reply);
  return authResponse(account, session);
});
app.post('/api/auth/switch', async (request, reply) => {
  const parsed = authLoginSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  const account = authenticateAccount(parsed.data.identifier, parsed.data.password);
  if (!account) return fail(reply, 401, 'invalid-credentials', 'Invalid account identifier or password');
  // A switch replaces the current browser cookie while leaving other device
  // sessions valid, so a locally saved account can be restored directly.
  const session = createSession(account.id, reply);
  return authResponse(account, session);
});
app.get('/api/auth/session', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const current = principalId ? principal(principalId) : undefined;
  if (!current || current.kind !== 'human') {
    if (cookieValue(request.headers.cookie, sessionCookieName)) clearSessionCookie(reply);
    return { authenticated: false, principal: null, session: null };
  }
  const token = cookieValue(request.headers.cookie, sessionCookieName);
  const storedSession = token === undefined ? undefined : store.authSession(sessionHash(token), Date.now());
  return {
    authenticated: true,
    principal: current,
    session: {
      principalId: current.id,
      ...(storedSession === undefined ? {} : { expiresAt: storedSession.expiresAt }),
      transport: token ? 'cookie' as const : 'legacy-header' as const,
    },
  };
});
app.post('/api/auth/logout', async (request, reply) => {
  const token = cookieValue(request.headers.cookie, sessionCookieName);
  if (token) store.revokeAuthSession(sessionHash(token));
  clearSessionCookie(reply);
  return { ok: true, authenticated: false, session: null };
});
app.post('/api/auth/chatgpt/start', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const current = principal(principalId);
  if (!current || current.kind !== 'human') return fail(reply, 401, 'authentication-required', 'A registered human account is required');
  const body = typeof request.body === 'object' && request.body !== null ? request.body as Record<string, unknown> : {};
  const profileId = typeof body.profileId === 'string' && body.profileId.length > 0 ? body.profileId : undefined;
  try {
    return await chatgptOAuth.begin(principalId, profileId);
  } catch (error) {
    return fail(reply, 500, 'oauth-start-failed', error instanceof Error ? error.message : 'Unable to start ChatGPT authorization');
  }
});
app.get('/api/auth/chatgpt/callback', async (request, reply) => {
  const query = typeof request.query === 'object' && request.query !== null ? request.query as Record<string, unknown> : {};
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (typeof value === 'string') values.set(key, value);
  try {
    await chatgptOAuth.complete(values);
    const target = process.env.COLLAB_WEB_ORIGIN ?? 'http://localhost:5173/';
    return reply.redirect(`${target}?chatgpt_oauth=success`);
  } catch (error) {
    const code = oauthRedirectCode(error);
    request.log.error({ code, message: error instanceof Error ? error.message : String(error) }, 'ChatGPT OAuth callback failed');
    const target = process.env.COLLAB_WEB_ORIGIN ?? 'http://localhost:5173/';
    return reply.redirect(`${target}?chatgpt_oauth=error&code=${encodeURIComponent(code)}`);
  }
});
app.get<{ Params: { attemptId: string } }>('/api/auth/chatgpt/attempts/:attemptId', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const result = chatgptOAuth.attempt(request.params.attemptId, principalId);
  if (!result) return fail(reply, 404, 'oauth-attempt-not-found', 'Authorization attempt was not found');
  return result;
});
app.get('/api/auth/chatgpt/profiles', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const current = principal(principalId);
  if (!current || current.kind !== 'human') return fail(reply, 401, 'authentication-required', 'A registered human account is required');
  return await chatgptOAuth.profiles(principalId);
});
app.delete<{ Params: { profileId: string } }>('/api/auth/chatgpt/profiles/:profileId', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const current = principal(principalId);
  if (!current || current.kind !== 'human') return fail(reply, 401, 'authentication-required', 'A registered human account is required');
  try {
    await chatgptOAuth.revoke(principalId, request.params.profileId);
    return { ok: true };
  } catch (error) {
    const code = error instanceof ChatGPTOAuthError ? error.code : 'oauth-revoke-failed';
    return fail(reply, 502, code, 'Unable to revoke the ChatGPT connection');
  }
});
app.get('/api/principals', async (request, reply) => {
  const viewerId = principalIdFromHeaders(request.headers);
  const viewer = principal(viewerId);
  if (!viewer || viewer.kind !== 'human') return fail(reply, 403, 'permission-denied', 'A registered human principal is required');
  return store.principals()
    .filter((item) => item.kind === 'human' || store.list().some((doc) => roleFor(doc.id, viewerId) !== null && agentVisible(doc.id, viewerId, item.id)))
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      displayName: item.displayName,
      ...(item.ownerId === undefined ? {} : { ownerId: item.ownerId }),
      ...(item.handle === undefined ? {} : { handle: item.handle }),
    }));
});
app.post('/api/principals', async (request, reply) => {
  if (!allowLegacyIdentityHeader) return fail(reply, 410, 'legacy-endpoint-disabled', 'Use /api/auth/register for account creation');
  const parsed = registerPrincipalSchema.omit({ password: true }).safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  const id = `human-${randomId.next().slice(0, 12)}`;
  const requestedHandle = parsed.data.handle?.trim().toLocaleLowerCase();
  const handle = requestedHandle ?? `user-${id.slice(-8).toLocaleLowerCase()}`;
  if (store.principalHandleTaken(handle)) return fail(reply, 409, 'account-handle-taken', 'Account handle is already registered');
  const email = parsed.data.email?.trim().toLocaleLowerCase();
  if (email !== undefined && store.principalEmailTaken(email)) return fail(reply, 409, 'account-email-taken', 'Account email is already registered');
  const value: PrincipalRecord = { id, kind: 'human', displayName: parsed.data.displayName, handle, ...(email === undefined ? {} : { email }) };
  store.upsertPrincipal(value);
  return value;
});
app.get('/api/accounts/search', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const target = principal(principalId);
  if (!target || target.kind !== 'human') return fail(reply, 403, 'permission-denied', 'A registered human principal is required');
  const query = typeof request.query === 'object' && request.query !== null && 'q' in request.query
    ? String((request.query as { q?: unknown }).q ?? '')
    : '';
  if (query.trim().length < 1) return [];
  return store.searchHumanPrincipals(query);
});
app.get('/api/account', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const current = principal(principalId);
  if (!current || current.kind !== 'human') return fail(reply, 403, 'permission-denied', 'A registered human principal is required');
  const workspaces = store.workspaces(principalId).map((workspace) => ({
    id: workspace.id,
    title: workspace.title,
    role: workspaceRoleFor(workspace.id, principalId),
  }));
  return {
    principal: current,
    workspaces,
    pendingInvitationCount: store.pendingWorkspaceInvitations(principalId).length,
    session: { principalId, transport: cookieValue(request.headers.cookie, sessionCookieName) ? 'cookie' as const : 'legacy-header' as const },
  };
});
app.patch('/api/account', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const current = principal(principalId);
  if (!current || current.kind !== 'human') return fail(reply, 403, 'permission-denied', 'A registered human principal is required');
  const parsed = updateAccountSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  const requestedHandle = parsed.data.handle?.trim().toLocaleLowerCase();
  if (requestedHandle !== undefined && store.principalHandleTaken(requestedHandle, principalId)) return fail(reply, 409, 'account-handle-taken', 'Account handle is already registered');
  const email = parsed.data.email?.trim().toLocaleLowerCase();
  if (email !== undefined && store.principalEmailTaken(email, principalId)) return fail(reply, 409, 'account-email-taken', 'Account email is already registered');
  const updated = store.updatePrincipalProfile(principalId, parsed.data.displayName, requestedHandle, email);
  if (!updated) return fail(reply, 404, 'principal-not-found', 'Principal was not found');
  return updated;
});
app.post('/api/account/switch', async (request, reply) => {
  if (!allowLegacyIdentityHeader) return fail(reply, 410, 'legacy-endpoint-disabled', 'Use /api/auth/login for account sessions');
  const parsed = switchAccountSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  const selected = principal(parsed.data.principalId);
  if (!selected || selected.kind !== 'human') return fail(reply, 404, 'principal-not-found', 'A registered human principal is required');
  const previousPrincipalId = principalIdFromHeaders(request.headers);
  return {
    principal: selected,
    previousPrincipalId: previousPrincipalId || undefined,
    session: { principalId: selected.id, transport: 'x-principal-id' as const },
  };
});
app.post('/api/account/logout', async (request, reply) => {
  const token = cookieValue(request.headers.cookie, sessionCookieName);
  if (token) store.revokeAuthSession(sessionHash(token));
  clearSessionCookie(reply);
  return { ok: true, session: null };
});
app.get('/api/model-providers', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const current = principal(principalId);
  if (!current || current.kind !== 'human') return fail(reply, 401, 'authentication-required', 'A human account is required');
  try {
    return { providers: await modelProviders.list(principalId) };
  } catch (error) {
    return fail(reply, 502, 'provider-status-failed', error instanceof Error ? error.message : 'Unable to inspect model providers');
  }
});
app.post<{ Params: { providerId: string } }>('/api/model-providers/:providerId/connect', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const current = principal(principalId);
  if (!current || current.kind !== 'human') return fail(reply, 401, 'authentication-required', 'A human account is required');
  const providerId = modelProviderIdSchema.safeParse(request.params.providerId);
  if (!providerId.success) return fail(reply, 404, 'provider-not-found', 'Unknown model provider');
  const parsed = modelProviderConnectSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  const card = modelProviders.connectApiKey(principalId, providerId.data, {
    apiKey: parsed.data.apiKey,
    model: parsed.data.model,
    ...(parsed.data.baseUrl === undefined ? {} : { baseUrl: parsed.data.baseUrl }),
  });
  if (!card) return fail(reply, 400, 'provider-not-connectable', 'This provider is managed by the local CLI and does not accept an API key');
  return { provider: card, keyStored: false, sessionOnly: true };
});
app.delete<{ Params: { providerId: string } }>('/api/model-providers/:providerId', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const current = principal(principalId);
  if (!current || current.kind !== 'human') return fail(reply, 401, 'authentication-required', 'A human account is required');
  const providerId = modelProviderIdSchema.safeParse(request.params.providerId);
  if (!providerId.success) return fail(reply, 404, 'provider-not-found', 'Unknown model provider');
  return { ok: modelProviders.disconnect(principalId, providerId.data) };
});
app.get<{ Params: { providerId: string } }>('/api/model-providers/:providerId/models', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const current = principal(principalId);
  if (!current || current.kind !== 'human') return fail(reply, 401, 'authentication-required', 'A human account is required');
  const providerId = modelProviderIdSchema.safeParse(request.params.providerId);
  if (!providerId.success) return fail(reply, 404, 'provider-not-found', 'Unknown model provider');
  try {
    return { models: await modelProviders.models(principalId, providerId.data) };
  } catch (error) {
    return fail(reply, 502, 'provider-models-failed', error instanceof Error ? error.message : 'Unable to list provider models');
  }
});
app.get('/api/agent-providers', async () => inspectCliProviders());
app.get('/api/integrations/chatgpt/status', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const current = principal(principalId);
  if (!current || current.kind !== 'human') return fail(reply, 401, 'authentication-required', 'A human account is required');
  try {
    const profiles = await chatgptOAuth.profiles(principalId);
    const profile = profiles[0];
    if (!profile) return { state: 'disconnected', scopes: [] };
    return {
      state: 'connected',
      profileId: profile.profileId,
      accountEmail: profile.email,
      scopes: profile.scopes,
      plan: profile.planUsageEnabled ? 'ChatGPT plan usage enabled' : undefined,
      expiresAt: profile.expiresAt,
    };
  } catch (error) {
    const message = error instanceof ChatGPTOAuthError ? error.message : 'Unable to read ChatGPT authorization';
    return { state: 'error', scopes: [], message };
  }
});
app.get<{ Querystring: { profileId?: string } }>('/api/integrations/chatgpt/models', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const current = principal(principalId);
  if (!current || current.kind !== 'human') return fail(reply, 401, 'authentication-required', 'A human account is required');
  const profileId = request.query.profileId;
  if (!profileId) return fail(reply, 400, 'invalid-request', 'profileId is required');
  try {
    return { models: await chatgptOAuth.models(principalId, profileId) };
  } catch (error) {
    const code = error instanceof ChatGPTOAuthError ? error.code : 'oauth-models-failed';
    return fail(reply, 502, code, 'Unable to list models for the ChatGPT account');
  }
});
app.post('/api/integrations/chatgpt/oauth/start', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const current = principal(principalId);
  if (!current || current.kind !== 'human') return fail(reply, 401, 'authentication-required', 'A human account is required');
  try {
    return await chatgptOAuth.begin(principalId);
  } catch (error) {
    const message = error instanceof ChatGPTOAuthError ? error.message : 'Unable to start ChatGPT authorization';
    return fail(reply, 503, 'oauth-unavailable', message);
  }
});
app.post('/api/integrations/chatgpt/disconnect', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const current = principal(principalId);
  if (!current || current.kind !== 'human') return fail(reply, 401, 'authentication-required', 'A human account is required');
  try {
    const profiles = await chatgptOAuth.profiles(principalId);
    for (const profile of profiles) await chatgptOAuth.revoke(principalId, profile.profileId);
    return { ok: true };
  } catch (error) {
    const message = error instanceof ChatGPTOAuthError ? error.message : 'Unable to disconnect ChatGPT authorization';
    return fail(reply, 502, 'oauth-disconnect-failed', message);
  }
});
app.get('/api/workspaces', async (request) => {
  const principalId = principalIdFromHeaders(request.headers);
  return store.workspaces(principalId).map((workspace) => {
    const role = workspaceRoleFor(workspace.id, principalId);
    return {
      id: workspace.id,
      title: workspace.title,
      createdBy: workspace.createdBy,
      createdAt: workspace.createdAt,
      source: workspace.source,
      ...(workspace.rootPath !== undefined && role !== null && can(role, 'manage') ? { rootPath: workspace.rootPath } : {}),
      role,
      documents: store.list().filter((doc) => doc.workspaceId === workspace.id && roleFor(doc.id, principalId) !== null),
    };
  });
});
app.post('/api/workspaces', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  if (!principal(principalId) || principal(principalId)?.kind !== 'human') return fail(reply, 403, 'permission-denied', 'A human principal is required');
  const parsed = createWorkspaceSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  const id = `space-${randomId.next().slice(0, 12)}`;
  return store.createWorkspace(id, parsed.data.title, principalId);
});
app.patch<{ Params: { id: string } }>('/api/workspaces/:id', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const workspace = store.workspace(request.params.id);
  if (!workspace) return fail(reply, 404, 'workspace-not-found', 'Workspace was not found');
  const role = workspaceRoleFor(request.params.id, principalId);
  if (!role || !can(role, 'manage')) return fail(reply, 403, 'permission-denied', 'Workspace owner role is required');
  const parsed = updateWorkspaceSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  const updated = store.updateWorkspaceTitle(request.params.id, parsed.data.title);
  if (!updated) return fail(reply, 404, 'workspace-not-found', 'Workspace was not found');
  return { ...updated, role };
});
app.delete<{ Params: { id: string } }>('/api/workspaces/:id', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const workspace = store.workspace(request.params.id);
  if (!workspace) return fail(reply, 404, 'workspace-not-found', 'Workspace was not found');
  const role = workspaceRoleFor(request.params.id, principalId);
  if (!role || !can(role, 'manage')) return fail(reply, 403, 'permission-denied', 'Workspace owner role is required');
  const parsed = deleteWorkspaceSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  if (parsed.data.confirmTitle !== workspace.title) return fail(reply, 409, 'delete-confirmation-mismatch', 'The workspace title confirmation does not match');
  if (!store.deleteWorkspace(workspace.id)) return fail(reply, 404, 'workspace-not-found', 'Workspace was not found');
  return { ok: true, workspaceId: workspace.id };
});
app.get<{ Params: { id: string } }>('/api/workspaces/:id', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const workspace = store.workspace(request.params.id);
  const role = workspaceRoleFor(request.params.id, principalId);
  if (!workspace || !role) return fail(reply, 404, 'workspace-not-found', 'Workspace was not found');
  const localStatus = localProject.status(workspace.id);
  return {
    id: workspace.id,
    title: workspace.title,
    createdBy: workspace.createdBy,
    createdAt: workspace.createdAt,
    source: workspace.source,
    ...(workspace.rootPath !== undefined && can(role, 'manage') ? { rootPath: workspace.rootPath } : {}),
    role,
    members: store.workspaceMembers(workspace.id).filter((member) => member.kind !== 'agent' || store.list().some((doc) => doc.workspaceId === workspace.id && agentVisible(doc.id, principalId, member.id))),
    documents: store.list().filter((doc) => doc.workspaceId === workspace.id),
    localProject: can(role, 'manage') ? localStatus : { ...localStatus, path: undefined },
  };
});
app.post<{ Params: { id: string } }>('/api/workspaces/:id/invitations', async (request, reply) => {
  const inviterId = principalIdFromHeaders(request.headers);
  const role = workspaceRoleFor(request.params.id, inviterId);
  if (!role || !can(role, 'manage')) return fail(reply, 403, 'permission-denied', 'Workspace owner role is required');
  if (!store.workspace(request.params.id)) return fail(reply, 404, 'workspace-not-found', 'Workspace was not found');
  const parsed = workspaceInvitationSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  const invitee = parsed.data.identifier === undefined
    ? principal(parsed.data.principalId ?? '')
    : store.humanPrincipalByIdentifier(parsed.data.identifier);
  if (!invitee || invitee.kind !== 'human') return fail(reply, 404, 'principal-not-found', 'A registered human principal is required');
  if (invitee.id === inviterId) return fail(reply, 400, 'invalid-request', 'You are already a workspace member');
  if (workspaceRoleFor(request.params.id, invitee.id) !== null) return fail(reply, 409, 'already-member', 'Principal is already a workspace member');
  const invitation = store.createWorkspaceInvitation(`invite-${randomId.next().slice(0, 12)}`, request.params.id, invitee.id, parsed.data.role, inviterId);
  return { ...invitation, workspace: store.workspace(request.params.id), invitee };
});
app.get('/api/invitations', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const target = principal(principalId);
  if (!target || target.kind !== 'human') return fail(reply, 403, 'permission-denied', 'A registered human principal is required');
  return store.pendingWorkspaceInvitations(principalId).flatMap((invitation) => {
    const workspace = store.workspace(invitation.workspaceId);
    const inviter = principal(invitation.invitedBy);
    return workspace === undefined ? [] : [{ ...invitation, workspace, inviter }];
  });
});
app.get<{ Params: { id: string } }>('/api/workspaces/:id/invitations', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const role = workspaceRoleFor(request.params.id, principalId);
  if (!role || !can(role, 'manage')) return fail(reply, 403, 'permission-denied', 'Workspace owner role is required');
  if (!store.workspace(request.params.id)) return fail(reply, 404, 'workspace-not-found', 'Workspace was not found');
  return store.workspaceInvitations(request.params.id).map((invitation) => ({
    ...invitation,
    invitee: principal(invitation.principalId),
    inviter: principal(invitation.invitedBy),
  }));
});
app.post<{ Params: { id: string } }>('/api/invitations/:id/accept', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const target = principal(principalId);
  if (!target || target.kind !== 'human') return fail(reply, 403, 'permission-denied', 'A registered human principal is required');
  const invitation = store.acceptWorkspaceInvitation(request.params.id, principalId);
  if (!invitation) return fail(reply, 404, 'invitation-not-found', 'Pending invitation was not found for this principal');
  return { invitation, workspace: store.workspace(invitation.workspaceId), membership: { workspaceId: invitation.workspaceId, principalId, role: invitation.role } };
});
app.post<{ Params: { id: string } }>('/api/invitations/:id/reject', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const target = principal(principalId);
  if (!target || target.kind !== 'human') return fail(reply, 403, 'permission-denied', 'A registered human principal is required');
  const invitation = store.rejectWorkspaceInvitation(request.params.id, principalId);
  if (!invitation) return fail(reply, 404, 'invitation-not-found', 'Pending invitation was not found for this principal');
  return { invitation };
});
app.post<{ Params: { id: string } }>('/api/workspaces/:id/local-project', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const role = workspaceRoleFor(request.params.id, principalId);
  if (!role || !can(role, 'manage')) return fail(reply, 403, 'permission-denied', 'Workspace owner role is required');
  if (!store.workspace(request.params.id)) return fail(reply, 404, 'workspace-not-found', 'Workspace was not found');
  const parsed = localProjectBindSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  try {
    return localProject.bind(request.params.id, parsed.data);
  } catch (error) {
    return fail(reply, 400, 'local-project-invalid', error instanceof Error ? error.message : String(error));
  }
});
app.get<{ Params: { id: string } }>('/api/workspaces/:id/local-project', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const role = workspaceRoleFor(request.params.id, principalId);
  if (!role || !can(role, 'view')) return fail(reply, 403, 'permission-denied', 'Membership is required');
  if (!store.workspace(request.params.id)) return fail(reply, 404, 'workspace-not-found', 'Workspace was not found');
  const status = localProject.status(request.params.id);
  return can(role, 'manage') ? status : { ...status, path: undefined };
});
app.post<{ Params: { id: string } }>('/api/workspaces/:id/local-project/scan', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const role = workspaceRoleFor(request.params.id, principalId);
  if (!role || !can(role, 'edit')) return fail(reply, 403, 'permission-denied', 'Editor role is required');
  try {
    return localProject.scan(request.params.id);
  } catch (error) {
    return fail(reply, 400, 'local-project-scan-failed', error instanceof Error ? error.message : String(error));
  }
});
app.post<{ Params: { id: string } }>('/api/workspaces/:id/documents', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const role = workspaceRoleFor(request.params.id, principalId);
  if (!role || !can(role, 'edit')) return fail(reply, 403, 'permission-denied', 'Editor role is required');
  if (!store.workspace(request.params.id)) return fail(reply, 404, 'workspace-not-found', 'Workspace was not found');
  const parsed = createDocumentSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  const id = `doc-${randomId.next().slice(0, 12)}`;
  const record = store.create(id, parsed.data.title, parsed.data.text, [], request.params.id);
  return { id: record.id, title: record.title, workspaceId: record.workspaceId, text: record.handle.getText() };
});
app.post<{ Params: { id: string } }>('/api/workspaces/:id/members', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const role = workspaceRoleFor(request.params.id, principalId);
  if (!role || !can(role, 'manage')) return fail(reply, 403, 'permission-denied', 'Workspace owner role is required');
  if (!store.workspace(request.params.id)) return fail(reply, 404, 'workspace-not-found', 'Workspace was not found');
  const parsed = workspaceMemberSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  if (!principal(parsed.data.principalId)) return fail(reply, 404, 'principal-not-found', 'Principal was not found');
  if (roleRank(parsed.data.role) > roleRank(role)) return fail(reply, 400, 'invalid-role', 'Granted role cannot exceed the inviter role');
  store.setWorkspaceMembership({ workspaceId: request.params.id, principalId: parsed.data.principalId, role: parsed.data.role });
  return store.workspaceMembers(request.params.id).find((member) => member.id === parsed.data.principalId);
});
app.put<{ Params: { id: string; principalId: string } }>('/api/workspaces/:id/members/:principalId', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const role = workspaceRoleFor(request.params.id, principalId);
  if (!role || !can(role, 'manage')) return fail(reply, 403, 'permission-denied', 'Workspace owner role is required');
  const parsed = workspaceMemberSchema.safeParse({ ...(request.body as object), principalId: request.params.principalId });
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  if (!store.workspace(request.params.id) || !principal(parsed.data.principalId)) return fail(reply, 404, 'not-found', 'Workspace or principal was not found');
  if (roleRank(parsed.data.role) > roleRank(role)) return fail(reply, 400, 'invalid-role', 'Granted role cannot exceed the updater role');
  store.setWorkspaceMembership({ workspaceId: request.params.id, principalId: parsed.data.principalId, role: parsed.data.role });
  return store.workspaceMembers(request.params.id).find((member) => member.id === parsed.data.principalId);
});
app.delete<{ Params: { id: string; principalId: string } }>('/api/workspaces/:id/members/:principalId', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const role = workspaceRoleFor(request.params.id, principalId);
  if (!role || !can(role, 'manage')) return fail(reply, 403, 'permission-denied', 'Workspace owner role is required');
  if (request.params.principalId === principalId) return fail(reply, 400, 'invalid-request', 'Owners cannot remove themselves');
  if (!store.workspace(request.params.id) || !workspaceRoleFor(request.params.id, request.params.principalId)) return fail(reply, 404, 'member-not-found', 'Workspace member was not found');
  store.removeWorkspaceMembership(request.params.id, request.params.principalId);
  return { ok: true };
});
app.post('/api/docs', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const parsed = createDocumentSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  let workspaceId = parsed.data.workspaceId;
  if (workspaceId === undefined) {
    if (!principal(principalId)) return fail(reply, 403, 'permission-denied', 'A known principal is required');
    workspaceId = `space-${randomId.next().slice(0, 12)}`;
    store.createWorkspace(workspaceId, `${parsed.data.title} 空间`, principalId);
  }
  const role = workspaceRoleFor(workspaceId, principalId);
  if (!role || !can(role, 'edit')) return fail(reply, 403, 'permission-denied', 'Editor role is required');
  const id = `doc-${randomId.next().slice(0, 12)}`;
  const record = store.create(id, parsed.data.title, parsed.data.text, [], workspaceId);
  reviewService.watchDocument(id);
  ensureSubscription(id);
  return { id: record.id, title: record.title, workspaceId, text: record.handle.getText() };
});
app.get('/api/docs', async (request) => {
  const principal = principalIdFromHeaders(request.headers);
  return store.list().filter((doc) => store.role(doc.id, principal));
});
app.get<{ Params: { id: string } }>('/api/docs/:id', async (request, reply) => {
  const principal = principalIdFromHeaders(request.headers);
  const record = store.get(request.params.id); if (!record || !store.role(record.id, principal)) return reply.code(404).send({ error: 'not-found' });
  const text = record.handle.getText();
  return { id: record.id, title: record.title, workspaceId: record.workspaceId, text, outline: outline(text), members: visibleMembers(record.id, principal) };
});
app.get<{ Params: { id: string } }>('/api/docs/:id/outline', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const record = store.get(request.params.id);
  if (!record || !roleFor(record.id, principalId)) return fail(reply, 404, 'not-found', 'Document was not found');
  return outline(record.handle.getText());
});
app.post<{ Params: { id: string } }>('/api/docs/:id/local-project/sync', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const role = roleFor(request.params.id, principalId);
  if (!role || !can(role, 'edit')) return fail(reply, 403, 'permission-denied', 'Editor role is required');
  const parsed = localProjectSyncSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  let result: LocalProjectFile | undefined;
  try {
    result = localProject.syncDocument(request.params.id, parsed.data.text);
  } catch (error) {
    return fail(reply, 409, 'local-project-sync-failed', error instanceof Error ? error.message : String(error));
  }
  if (!result) return fail(reply, 404, 'local-project-document-not-found', 'Document is not mapped to a local project file');
  return { ok: result.status === 'synced' || result.status === 'updated', file: result };
});
app.get<{ Params: { id: string } }>('/api/docs/:id/threads', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const role = roleFor(request.params.id, principalId);
  if (!role || !can(role, 'view')) return fail(reply, 403, 'permission-denied', 'Membership is required');
  return reviewStore.listThreads(request.params.id).map((thread) => ({ ...thread, messages: reviewStore.listMessages(thread.id) }));
});
app.get<{ Params: { id: string } }>('/api/docs/:id/suggestions', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const role = roleFor(request.params.id, principalId);
  if (!role || !can(role, 'view')) return fail(reply, 403, 'permission-denied', 'Membership is required');
  return reviewStore.listSuggestions(request.params.id);
});
app.get<{ Params: { id: string } }>('/api/docs/:id/agents', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const role = roleFor(request.params.id, principalId);
  if (!role || !can(role, 'view')) return fail(reply, 403, 'permission-denied', 'Membership is required');
  return agentRuntime?.list(request.params.id, principalId) ?? [];
});
app.post<{ Params: { id: string } }>('/api/docs/:id/agents', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const role = roleFor(request.params.id, principalId);
  if (!role || !can(role, 'comment')) return fail(reply, 403, 'permission-denied', 'Commenter role is required to add an agent');
  if (!store.get(request.params.id)) return fail(reply, 404, 'document-not-found', 'Document was not found');
  const parsed = createAgentSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  if (!canInviteAgent(role, parsed.data.grantedRole)) return fail(reply, 400, 'invalid-role', 'Agent role cannot exceed the operator role');
  if (parsed.data.provider === 'openai-compatible' && (!parsed.data.baseUrl || !parsed.data.model || !parsed.data.apiKey)) {
    return fail(reply, 400, 'invalid-request', 'OpenAI-compatible agents require baseUrl, model and apiKey');
  }
  const agentId = `agent-${randomId.next().slice(0, 12)}`;
  store.upsertPrincipal({ id: agentId, kind: 'agent', displayName: parsed.data.displayName, ownerId: principalId });
  store.setMembership({ docId: request.params.id, principalId: agentId, role: parsed.data.grantedRole });
  const workspaceId = store.workspaceIdForDocument(request.params.id);
  if (workspaceId !== undefined) store.setWorkspaceMembership({ workspaceId, principalId: agentId, role: parsed.data.grantedRole });
  const config = parsed.data.provider === 'mock'
    ? agentRuntime?.configure(request.params.id, {
      principalId: agentId,
      adapter: { type: 'mock' },
      grantedRole: parsed.data.grantedRole,
      contextStrategy: parsed.data.contextStrategy,
      accessPolicy: parsed.data.accessPolicy,
    })
    : agentRuntime?.connectProvider(request.params.id, agentId, {
      provider: parsed.data.provider,
      ...(parsed.data.baseUrl === undefined ? {} : { baseUrl: parsed.data.baseUrl }),
      ...(parsed.data.model === undefined ? {} : { model: parsed.data.model }),
      ...(parsed.data.apiKey === undefined ? {} : { apiKey: parsed.data.apiKey }),
      grantedRole: parsed.data.grantedRole,
      contextStrategy: parsed.data.contextStrategy,
      accessPolicy: parsed.data.accessPolicy,
    });
  if (!config) return fail(reply, 500, 'agent-config-failed', 'Unable to configure the new agent');
  return { principal: store.principals().find((item) => item.id === agentId), config: publicAgentConfig(config) };
});
app.get<{ Params: { id: string; agentId: string } }>('/api/docs/:id/agents/:agentId', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const role = roleFor(request.params.id, principalId);
  if (!role || !can(role, 'view')) return fail(reply, 403, 'permission-denied', 'Membership is required');
  const agent = principal(request.params.agentId);
  if (!agent || agent.kind !== 'agent' || !roleFor(request.params.id, agent.id)) return fail(reply, 404, 'agent-not-found', 'Agent is not a document member');
  if (!agentVisible(request.params.id, principalId, agent.id)) return fail(reply, 404, 'agent-not-found', 'Agent is private');
  const config = agentRuntime?.config(request.params.id, agent.id);
  return publicAgentConfig(config ?? { principalId: agent.id, adapter: { type: 'mock' as const }, grantedRole: roleFor(request.params.id, agent.id) ?? 'suggester', contextStrategy: 'window' as const, accessPolicy: 'public' as const });
});
app.put<{ Params: { id: string; agentId: string } }>('/api/docs/:id/agents/:agentId', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const role = roleFor(request.params.id, principalId);
  if (!role || !canManageAgent(request.params.id, principalId, request.params.agentId)) return fail(reply, 403, 'permission-denied', 'Only the agent owner or document owner can manage this agent');
  const agent = principal(request.params.agentId);
  const memberRole = agent ? roleFor(request.params.id, agent.id) : null;
  if (!agent || agent.kind !== 'agent' || memberRole === null) return fail(reply, 400, 'invalid-agent', 'Agent is not a document member');
  const parsed = agentConfigSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  if (parsed.data.principalId !== undefined && parsed.data.principalId !== agent.id) return fail(reply, 400, 'invalid-agent', 'Configuration principal does not match the path');
  if (roleRank(parsed.data.grantedRole) > roleRank(role)) return fail(reply, 400, 'invalid-role', 'Granted role cannot exceed the operator role');
  store.setMembership({ docId: request.params.id, principalId: agent.id, role: parsed.data.grantedRole });
  const workspaceId = store.workspaceIdForDocument(request.params.id);
  if (workspaceId !== undefined) store.setWorkspaceMembership({ workspaceId, principalId: agent.id, role: parsed.data.grantedRole });
  const config = agentConfigFromInput(agent.id, {
    adapter: parsed.data.adapter as AdapterConfig,
    grantedRole: parsed.data.grantedRole,
    contextStrategy: parsed.data.contextStrategy,
    accessPolicy: parsed.data.accessPolicy,
  });
  agentRuntime?.configure(request.params.id, config);
  return publicAgentConfig(config);
});
app.post<{ Params: { id: string; agentId: string } }>('/api/docs/:id/agents/:agentId/connect', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const role = roleFor(request.params.id, principalId);
  if (!role || !canManageAgent(request.params.id, principalId, request.params.agentId)) return fail(reply, 403, 'permission-denied', 'Only the agent owner or document owner can manage this agent');
  const agent = principal(request.params.agentId);
  const memberRole = agent ? roleFor(request.params.id, agent.id) : null;
  if (!agent || agent.kind !== 'agent' || memberRole === null) return fail(reply, 404, 'agent-not-found', 'Agent is not a document member');
  const parsed = agentProviderConnectSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  const grantedRole = parsed.data.grantedRole ?? memberRole;
  if (roleRank(grantedRole) > roleRank(role)) return fail(reply, 400, 'invalid-role', 'Granted role cannot exceed the operator role');
  store.setMembership({ docId: request.params.id, principalId: agent.id, role: grantedRole });
  const workspaceId = store.workspaceIdForDocument(request.params.id);
  if (workspaceId !== undefined) store.setWorkspaceMembership({ workspaceId, principalId: agent.id, role: grantedRole });
  const sharedConnection = {
    grantedRole,
    ...(parsed.data.contextStrategy === undefined ? {} : { contextStrategy: parsed.data.contextStrategy }),
    ...(parsed.data.accessPolicy === undefined ? {} : { accessPolicy: parsed.data.accessPolicy }),
  };
  const config = parsed.data.provider === 'openai-compatible'
    ? agentRuntime?.connectProvider(request.params.id, agent.id, {
      provider: parsed.data.provider,
      baseUrl: parsed.data.baseUrl,
      model: parsed.data.model,
      apiKey: parsed.data.apiKey,
      ...sharedConnection,
    })
    : agentRuntime?.connectProvider(request.params.id, agent.id, { provider: parsed.data.provider, ...sharedConnection });
  if (!config) return fail(reply, 400, 'invalid-provider', 'Provider connection details are incomplete');
  return { config: publicAgentConfig(config), keyStored: false, sessionOnly: parsed.data.provider === 'openai-compatible' };
});
/** Bind an agent to a provider already connected in the current account. */
app.post<{ Params: { id: string; agentId: string } }>('/api/docs/:id/agents/:agentId/bind-provider', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const role = roleFor(request.params.id, principalId);
  if (!role || !canManageAgent(request.params.id, principalId, request.params.agentId)) return fail(reply, 403, 'permission-denied', 'Only the agent owner or document owner can manage this agent');
  const agent = principal(request.params.agentId);
  const memberRole = agent ? roleFor(request.params.id, agent.id) : null;
  if (!agent || agent.kind !== 'agent' || memberRole === null) return fail(reply, 404, 'agent-not-found', 'Agent is not a document member');
  const parsed = modelProviderBindingSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  const providerId: ModelProviderId = parsed.data.providerId;
  const grantedRole = parsed.data.grantedRole ?? memberRole;
  if (roleRank(grantedRole) > roleRank(role)) return fail(reply, 400, 'invalid-role', 'Granted role cannot exceed the operator role');
  const sharedConnection = {
    grantedRole,
    ...(parsed.data.contextStrategy === undefined ? {} : { contextStrategy: parsed.data.contextStrategy }),
    ...(parsed.data.accessPolicy === undefined ? {} : { accessPolicy: parsed.data.accessPolicy }),
  };
  let config: AgentConfig | undefined;
  if (providerId === 'codex-cli' || providerId === 'claude-code') {
    const card = (await modelProviders.list(principalId)).find((item) => item.id === providerId);
    if (card?.state !== 'connected') return fail(reply, 400, 'provider-not-connected', 'The selected local CLI is not installed and logged in');
    config = agentRuntime?.connectProvider(request.params.id, agent.id, {
      provider: providerId === 'codex-cli' ? 'codex' : 'claude', ...sharedConnection,
    });
  } else {
    const credentials = modelProviders.credentials(principalId, providerId);
    if (!credentials) return fail(reply, 400, 'provider-not-connected', 'Connect the selected provider before binding it');
    config = agentRuntime?.connectProvider(request.params.id, agent.id, {
      provider: 'openai-compatible',
      baseUrl: credentials.baseUrl,
      model: parsed.data.model ?? credentials.model,
      apiKey: credentials.apiKey,
      ...sharedConnection,
    });
  }
  if (!config) return fail(reply, 400, 'invalid-provider', 'Provider connection details are incomplete');
  return { config: publicAgentConfig(config), providerId };
});
app.delete<{ Params: { id: string; agentId: string } }>('/api/docs/:id/agents/:agentId', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  if (!canManageAgent(request.params.id, principalId, request.params.agentId)) return fail(reply, 403, 'permission-denied', 'Only the agent owner or document owner can manage this agent');
  const agent = principal(request.params.agentId);
  if (!agent || agent.kind !== 'agent' || !roleFor(request.params.id, agent.id)) return fail(reply, 404, 'agent-not-found', 'Agent is not a document member');
  agentRuntime?.removeConfig(request.params.id, agent.id);
  return { ok: true };
});
app.get<{ Params: { id: string } }>('/api/docs/:id/agent-runs', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const role = roleFor(request.params.id, principalId);
  if (!role || !can(role, 'view')) return fail(reply, 403, 'permission-denied', 'Membership is required');
  return agentStore.listRuns(request.params.id);
});
app.post<{ Params: { id: string } }>('/api/docs/:id/threads', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers);
  const role = roleFor(request.params.id, principalId);
  if (!role || !can(role, 'comment')) return fail(reply, 403, 'permission-denied', 'Commenter role is required');
  const parsed = createThreadSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  if (parsed.data.agentId !== undefined) {
    const assigned = principal(parsed.data.agentId);
    if (!assigned || assigned.kind !== 'agent' || !roleFor(request.params.id, assigned.id) || !agentVisible(request.params.id, principalId, assigned.id)) return fail(reply, 400, 'invalid-agent', 'Assigned agent is not available to this member');
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
  const principalId = principalIdFromHeaders(request.headers);
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
  const principalId = principalIdFromHeaders(request.headers);
  const role = roleFor(thread.docId, principalId);
  if (!role || !can(role, 'comment')) return fail(reply, 403, 'permission-denied', 'Commenter role is required');
  const parsed = createMessageSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'invalid-request', parsed.error.message);
  const mentions = resolveMentions(parsed.data.body, visibleMembers(thread.docId, principalId));
  const result = reviewService.addMessage({ threadId: thread.id, authorId: principalId, body: parsed.data.body, mentions, authorRole: role });
  if (!result.ok) return fail(reply, 400, result.error, 'Unable to add message');
  return result.value;
});
app.post<{ Params: { id: string } }>('/api/threads/:id/resolve', async (request, reply) => {
  const thread = reviewStore.getThread(request.params.id);
  if (!thread) return fail(reply, 404, 'thread-not-found', 'Thread was not found');
  const principalId = principalIdFromHeaders(request.headers);
  const role = roleFor(thread.docId, principalId);
  if (!role || !can(role, 'comment')) return fail(reply, 403, 'permission-denied', 'Commenter role is required');
  const result = reviewService.resolveThread(thread.id, role);
  if (!result.ok) return fail(reply, 400, result.error, 'Unable to resolve thread');
  return result.value;
});
app.post<{ Params: { id: string } }>('/api/suggestions/:id/accept', async (request, reply) => {
  const suggestion = reviewStore.getSuggestion(request.params.id);
  if (!suggestion) return fail(reply, 404, 'suggestion-not-found', 'Suggestion was not found');
  const principalId = principalIdFromHeaders(request.headers);
  const role = roleFor(suggestion.docId, principalId);
  if (!role) return fail(reply, 403, 'permission-denied', 'Membership is required');
  const result = reviewService.acceptSuggestion(suggestion.docId, suggestion.id, principalId, role);
  if (!result.ok) return fail(reply, 400, result.error, 'Unable to accept suggestion');
  return result.value;
});
app.post<{ Params: { id: string } }>('/api/suggestions/:id/reject', async (request, reply) => {
  const suggestion = reviewStore.getSuggestion(request.params.id);
  if (!suggestion) return fail(reply, 404, 'suggestion-not-found', 'Suggestion was not found');
  const principalId = principalIdFromHeaders(request.headers);
  const role = roleFor(suggestion.docId, principalId);
  if (!role) return fail(reply, 403, 'permission-denied', 'Membership is required');
  const result = reviewService.rejectSuggestion(suggestion.id, principalId, role);
  if (!result.ok) return fail(reply, 400, result.error, 'Unable to reject suggestion');
  return result.value;
});
app.post<{ Params: { id: string } }>('/api/suggestions/:id/regenerate', async (request, reply) => {
  const suggestion = reviewStore.getSuggestion(request.params.id);
  if (!suggestion) return fail(reply, 404, 'suggestion-not-found', 'Suggestion was not found');
  const principalId = principalIdFromHeaders(request.headers);
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
  const principalId = principalIdFromHeaders(request.headers);
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
  const principalId = principalIdFromHeaders(request.headers);
  const role = roleFor(thread.docId, principalId);
  if (!role) return fail(reply, 403, 'permission-denied', 'Membership is required');
  const result = reviewService.rejectBatchRemaining(batch.id, principalId, role);
  if (!result.ok) return fail(reply, 400, result.error, 'Unable to reject remaining suggestions');
  return result.value;
});
app.get<{ Params: { id: string }; Querystring: { principal?: string } }>('/api/docs/:id/events', async (request, reply) => {
  const principalId = principalIdFromHeaders(request.headers) || (allowLegacyIdentityHeader ? request.query.principal ?? '' : '');
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
  const group = sockets.get(docId) ?? new Set<WebSocket>();
  group.add(ws);
  sockets.set(docId, group);
  const identities = socketPrincipals.get(docId) ?? new Map<WebSocket, string>();
  identities.set(ws, principalId);
  socketPrincipals.set(docId, identities);
  json(ws, { type: 'sync', update: Buffer.from(record.handle.encodeStateAsUpdate()).toString('base64') });
  broadcastOnlineMembers(docId);
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
  ws.on('close', () => {
    group.delete(ws);
    identities.delete(ws);
    if (group.size === 0) {
      sockets.delete(docId);
      socketPrincipals.delete(docId);
    } else {
      broadcastOnlineMembers(docId);
    }
  });
});
const httpServer = app.server;
httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const match = url.pathname.match(/^\/ws\/docs\/([^/]+)$/);
  if (!match) { socket.destroy(); return; }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request, { docId: match[1], principalId: principalIdFromIncoming(request, url.searchParams.get('principal') ?? '') }));
});
const port = Number(process.env.PORT ?? 8787);
if (process.env.NODE_ENV !== 'test') app.listen({ port, host: process.env.HOST ?? '127.0.0.1' }).then(() => app.log.info(`server listening on ${port}`));

export { app };
