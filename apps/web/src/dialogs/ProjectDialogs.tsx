import { useState, type FormEvent } from 'react';
import type { DocumentSummaryDto, LocalProjectStatusDto, WorkspaceDto } from '@collab/protocol';
import { api, describeError } from '../api.js';
import { Icon } from '../components/Icon.js';
import { useToast } from '../hooks/useToast.js';
import { canPickDirectories, pickDirectory, readFolderInput, type PickedFolder } from '../lib/localFolder.js';
import { rememberFolder } from '../lib/folderRegistry.js';
import { Modal } from '../ui/Modal.js';

/** Choose a local folder: the directory picker keeps write access; the input only imports. */
export function FolderChooser({ folder, path, onFolder, onPath, disabled = false }: { folder: PickedFolder | undefined; path: string; onFolder: (folder: PickedFolder | undefined) => void; onPath: (path: string) => void; disabled?: boolean }): React.ReactElement {
  const notify = useToast();
  const choose = async (): Promise<void> => {
    try {
      const picked = await pickDirectory();
      if (picked) onFolder(picked);
    } catch {
      notify('无法读取这个文件夹，可以改填服务端路径。', 'error');
    }
  };
  return (
    <div className="folder-chooser">
      <div className="folder-chooser-row">
        {canPickDirectories() ? (
          <button type="button" className="button secondary" onClick={() => void choose()} disabled={disabled}><Icon name="folder" size={14} />选择文件夹</button>
        ) : (
          <label className="button secondary file-input-button">
            <Icon name="folder" size={14} />选择文件夹
            <input type="file" multiple disabled={disabled} ref={(input) => input?.setAttribute('webkitdirectory', '')} onChange={(event) => { void readFolderInput(event.target.files).then((picked) => onFolder(picked)); event.target.value = ''; }} />
          </label>
        )}
        <span className="folder-chooser-name">{folder ? `${folder.name} · ${folder.files.length} 个 TXT / Markdown 文件` : '未选择'}</span>
        {folder ? <button type="button" className="icon-button" aria-label="取消选择" onClick={() => onFolder(undefined)}><Icon name="close" size={14} /></button> : null}
      </div>
      <label className="field">
        <span>或填写服务端可访问的绝对路径 <em>可持续扫描与写回</em></span>
        <input value={path} onChange={(event) => onPath(event.target.value)} placeholder="例如 D:\docs\thesis" disabled={disabled} />
      </label>
    </div>
  );
}

/** Bind a folder (or a server path) to a project and import its TXT / Markdown files. */
export async function connectFolder(workspaceId: string, folder: PickedFolder | undefined, path: string): Promise<LocalProjectStatusDto> {
  const status = await api<LocalProjectStatusDto>(`/api/workspaces/${encodeURIComponent(workspaceId)}/local-project`, { body: path.trim() ? { path: path.trim() } : { files: folder?.files ?? [] } });
  if (!path.trim() && folder) rememberFolder(workspaceId, folder, status);
  return status;
}

export function NewProjectDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (workspace: WorkspaceDto) => void }): React.ReactElement {
  const notify = useToast();
  const [title, setTitle] = useState('');
  const [folder, setFolder] = useState<PickedFolder>();
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    try {
      const workspace = await api<WorkspaceDto>('/api/workspaces', { body: { title: title.trim() } });
      if (folder || path.trim()) {
        try {
          const status = await connectFolder(workspace.id, folder, path);
          notify(`项目已创建，导入了 ${status.files.length} 个文件。`, 'success');
        } catch (error) {
          notify(describeError(error, '项目已创建，但文件夹没有连接上，可以稍后在项目设置里重试。'), 'error');
        }
      } else {
        notify('项目已创建。', 'success');
      }
      setTitle(''); setFolder(undefined); setPath('');
      onCreated(workspace);
    } catch (error) {
      notify(describeError(error, '项目创建失败。'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} title="新建项目" description="项目把文档、成员和 Agent 放在一起。可以连接一个本地文件夹，里面的 TXT / Markdown 会成为项目文档。" onClose={onClose}>
      <form className="form" onSubmit={(event) => void submit(event)}>
        <label className="field"><span>项目名称</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如 毕业论文" autoFocus /></label>
        <fieldset className="fieldset">
          <legend>本地文件夹 <em>可选</em></legend>
          <FolderChooser folder={folder} path={path} onFolder={setFolder} onPath={setPath} disabled={busy} />
        </fieldset>
        <div className="form-actions">
          <button type="button" className="button ghost" onClick={onClose}>取消</button>
          <button type="submit" className="button primary" disabled={busy || !title.trim()}>{busy ? '创建中…' : '创建项目'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function NewDocumentDialog({ open, workspaceId, onClose, onCreated }: { open: boolean; workspaceId: string | undefined; onClose: () => void; onCreated: (document: DocumentSummaryDto) => void }): React.ReactElement {
  const notify = useToast();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!workspaceId) return;
    setBusy(true);
    try {
      const document = await api<DocumentSummaryDto>(`/api/workspaces/${encodeURIComponent(workspaceId)}/documents`, { body: { title: title.trim() } });
      setTitle('');
      onCreated(document);
    } catch (error) {
      notify(describeError(error, '文档创建失败。'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} title="新建文档" description="名称以 .md 结尾的文档按 Markdown 处理，可以切换预览。" onClose={onClose} size="sm">
      <form className="form" onSubmit={(event) => void submit(event)}>
        <label className="field"><span>文档名称</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如 第一章.md" autoFocus /></label>
        <div className="form-actions">
          <button type="button" className="button ghost" onClick={onClose}>取消</button>
          <button type="submit" className="button primary" disabled={busy || !title.trim()}>创建</button>
        </div>
      </form>
    </Modal>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  /** When set, the user must type this text before confirming. */
  typeToConfirm?: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function ConfirmDialog({ open, title, description, confirmLabel, typeToConfirm, onConfirm, onClose }: ConfirmDialogProps): React.ReactElement {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = typeToConfirm === undefined || typed === typeToConfirm;
  const confirm = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    try { await onConfirm(); setTyped(''); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} title={title} description={description} onClose={onClose} size="sm">
      <form className="form" onSubmit={(event) => void confirm(event)}>
        {typeToConfirm !== undefined ? (
          <label className="field"><span>输入 <strong>{typeToConfirm}</strong> 以确认</span><input value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus /></label>
        ) : null}
        <div className="form-actions">
          <button type="button" className="button ghost" onClick={onClose} autoFocus={typeToConfirm === undefined}>取消</button>
          <button type="submit" className="button danger" disabled={busy || !ready}>{confirmLabel}</button>
        </div>
      </form>
    </Modal>
  );
}

export function RenameDialog({ open, title: initial, onRename, onClose }: { open: boolean; title: string; onRename: (title: string) => Promise<void>; onClose: () => void }): React.ReactElement {
  const [title, setTitle] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} title="重命名项目" description="新名称会立即显示给所有成员。" onClose={onClose} size="sm">
      <form className="form" onSubmit={(event) => { event.preventDefault(); setBusy(true); void onRename(title.trim()).finally(() => setBusy(false)); }}>
        <label className="field"><span>项目名称</span><input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus /></label>
        <div className="form-actions">
          <button type="button" className="button ghost" onClick={onClose}>取消</button>
          <button type="submit" className="button primary" disabled={busy || !title.trim() || title.trim() === initial}>保存</button>
        </div>
      </form>
    </Modal>
  );
}
