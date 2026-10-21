import type { FastifyInstance } from 'fastify';
import { authLoginSchema, registerPrincipalSchema, updateAccountSchema, type AccountDto, type SessionStateResponse } from '@collab/protocol';
import { hashPassword } from '../auth.js';
import type { ServerContext } from '../context.js';
import { fail, parseBody, queryString } from '../http.js';
import type { PrincipalRecord } from '../infra/document-store.js';

function normalize(value: string): string {
  return value.trim().replace(/^@/u, '').toLocaleLowerCase();
}

export function registerAuthRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { store, auth } = ctx;

  app.post('/api/auth/register', async (request, reply) => {
    const input = parseBody(registerPrincipalSchema, request.body, reply);
    if (!input) return reply;
    const handle = normalize(input.handle);
    const email = input.email === undefined ? undefined : normalize(input.email);
    // A seed principal without a password may be claimed once through its handle.
    const claimable = store.humanPrincipalByHandle(handle);
    if (claimable ? store.principalPasswordHash(claimable.id) !== undefined : store.principalHandleTaken(handle)) {
      return fail(reply, 409, 'account-handle-taken', 'Account handle is already registered');
    }
    if (email !== undefined && store.principalEmailTaken(email, claimable?.id)) return fail(reply, 409, 'account-email-taken', 'Account email is already registered');
    const principal: PrincipalRecord = {
      id: claimable?.id ?? ctx.newId('human'),
      kind: 'human',
      displayName: input.displayName,
      handle,
      ...(email === undefined ? {} : { email }),
    };
    store.upsertPrincipal(principal);
    store.setPrincipalPasswordHash(principal.id, hashPassword(input.password));
    return reply.code(201).send(auth.signIn(principal, reply));
  });

  // Login and switch are the same operation: the browser session is replaced,
  // sessions on other devices stay valid.
  for (const url of ['/api/auth/login', '/api/auth/switch']) {
    app.post(url, async (request, reply) => {
      const input = parseBody(authLoginSchema, request.body, reply);
      if (!input) return reply;
      const account = auth.authenticate(input.identifier, input.password);
      if (!account) return fail(reply, 401, 'invalid-credentials', 'Invalid account identifier or password');
      return auth.signIn(account, reply);
    });
  }

  app.get('/api/auth/session', async (request, reply): Promise<SessionStateResponse> => {
    const principal = store.principal(auth.principalId(request.headers));
    if (principal?.kind !== 'human') {
      if (auth.hasSessionCookie(request)) auth.signOut(request, reply);
      return { authenticated: false, principal: null, session: null };
    }
    return { authenticated: true, principal, session: auth.session(request, principal.id) };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    auth.signOut(request, reply);
    return { ok: true };
  });

  app.get('/api/account', async (request, reply) => {
    const principal = auth.requireHuman(request, reply);
    if (!principal) return reply;
    const account: AccountDto = {
      principal,
      workspaces: store.workspaces(principal.id).flatMap((workspace) => {
        const role = store.workspaceRole(workspace.id, principal.id);
        return role === null ? [] : [{ id: workspace.id, title: workspace.title, role }];
      }),
      pendingInvitationCount: store.pendingWorkspaceInvitations(principal.id).length,
    };
    return account;
  });

  app.patch('/api/account', async (request, reply) => {
    const principal = auth.requireHuman(request, reply);
    if (!principal) return reply;
    const input = parseBody(updateAccountSchema, request.body, reply);
    if (!input) return reply;
    const handle = input.handle === undefined ? undefined : normalize(input.handle);
    const email = input.email === undefined ? undefined : normalize(input.email);
    if (handle !== undefined && store.principalHandleTaken(handle, principal.id)) return fail(reply, 409, 'account-handle-taken', 'Account handle is already registered');
    if (email !== undefined && store.principalEmailTaken(email, principal.id)) return fail(reply, 409, 'account-email-taken', 'Account email is already registered');
    return store.updatePrincipalProfile(principal.id, input.displayName, handle, email) ?? fail(reply, 404, 'principal-not-found', 'Account was not found');
  });

  /** Directory lookup for invitations: registered people only, never agents. */
  app.get('/api/accounts/search', async (request, reply) => {
    if (!auth.requireHuman(request, reply)) return reply;
    const query = queryString(request.query, 'q')?.trim() ?? '';
    return query.length === 0 ? [] : store.searchHumanPrincipals(query).map(({ email: _email, ...principal }) => principal);
  });
}
