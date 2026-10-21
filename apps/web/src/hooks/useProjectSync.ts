import { useState } from 'react';
import type { LocalProjectFileDto, LocalProjectStatusDto, WorkspaceDetailDto } from '@collab/protocol';
import { api, describeError } from '../api.js';
import { connectFolder } from '../dialogs/ProjectDialogs.js';
import { folderBinding } from '../lib/folderRegistry.js';
import { can } from '../lib/permissions.js';
import { useToast } from './useToast.js';

function summary(files: LocalProjectFileDto[]): string {
  if (files.length === 0) return '文件夹里没有找到 TXT / Markdown 文件。';
  const count = (status: LocalProjectFileDto['status']): number => files.filter((file) => file.status === status).length;
  const parts = [
    count('imported') ? `新增 ${count('imported')}` : '',
    count('updated') ? `更新 ${count('updated')}` : '',
    count('conflict') ? `冲突 ${count('conflict')}（两边都改过，未覆盖）` : '',
    count('missing') ? `本地缺失 ${count('missing')}（项目中的文档已保留）` : '',
  ].filter(Boolean);
  return parts.length ? `已同步 ${files.length} 个文件：${parts.join('，')}。` : `已同步 ${files.length} 个文件，内容一致。`;
}

/**
 * Reconcile the project with its local folder: a server folder is rescanned
 * by the server; a folder picked in this page is read again and re-imported.
 */
export function useProjectSync(workspace: WorkspaceDetailDto | undefined, reloadDetail: () => Promise<void>): { syncing: boolean; canSync: boolean; run: () => Promise<void> } {
  const notify = useToast();
  const [syncing, setSyncing] = useState(false);
  const binding = folderBinding(workspace?.id);
  const canSync = workspace !== undefined && (
    (workspace.source === 'local' && can(workspace.role, 'edit'))
    || (workspace.source === 'imported' && binding?.rescan !== undefined && can(workspace.role, 'manage')));
  const run = async (): Promise<void> => {
    if (!workspace || !canSync) return;
    setSyncing(true);
    try {
      let status: LocalProjectStatusDto;
      if (workspace.source === 'local') {
        status = await api<LocalProjectStatusDto>(`/api/workspaces/${encodeURIComponent(workspace.id)}/local-project/scan`, { method: 'POST' });
      } else {
        const folder = await binding?.rescan?.();
        if (!folder) return;
        status = await connectFolder(workspace.id, folder, '');
      }
      notify(summary(status.files), status.files.some((file) => file.status === 'conflict') ? 'error' : 'success');
      await reloadDetail();
    } catch (error) {
      notify(describeError(error, '同步失败，请检查文件夹是否仍可访问。'), 'error');
    } finally {
      setSyncing(false);
    }
  };
  return { syncing, canSync, run };
}
