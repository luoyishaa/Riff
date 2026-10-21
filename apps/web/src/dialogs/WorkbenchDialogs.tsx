import type { DocumentDto, DocumentSummaryDto, PrincipalDto, WorkspaceDto } from '@collab/protocol';
import { api, describeError } from '../api.js';
import type { DocumentData } from '../hooks/useDocumentData.js';
import type { useReviewActions } from '../hooks/useReviewActions.js';
import type { Session } from '../hooks/useSession.js';
import { useToast } from '../hooks/useToast.js';
import type { Workspaces } from '../hooks/useWorkspaces.js';
import { forgetFolder } from '../lib/folderRegistry.js';
import { can } from '../lib/permissions.js';
import { ProfileDialog, VersionHistory } from './AccountDialogs.js';
import { AgentDrawer, type AgentDrawerMode } from './AgentDrawer.js';
import { InvitationsDialog, MembersDialog } from './MembersDialog.js';
import { ConfirmDialog, NewDocumentDialog, NewProjectDialog, RenameDialog } from './ProjectDialogs.js';
import { ProjectSettings } from './ProjectSettings.js';
import { ProvidersDrawer } from './ProvidersDrawer.js';

export type Dialog =
  | { kind: 'new-project' }
  | { kind: 'new-document' }
  | { kind: 'delete-document'; document: DocumentSummaryDto }
  | { kind: 'rename-project' }
  | { kind: 'delete-project' }
  | { kind: 'profile' }
  | { kind: 'members' }
  | { kind: 'invitations' }
  | { kind: 'project-settings' }
  | { kind: 'versions' }
  | { kind: 'agent'; mode: AgentDrawerMode }
  | { kind: 'providers' };

export interface WorkbenchDialogsProps {
  dialog: Dialog | null;
  onClose: () => void;
  onOpenDialog: (dialog: Dialog) => void;
  onOpenDocument: (docId: string) => void;
  session: Session;
  principal: PrincipalDto;
  workspaces: Workspaces;
  document: DocumentDto | undefined;
  data: DocumentData;
  actions: ReturnType<typeof useReviewActions>;
  identify: (principalId: string) => { name: string; kind: 'human' | 'agent' };
}

/** Every dialog and drawer of the workbench; only the one in `dialog` is open. */
export function WorkbenchDialogs({ dialog, onClose, onOpenDialog, onOpenDocument, session, principal, workspaces, document, data, actions, identify }: WorkbenchDialogsProps): React.ReactElement {
  const notify = useToast();
  const detail = workspaces.detail;
  const kind = dialog?.kind;
  const refreshMembers = (): void => { void workspaces.reloadDetail(); data.refresh('agents', 'document'); };

  const deleteDocument = async (target: DocumentSummaryDto): Promise<void> => {
    try {
      await api(`/api/docs/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
      notify(`“${target.title}”已删除；本地文件夹里的原文件不受影响。`, 'success');
      onClose();
      await workspaces.reloadDetail();
    } catch (error) {
      notify(describeError(error, '文档没有删除。'), 'error');
    }
  };

  const renameProject = async (title: string): Promise<void> => {
    if (!detail) return;
    try {
      await api(`/api/workspaces/${encodeURIComponent(detail.id)}`, { method: 'PATCH', body: { title } });
      notify('项目已重命名。', 'success');
      onClose();
      await Promise.all([workspaces.reload(), workspaces.reloadDetail()]);
    } catch (error) {
      notify(describeError(error, '没有重命名成功。'), 'error');
    }
  };

  const deleteProject = async (): Promise<void> => {
    if (!detail) return;
    try {
      await api(`/api/workspaces/${encodeURIComponent(detail.id)}`, { method: 'DELETE', body: { confirmTitle: detail.title } });
      forgetFolder(detail.id);
      notify(`项目“${detail.title}”已删除。`, 'success');
      onClose();
      const remaining = await workspaces.reload();
      workspaces.select(remaining[0]?.id);
    } catch (error) {
      notify(describeError(error, '项目没有删除。'), 'error');
    }
  };

  return (
    <>
      <NewProjectDialog open={kind === 'new-project'} onClose={onClose} onCreated={(workspace: WorkspaceDto) => { onClose(); void workspaces.reload().then(() => workspaces.select(workspace.id)); }} />
      <NewDocumentDialog open={kind === 'new-document'} workspaceId={detail?.id} onClose={onClose} onCreated={(created) => { onClose(); void workspaces.reloadDetail().then(() => onOpenDocument(created.id)); }} />
      {dialog?.kind === 'delete-document' ? (
        <ConfirmDialog open title="删除文档" description={`删除“${dialog.document.title}”及其讨论与版本，无法撤销。本地文件夹里的原文件不会被删除。`} confirmLabel="删除文档" onConfirm={() => deleteDocument(dialog.document)} onClose={onClose} />
      ) : null}
      {detail ? (
        <>
          {kind === 'rename-project' ? <RenameDialog open title={detail.title} onRename={renameProject} onClose={onClose} /> : null}
          <ConfirmDialog open={kind === 'delete-project'} title="删除项目" description="项目中的文档、成员、邀请和讨论都会被删除，无法撤销。本地文件夹里的原文件不会被删除。" confirmLabel="删除项目" typeToConfirm={detail.title} onConfirm={deleteProject} onClose={onClose} />
          <MembersDialog open={kind === 'members'} workspace={detail} viewerId={principal.id} onClose={onClose} onChanged={refreshMembers} onConfigureAgent={(agentId) => onOpenDialog({ kind: 'agent', mode: { kind: 'configure', agentId } })} />
          <ProjectSettings open={kind === 'project-settings'} workspace={detail} onClose={onClose} onRename={() => onOpenDialog({ kind: 'rename-project' })} onDelete={() => onOpenDialog({ kind: 'delete-project' })} onConnected={() => void workspaces.reloadDetail()} />
        </>
      ) : null}
      {kind === 'profile' ? <ProfileDialog open principal={principal} onClose={onClose} onSaved={(updated) => { session.updatePrincipal(updated); onClose(); }} /> : null}
      <InvitationsDialog
        open={kind === 'invitations'}
        invitations={workspaces.invitations}
        onClose={onClose}
        onResponded={(invitation, accepted) => {
          void workspaces.reloadInvitations();
          if (accepted) { onClose(); void workspaces.reload().then(() => workspaces.select(invitation.workspaceId)); }
        }}
      />
      <VersionHistory open={kind === 'versions'} versions={data.versions} canRestore={can(document?.role, 'edit')} nameOf={(id) => identify(id).name} onRestore={(version) => void actions.restore(version).then((restored) => { if (restored) onClose(); })} onClose={onClose} />
      {dialog?.kind === 'agent' && document ? (
        <AgentDrawer open mode={dialog.mode} docId={document.id} role={document.role} agents={data.agents} onClose={onClose} onChanged={refreshMembers} onOpenProviders={() => onOpenDialog({ kind: 'providers' })} />
      ) : null}
      <ProvidersDrawer open={kind === 'providers'} onClose={onClose} onChanged={() => data.refresh('agents')} />
    </>
  );
}
