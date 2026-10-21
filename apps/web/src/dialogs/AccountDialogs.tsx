import { useState, type FormEvent } from 'react';
import type { DocumentVersionDto, PrincipalDto } from '@collab/protocol';
import { api, describeError } from '../api.js';
import { useToast } from '../hooks/useToast.js';
import { excerpt, fullTime } from '../lib/format.js';
import { Modal } from '../ui/Modal.js';

export function ProfileDialog({ open, principal, onClose, onSaved }: { open: boolean; principal: PrincipalDto; onClose: () => void; onSaved: (principal: PrincipalDto) => void }): React.ReactElement {
  const notify = useToast();
  const [displayName, setDisplayName] = useState(principal.displayName);
  const [handle, setHandle] = useState(principal.handle ?? '');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    try {
      const updated = await api<PrincipalDto>('/api/account', { method: 'PATCH', body: { displayName: displayName.trim(), ...(handle.trim() ? { handle: handle.trim() } : {}) } });
      notify('个人资料已更新。', 'success');
      onSaved(updated);
    } catch (error) {
      notify(describeError(error, '资料没有保存。'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} title="个人资料" description="显示名称会出现在评论、头像和协作者光标上；账号标识用于登录和被邀请。" onClose={onClose} size="sm">
      <form className="form" onSubmit={(event) => void submit(event)}>
        <label className="field"><span>显示名称</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoFocus /></label>
        <label className="field"><span>账号标识</span><input value={handle} onChange={(event) => setHandle(event.target.value.replace(/\s+/gu, '').toLowerCase())} /></label>
        <div className="form-actions">
          <button type="button" className="button ghost" onClick={onClose}>取消</button>
          <button type="submit" className="button primary" disabled={busy || !displayName.trim()}>保存</button>
        </div>
      </form>
    </Modal>
  );
}

const VERSION_LABEL = (version: DocumentVersionDto): string => {
  if (version.kind === 'restore') return '恢复前自动保存';
  return version.phase === 'after' ? '接受修改后' : '接受修改前';
};

export interface VersionHistoryProps {
  open: boolean;
  versions: DocumentVersionDto[];
  canRestore: boolean;
  nameOf: (principalId: string) => string;
  onRestore: (version: DocumentVersionDto) => void;
  onClose: () => void;
}

/** Immutable snapshots around every accepted change; restoring one keeps the current text too. */
export function VersionHistory({ open, versions, canRestore, nameOf, onRestore, onClose }: VersionHistoryProps): React.ReactElement {
  const [selected, setSelected] = useState<string>();
  const ordered = [...versions].sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
  const current = ordered.find((version) => version.id === selected) ?? ordered[0];
  return (
    <Modal open={open} title="版本历史" description="每次接受修改前后都会保存版本；恢复前会先保存当前正文，所以恢复本身也可以撤回。" onClose={onClose} size="lg">
      <div className="versions">
        <ol className="version-list">
          {ordered.map((version) => (
            <li key={version.id}>
              <button type="button" className={`version-row${version.id === current?.id ? ' is-selected' : ''}`} onClick={() => setSelected(version.id)}>
                <strong>{VERSION_LABEL(version)}</strong>
                <small>{nameOf(version.createdBy)} · {fullTime(version.createdAt)}</small>
                <span className="muted">{excerpt(version.text, 46) || '（空文档）'}</span>
              </button>
            </li>
          ))}
        </ol>
        <div className="version-preview">
          {current ? (
            <>
              <pre>{current.text || '（空文档）'}</pre>
              {canRestore ? <button type="button" className="button primary" onClick={() => onRestore(current)}>恢复到这个版本</button> : <p className="muted">编辑者以上可以恢复版本。</p>}
            </>
          ) : <p className="panel-empty">还没有版本。接受一条修改后会自动保存。</p>}
        </div>
      </div>
    </Modal>
  );
}
