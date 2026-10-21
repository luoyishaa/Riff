import { useState } from 'react';
import type { WorkspaceDetailDto } from '@collab/protocol';
import { describeError } from '../api.js';
import { useToast } from '../hooks/useToast.js';
import { folderBinding } from '../lib/folderRegistry.js';
import type { PickedFolder } from '../lib/localFolder.js';
import { can, ROLE_LABEL } from '../lib/permissions.js';
import { Modal } from '../ui/Modal.js';
import { connectFolder, FolderChooser } from './ProjectDialogs.js';

export interface ProjectSettingsProps {
  open: boolean;
  workspace: WorkspaceDetailDto;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
  onConnected: () => void;
}

const STATUS_LABEL = { imported: '已导入', synced: '已同步', updated: '已更新', conflict: '有冲突', missing: '本地缺失' } as const;

export function ProjectSettings({ open, workspace, onClose, onRename, onDelete, onConnected }: ProjectSettingsProps): React.ReactElement {
  const notify = useToast();
  const [folder, setFolder] = useState<PickedFolder>();
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const owner = can(workspace.role, 'manage');
  const local = workspace.localProject;
  const binding = folderBinding(workspace.id);
  const source = local.source === 'local'
    ? `服务端文件夹 ${local.path ?? ''}`
    : local.source === 'imported'
      ? binding ? `浏览器文件夹“${binding.name}”（本页面可写回）` : '浏览器导入的副本（刷新后不再写回，重新选择文件夹即可恢复）'
      : '未连接本地文件夹，文档保存在项目中';

  const connect = async (): Promise<void> => {
    setBusy(true);
    try {
      const status = await connectFolder(workspace.id, folder, path);
      notify(`已连接，共 ${status.files.length} 个文件。`, 'success');
      setFolder(undefined);
      setPath('');
      onConnected();
    } catch (error) {
      notify(describeError(error, '连接失败，请确认服务端能访问这个目录。'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} variant="drawer" title="项目设置" description={`${workspace.title} · 你是${ROLE_LABEL[workspace.role]}`} onClose={onClose}>
      <section className="settings-section">
        <h3>本地文件夹</h3>
        <p className="muted">{source}</p>
        {local.files.length > 0 ? (
          <ul className="file-status-list">
            {local.files.map((file) => (
              <li key={file.documentId}><span>{file.relativePath}</span><span className={`status-chip is-${file.status}`}>{STATUS_LABEL[file.status]}</span></li>
            ))}
          </ul>
        ) : null}
        {owner ? (
          <div className="settings-block">
            <h4>{local.source === 'managed' ? '连接文件夹' : '重新连接'}</h4>
            <FolderChooser folder={folder} path={path} onFolder={setFolder} onPath={setPath} disabled={busy} />
            <button type="button" className="button primary" disabled={busy || (!folder && !path.trim())} onClick={() => void connect()}>{busy ? '连接中…' : '连接并导入'}</button>
          </div>
        ) : null}
      </section>
      {owner ? (
        <section className="settings-section">
          <h3>项目</h3>
          <div className="row-actions">
            <button type="button" className="button secondary" onClick={onRename}>重命名项目</button>
            <button type="button" className="button ghost danger" onClick={onDelete}>删除项目</button>
          </div>
          <p className="muted small">删除项目会删除其中的文档与讨论，但不会删除本地文件夹里的原文件。</p>
        </section>
      ) : null}
    </Modal>
  );
}
