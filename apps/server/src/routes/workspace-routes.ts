import type { FastifyInstance } from 'fastify';
import { can, roleRank } from '@collab/kernel';
import {
  createDocumentSchema,
  createWorkspaceSchema,
  deleteWorkspaceSchema,
  localProjectBindSchema,
  updateMemberRoleSchema,
  updateWorkspaceSchema,
  workspaceInvitationSchema,
  type InvitationDto,
  type WorkspaceDetailDto,
  type WorkspaceDto,
} from '@collab/protocol';
import { workspaceAccess, type ServerContext } from '../context.js';
import { fail, parseBody } from '../http.js';
import type { WorkspaceInvitationRecord, WorkspaceRecord } from '../infra/document-store.js';

type WorkspaceParams = { Params: { id: string } };
type MemberParams = { Params: { id: string; principalId: string } };

export function registerWorkspaceRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { store, auth } = ctx;

  const workspaceDto = (workspace: WorkspaceRecord, principalId: string): WorkspaceDto | undefined => {
    const role = store.workspaceRole(workspace.id, principalId);
    if (role === null) return undefined;
    return {
      id: workspace.id,
      title: workspace.title,
      createdBy: workspace.createdBy,
      createdAt: workspace.createdAt,
      source: workspace.source,
      ...(workspace.rootPath !== undefined && can(role, 'manage') ? { rootPath: workspace.rootPath } : {}),
      role,
      documents: store.list().filter((doc) => doc.workspaceId === workspace.id && store.role(doc.id, principalId) !== null),
    };
  };

  const invitationDto = (invitation: WorkspaceInvitationRecord): InvitationDto => {
    const workspace = store.workspace(invitation.workspaceId);
    const invitee = store.principal(invitation.principalId);
    const inviter = store.principal(invitation.invitedBy);
    return {
      ...invitation,
      ...(workspace === undefined ? {} : { workspace: { id: workspace.id, title: workspace.title } }),
      ...(invitee === undefined ? {} : { invitee }),
      ...(inviter === undefined ? {} : { inviter }),
    };
  };

  app.get('/api/workspaces', async (request, reply) => {
    const principal = auth.requireHuman(request, reply);
    if (!principal) return reply;
    return store.workspaces(principal.id).flatMap((workspace) => workspaceDto(workspace, principal.id) ?? []);
  });

  app.post('/api/workspaces', async (request, reply) => {
    const principal = auth.requireHuman(request, reply);
    if (!principal) return reply;
    const input = parseBody(createWorkspaceSchema, request.body, reply);
    if (!input) return reply;
    const workspace = store.createWorkspace(ctx.newId('space'), input.title, principal.id, ctx.now());
    return workspaceDto(workspace, principal.id);
  });

  app.get<WorkspaceParams>('/api/workspaces/:id', async (request, reply) => {
    const access = workspaceAccess(ctx, request, reply, request.params.id, 'view');
    if (!access) return reply;
    const base = workspaceDto(access.workspace, access.principalId);
    if (!base) return fail(reply, 404, 'workspace-not-found', 'The workspace was not found');
    const localProject = ctx.localProject.status(access.workspace.id);
    const detail: WorkspaceDetailDto = {
      ...base,
      // Private agents stay hidden from members who may not use them.
      members: store.workspaceMembers(access.workspace.id).filter((member) => member.kind !== 'agent' || ctx.agents.isVisibleInWorkspace(access.workspace.id, member.id, access.principalId)),
      localProject: can(access.role, 'manage') ? localProject : { workspaceId: localProject.workspaceId, source: localProject.source, files: localProject.files },
    };
    return detail;
  });

  app.patch<WorkspaceParams>('/api/workspaces/:id', async (request, reply) => {
    const access = workspaceAccess(ctx, request, reply, request.params.id, 'manage');
    if (!access) return reply;
    const input = parseBody(updateWorkspaceSchema, request.body, reply);
    if (!input) return reply;
    const updated = store.updateWorkspaceTitle(access.workspace.id, input.title);
    return updated ? workspaceDto(updated, access.principalId) : fail(reply, 404, 'workspace-not-found', 'The workspace was not found');
  });

  app.delete<WorkspaceParams>('/api/workspaces/:id', async (request, reply) => {
    const access = workspaceAccess(ctx, request, reply, request.params.id, 'manage');
    if (!access) return reply;
    const input = parseBody(deleteWorkspaceSchema, request.body, reply);
    if (!input) return reply;
    if (input.confirmTitle !== access.workspace.title) return fail(reply, 409, 'delete-confirmation-mismatch', 'The workspace title confirmation does not match');
    const documentIds = store.workspaceDocuments(access.workspace.id).map((document) => document.id);
    for (const documentId of documentIds) ctx.documentRemoved(documentId);
    store.deleteWorkspace(access.workspace.id);
    return { ok: true, workspaceId: access.workspace.id };
  });

  app.post<WorkspaceParams>('/api/workspaces/:id/documents', async (request, reply) => {
    const access = workspaceAccess(ctx, request, reply, request.params.id, 'edit');
    if (!access) return reply;
    const input = parseBody(createDocumentSchema, request.body, reply);
    if (!input) return reply;
    const record = store.create(ctx.newId('doc'), input.title, input.text, [], access.workspace.id);
    ctx.documentCreated(record.id);
    return store.list().find((doc) => doc.id === record.id);
  });

  app.put<MemberParams>('/api/workspaces/:id/members/:principalId', async (request, reply) => {
    const access = workspaceAccess(ctx, request, reply, request.params.id, 'manage');
    if (!access) return reply;
    const input = parseBody(updateMemberRoleSchema, request.body, reply);
    if (!input) return reply;
    if (store.workspaceRole(access.workspace.id, request.params.principalId) === null) return fail(reply, 404, 'member-not-found', 'The member was not found');
    if (roleRank(input.role) > roleRank(access.role)) return fail(reply, 400, 'invalid-role', 'A role cannot exceed your own');
    store.updateWorkspaceMemberRole(access.workspace.id, request.params.principalId, input.role);
    ctx.membersChanged(access.workspace.id);
    return store.workspaceMembers(access.workspace.id).find((member) => member.id === request.params.principalId);
  });

  app.delete<MemberParams>('/api/workspaces/:id/members/:principalId', async (request, reply) => {
    const access = workspaceAccess(ctx, request, reply, request.params.id, 'manage');
    if (!access) return reply;
    if (request.params.principalId === access.principalId) return fail(reply, 400, 'invalid-request', 'Owners cannot remove themselves');
    if (store.workspaceRole(access.workspace.id, request.params.principalId) === null) return fail(reply, 404, 'member-not-found', 'The member was not found');
    store.removeWorkspaceMembership(access.workspace.id, request.params.principalId);
    ctx.membersChanged(access.workspace.id);
    return { ok: true };
  });

  app.post<WorkspaceParams>('/api/workspaces/:id/invitations', async (request, reply) => {
    const access = workspaceAccess(ctx, request, reply, request.params.id, 'manage');
    if (!access) return reply;
    const input = parseBody(workspaceInvitationSchema, request.body, reply);
    if (!input) return reply;
    const invitee = store.humanPrincipalByIdentifier(input.identifier);
    if (!invitee) return fail(reply, 404, 'principal-not-found', 'No registered account uses this handle or email');
    if (invitee.id === access.principalId || store.workspaceRole(access.workspace.id, invitee.id) !== null) return fail(reply, 409, 'already-member', 'This account is already a project member');
    const invitation = store.createWorkspaceInvitation(ctx.newId('invite'), access.workspace.id, invitee.id, input.role, access.principalId, ctx.now());
    return invitationDto(invitation);
  });

  app.get<WorkspaceParams>('/api/workspaces/:id/invitations', async (request, reply) => {
    const access = workspaceAccess(ctx, request, reply, request.params.id, 'manage');
    if (!access) return reply;
    return store.workspaceInvitations(access.workspace.id).map(invitationDto);
  });

  app.get('/api/invitations', async (request, reply) => {
    const principal = auth.requireHuman(request, reply);
    if (!principal) return reply;
    return store.pendingWorkspaceInvitations(principal.id).map(invitationDto).filter((invitation) => invitation.workspace !== undefined);
  });

  for (const action of ['accept', 'reject'] as const) {
    app.post<WorkspaceParams>(`/api/invitations/:id/${action}`, async (request, reply) => {
      const principal = auth.requireHuman(request, reply);
      if (!principal) return reply;
      const invitation = action === 'accept'
        ? store.acceptWorkspaceInvitation(request.params.id, principal.id, ctx.now())
        : store.rejectWorkspaceInvitation(request.params.id, principal.id, ctx.now());
      if (!invitation) return fail(reply, 404, 'invitation-not-found', 'No pending invitation for this account');
      if (action === 'accept') ctx.membersChanged(invitation.workspaceId);
      return invitationDto(invitation);
    });
  }

  app.post<WorkspaceParams>('/api/workspaces/:id/local-project', async (request, reply) => {
    const access = workspaceAccess(ctx, request, reply, request.params.id, 'manage');
    if (!access) return reply;
    const input = parseBody(localProjectBindSchema, request.body, reply);
    if (!input) return reply;
    try {
      return ctx.localProject.bind(access.workspace.id, input);
    } catch (error) {
      return fail(reply, 400, 'local-project-invalid', error instanceof Error ? error.message : String(error));
    }
  });

  app.get<WorkspaceParams>('/api/workspaces/:id/local-project', async (request, reply) => {
    const access = workspaceAccess(ctx, request, reply, request.params.id, 'view');
    if (!access) return reply;
    const status = ctx.localProject.status(access.workspace.id);
    return can(access.role, 'manage') ? status : { workspaceId: status.workspaceId, source: status.source, files: status.files };
  });

  app.post<WorkspaceParams>('/api/workspaces/:id/local-project/scan', async (request, reply) => {
    const access = workspaceAccess(ctx, request, reply, request.params.id, 'edit');
    if (!access) return reply;
    try {
      return ctx.localProject.scan(access.workspace.id);
    } catch (error) {
      return fail(reply, 400, 'local-project-scan-failed', error instanceof Error ? error.message : String(error));
    }
  });
}
