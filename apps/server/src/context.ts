import type { FastifyReply, FastifyRequest } from 'fastify';
import { can, type Action, type Role } from '@collab/kernel';
import type { ReviewService } from '@collab/review';
import type { MemberDto } from '@collab/protocol';
import type { AgentRuntime } from './agent-runtime.js';
import type { AgentSettingsStore } from './agent-settings.js';
import type { AuthService } from './auth.js';
import type { Collaboration } from './collaboration.js';
import type { AppEventBus } from './events.js';
import { fail } from './http.js';
import type { AgentStore } from './infra/agent-store.js';
import type { DocumentStore, WorkspaceRecord } from './infra/document-store.js';
import type { LocalProjectService } from './infra/local-project.js';
import type { ReviewStore } from './infra/review-store.js';
import type { ModelProviderRegistry } from './model-providers.js';

export interface ServerContext {
  store: DocumentStore;
  reviewStore: ReviewStore;
  agentStore: AgentStore;
  reviewService: ReviewService;
  agents: AgentRuntime;
  agentSettings: AgentSettingsStore;
  providers: ModelProviderRegistry;
  localProject: LocalProjectService;
  collaboration: Collaboration;
  events: AppEventBus;
  auth: AuthService;
  now: () => number;
  /** A new id with a readable prefix, e.g. `doc-1a2b3c4d5e6f`. */
  newId: (prefix: string) => string;
  /** Start persisting and relaying a document that was just created. */
  documentCreated: (docId: string) => void;
  /** Stop all live work for a document before its rows are deleted. */
  documentRemoved: (docId: string) => void;
  visibleMembers: (docId: string, viewerId: string) => MemberDto[];
  /** Tell every document of a project that its members, their roles or its agents changed. */
  membersChanged: (workspaceId: string) => void;
}

export interface Access { principalId: string; role: Role }

function denied(reply: FastifyReply, principalId: string, role: Role | null, action: Action, resource: 'document' | 'workspace'): undefined {
  if (!principalId) void fail(reply, 401, 'authentication-required', 'A signed-in account is required');
  else if (role === null) void fail(reply, 404, `${resource}-not-found`, `The ${resource} was not found`);
  else void fail(reply, 403, 'permission-denied', `The ${action} permission is required`);
  return undefined;
}

/** The caller's role in a document if it allows `action`; otherwise the error reply is sent. */
export function documentAccess(ctx: ServerContext, request: FastifyRequest, reply: FastifyReply, docId: string, action: Action): Access | undefined {
  const principalId = ctx.auth.principalId(request.headers);
  const role = principalId && ctx.store.get(docId) ? ctx.store.role(docId, principalId) : null;
  return role !== null && can(role, action) ? { principalId, role } : denied(reply, principalId, role, action, 'document');
}

export function workspaceAccess(ctx: ServerContext, request: FastifyRequest, reply: FastifyReply, workspaceId: string, action: Action): (Access & { workspace: WorkspaceRecord }) | undefined {
  const principalId = ctx.auth.principalId(request.headers);
  const workspace = principalId ? ctx.store.workspace(workspaceId) : undefined;
  const role = workspace ? ctx.store.workspaceRole(workspaceId, principalId) : null;
  return workspace && role !== null && can(role, action) ? { principalId, role, workspace } : denied(reply, principalId, role, action, 'workspace');
}
