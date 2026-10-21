import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@collab/kernel';
import {
  agentPolicySchema,
  createAgentSchema,
  modelProviderBindingSchema,
  modelProviderConnectSchema,
  modelProviderIdSchema,
  type ModelProviderId,
} from '@collab/protocol';
import type { AgentSettings } from '../agent-settings.js';
import { documentAccess, type Access, type ServerContext } from '../context.js';
import { fail, parseBody, queryString } from '../http.js';
import { CLI_PRESETS, isCliProvider } from '../model-providers.js';
import { canInviteAgent } from '../workspace-permissions.js';

type DocParams = { Params: { id: string } };
type AgentParams = { Params: { id: string; agentId: string } };
type ProviderParams = { Params: { providerId: string } };

export function registerAgentRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { store, agents, providers, auth } = ctx;

  /** The agent must be a member of the document and manageable by the caller. */
  const manageAccess = (request: FastifyRequest, reply: FastifyReply, docId: string, agentId: string): (Access & { workspaceId: string }) | undefined => {
    const access = documentAccess(ctx, request, reply, docId, 'comment');
    if (!access) return undefined;
    const workspaceId = store.workspaceIdForDocument(docId);
    if (store.principal(agentId)?.kind !== 'agent' || store.role(docId, agentId) === null || workspaceId === undefined) {
      void fail(reply, 404, 'agent-not-found', 'The agent is not a member of this document');
      return undefined;
    }
    if (!agents.canManage(docId, agentId, access.principalId)) {
      void fail(reply, 403, 'permission-denied', 'Only the agent owner or the document owner can manage this agent');
      return undefined;
    }
    return { ...access, workspaceId };
  };

  /** An agent's role is its membership; it may not exceed the role of whoever sets it. */
  const setAgentRole = (reply: FastifyReply, access: Access & { workspaceId: string }, agentId: string, role: Role | undefined): boolean => {
    if (role === undefined) return true;
    if (!canInviteAgent(access.role, role)) { void fail(reply, 400, 'invalid-role', 'An agent role cannot exceed your own'); return false; }
    store.updateWorkspaceMemberRole(access.workspaceId, agentId, role);
    return true;
  };

  const bindProvider = async (docId: string, workspaceId: string, agentId: string, operatorId: string, providerId: ModelProviderId, model: string | undefined): Promise<boolean> => {
    const current = agents.settingsFor(docId, agentId);
    const policy = { contextStrategy: current.contextStrategy, accessPolicy: current.accessPolicy };
    let settings: AgentSettings;
    if (isCliProvider(providerId)) {
      if (!(await providers.isConnected(operatorId, providerId))) return false;
      settings = { ...policy, adapter: { type: 'cli', ...CLI_PRESETS[providerId] } };
    } else {
      const credentials = providers.credentials(operatorId, providerId);
      if (!credentials) return false;
      settings = { ...policy, adapter: { type: 'openai-compatible', baseUrl: credentials.baseUrl, model: model ?? credentials.model }, provider: { id: providerId, ownerId: operatorId } };
    }
    ctx.agentSettings.save(workspaceId, agentId, settings);
    return true;
  };

  app.get<DocParams>('/api/docs/:id/agents', async (request, reply) => {
    const access = documentAccess(ctx, request, reply, request.params.id, 'view');
    return access ? agents.summaries(request.params.id, access.principalId) : reply;
  });

  app.post<DocParams>('/api/docs/:id/agents', async (request, reply) => {
    const access = documentAccess(ctx, request, reply, request.params.id, 'comment');
    if (!access) return reply;
    const input = parseBody(createAgentSchema, request.body, reply);
    if (!input) return reply;
    const workspaceId = store.workspaceIdForDocument(request.params.id);
    if (workspaceId === undefined) return fail(reply, 400, 'invalid-request', 'The document does not belong to a project');
    if (!canInviteAgent(access.role, input.grantedRole)) return fail(reply, 400, 'invalid-role', 'An agent role cannot exceed your own');
    if (input.providerId !== undefined && !(await providers.isConnected(access.principalId, input.providerId))) {
      return fail(reply, 400, 'provider-not-connected', 'Connect the provider before binding an agent to it');
    }
    const agentId = ctx.newId('agent');
    store.upsertPrincipal({ id: agentId, kind: 'agent', displayName: input.displayName, ownerId: access.principalId });
    store.setWorkspaceMembership({ workspaceId, principalId: agentId, role: input.grantedRole });
    ctx.agentSettings.save(workspaceId, agentId, { adapter: { type: 'mock' }, contextStrategy: input.contextStrategy, accessPolicy: input.accessPolicy });
    if (input.providerId !== undefined) await bindProvider(request.params.id, workspaceId, agentId, access.principalId, input.providerId, input.model);
    ctx.membersChanged(workspaceId);
    return { agent: agents.summary(request.params.id, agentId, input.grantedRole, access.principalId) };
  });

  app.get<AgentParams>('/api/docs/:id/agents/:agentId', async (request, reply) => {
    const access = documentAccess(ctx, request, reply, request.params.id, 'view');
    if (!access) return reply;
    const role = store.role(request.params.id, request.params.agentId);
    if (role === null || !agents.isVisible(request.params.id, request.params.agentId, access.principalId)) return fail(reply, 404, 'agent-not-found', 'The agent was not found');
    return agents.summary(request.params.id, request.params.agentId, role, access.principalId);
  });

  /** Change how an agent participates; its connection changes through bind-provider. */
  app.patch<AgentParams>('/api/docs/:id/agents/:agentId', async (request, reply) => {
    const { id, agentId } = request.params;
    const access = manageAccess(request, reply, id, agentId);
    if (!access) return reply;
    const input = parseBody(agentPolicySchema, request.body, reply);
    if (!input || !setAgentRole(reply, access, agentId, input.grantedRole)) return reply;
    const current = agents.settingsFor(id, agentId);
    const adapter = input.model !== undefined && current.adapter.type === 'openai-compatible' ? { ...current.adapter, model: input.model } : current.adapter;
    ctx.agentSettings.save(access.workspaceId, agentId, {
      ...current,
      adapter,
      contextStrategy: input.contextStrategy ?? current.contextStrategy,
      accessPolicy: input.accessPolicy ?? current.accessPolicy,
    });
    ctx.membersChanged(access.workspaceId);
    return agents.summary(id, agentId, store.role(id, agentId) ?? 'viewer', access.principalId);
  });

  app.post<AgentParams>('/api/docs/:id/agents/:agentId/bind-provider', async (request, reply) => {
    const { id, agentId } = request.params;
    const access = manageAccess(request, reply, id, agentId);
    if (!access) return reply;
    const input = parseBody(modelProviderBindingSchema, request.body, reply);
    if (!input) return reply;
    if (input.grantedRole !== undefined && !canInviteAgent(access.role, input.grantedRole)) return fail(reply, 400, 'invalid-role', 'An agent role cannot exceed your own');
    if (!(await bindProvider(id, access.workspaceId, agentId, access.principalId, input.providerId, input.model))) {
      return fail(reply, 400, 'provider-not-connected', 'Connect the provider before binding an agent to it');
    }
    const current = agents.settingsFor(id, agentId);
    ctx.agentSettings.save(access.workspaceId, agentId, { ...current, contextStrategy: input.contextStrategy ?? current.contextStrategy, accessPolicy: input.accessPolicy ?? current.accessPolicy });
    setAgentRole(reply, access, agentId, input.grantedRole);
    ctx.membersChanged(access.workspaceId);
    return agents.summary(id, agentId, store.role(id, agentId) ?? 'viewer', access.principalId);
  });

  /** Back to the safe mock default; the agent stays a member. */
  app.delete<AgentParams>('/api/docs/:id/agents/:agentId', async (request, reply) => {
    const { id, agentId } = request.params;
    const access = manageAccess(request, reply, id, agentId);
    if (!access) return reply;
    ctx.agentSettings.reset(access.workspaceId, agentId);
    ctx.membersChanged(access.workspaceId);
    return agents.summary(id, agentId, store.role(id, agentId) ?? 'viewer', access.principalId);
  });

  app.get<DocParams>('/api/docs/:id/agent-runs', async (request, reply) => {
    if (!documentAccess(ctx, request, reply, request.params.id, 'view')) return reply;
    return ctx.agentStore.listRuns(request.params.id);
  });

  app.get('/api/model-providers', async (request, reply) => {
    const principal = auth.requireHuman(request, reply);
    if (!principal) return reply;
    return { providers: await providers.list(principal.id, { refresh: queryString(request.query, 'refresh') === '1' }) };
  });

  app.post<ProviderParams>('/api/model-providers/:providerId/connect', async (request, reply) => {
    const principal = auth.requireHuman(request, reply);
    if (!principal) return reply;
    const providerId = modelProviderIdSchema.safeParse(request.params.providerId);
    if (!providerId.success) return fail(reply, 404, 'provider-not-found', 'Unknown model provider');
    const input = parseBody(modelProviderConnectSchema, request.body, reply);
    if (!input) return reply;
    const provider = providers.connectApiKey(principal.id, providerId.data, { apiKey: input.apiKey, model: input.model, ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }) });
    if (!provider) return fail(reply, 400, 'provider-not-connectable', 'This provider is managed by its local CLI or needs a base URL');
    return { provider, keyStored: false, sessionOnly: true };
  });

  app.delete<ProviderParams>('/api/model-providers/:providerId', async (request, reply) => {
    const principal = auth.requireHuman(request, reply);
    if (!principal) return reply;
    const providerId = modelProviderIdSchema.safeParse(request.params.providerId);
    if (!providerId.success) return fail(reply, 404, 'provider-not-found', 'Unknown model provider');
    return { ok: providers.disconnect(principal.id, providerId.data) };
  });

  app.get<ProviderParams>('/api/model-providers/:providerId/models', async (request, reply) => {
    const principal = auth.requireHuman(request, reply);
    if (!principal) return reply;
    const providerId = modelProviderIdSchema.safeParse(request.params.providerId);
    if (!providerId.success) return fail(reply, 404, 'provider-not-found', 'Unknown model provider');
    return { models: await providers.models(principal.id, providerId.data) };
  });
}
