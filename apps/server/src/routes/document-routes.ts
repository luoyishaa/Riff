import type { FastifyInstance } from 'fastify';
import { buildOutline, createDocumentSchema, documentKind, localProjectSyncSchema, type DocumentDto } from '@collab/protocol';
import { documentAccess, type ServerContext } from '../context.js';
import { versionDto } from '../dto.js';
import { fail, parseBody, sendReviewError } from '../http.js';

type DocParams = { Params: { id: string } };

export function registerDocumentRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { store, auth } = ctx;

  app.get('/api/docs', async (request, reply) => {
    const principal = auth.requireHuman(request, reply);
    if (!principal) return reply;
    return store.list().filter((doc) => store.role(doc.id, principal.id) !== null);
  });

  /** Without a workspace the document gets a personal workspace of its own. */
  app.post('/api/docs', async (request, reply) => {
    const principal = auth.requireHuman(request, reply);
    if (!principal) return reply;
    const input = parseBody(createDocumentSchema, request.body, reply);
    if (!input) return reply;
    const workspaceId = input.workspaceId ?? store.createWorkspace(ctx.newId('space'), `${input.title} 空间`, principal.id, ctx.now()).id;
    const role = store.workspaceRole(workspaceId, principal.id);
    if (role !== 'editor' && role !== 'owner') return fail(reply, 403, 'permission-denied', 'The edit permission is required');
    const record = store.create(ctx.newId('doc'), input.title, input.text, [], workspaceId);
    ctx.documentCreated(record.id);
    return store.list().find((doc) => doc.id === record.id);
  });

  app.get<DocParams>('/api/docs/:id', async (request, reply) => {
    const access = documentAccess(ctx, request, reply, request.params.id, 'view');
    const record = store.get(request.params.id);
    if (!access || !record) return reply;
    const text = record.handle.getText();
    const kind = documentKind(record.relativePath ?? record.title);
    const document: DocumentDto = {
      id: record.id,
      title: record.title,
      ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
      ...(record.relativePath === undefined ? {} : { relativePath: record.relativePath }),
      kind,
      text,
      role: access.role,
      outline: buildOutline(text, kind),
      members: ctx.visibleMembers(record.id, access.principalId),
    };
    return document;
  });

  app.delete<DocParams>('/api/docs/:id', async (request, reply) => {
    const access = documentAccess(ctx, request, reply, request.params.id, 'edit');
    if (!access) return reply;
    ctx.documentRemoved(request.params.id);
    if (!store.deleteDocument(request.params.id)) return fail(reply, 404, 'document-not-found', 'The document was not found');
    return { ok: true, documentId: request.params.id };
  });

  app.get<DocParams>('/api/docs/:id/outline', async (request, reply) => {
    const record = store.get(request.params.id);
    if (!documentAccess(ctx, request, reply, request.params.id, 'view') || !record) return reply;
    return buildOutline(record.handle.getText(), documentKind(record.relativePath ?? record.title));
  });

  app.get<DocParams>('/api/docs/:id/versions', async (request, reply) => {
    const access = documentAccess(ctx, request, reply, request.params.id, 'view');
    if (!access) return reply;
    const result = ctx.reviewService.listDocumentVersions(request.params.id, access.role);
    return result.ok ? result.value.map(versionDto) : sendReviewError(reply, result.error, 'Document versions are unavailable');
  });

  app.post<{ Params: { id: string; versionId: string } }>('/api/docs/:id/versions/:versionId/restore', async (request, reply) => {
    const access = documentAccess(ctx, request, reply, request.params.id, 'edit');
    if (!access) return reply;
    const version = ctx.reviewStore.getDocumentVersion(request.params.versionId);
    if (!version || version.docId !== request.params.id) return fail(reply, 404, 'version-not-found', 'The version was not found');
    const result = ctx.reviewService.restoreDocumentVersion(version.id, access.principalId, access.role);
    return result.ok ? { ok: true, version: versionDto(result.value) } : sendReviewError(reply, result.error, 'The version could not be restored');
  });

  /** Write the document back to its mapped file; a disk-side change reports a conflict instead. */
  app.post<DocParams>('/api/docs/:id/local-project/sync', async (request, reply) => {
    const access = documentAccess(ctx, request, reply, request.params.id, 'edit');
    if (!access) return reply;
    const input = parseBody(localProjectSyncSchema, request.body, reply);
    if (!input) return reply;
    try {
      const file = ctx.localProject.syncDocument(request.params.id, input.text);
      if (!file) return fail(reply, 404, 'local-project-document-not-found', 'The document is not mapped to a local file');
      return { ok: file.status === 'synced' || file.status === 'updated', file };
    } catch (error) {
      return fail(reply, 409, 'local-project-sync-failed', error instanceof Error ? error.message : String(error));
    }
  });
}
