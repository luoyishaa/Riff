import { useEffect, useState, type FormEvent } from 'react';
import type { CollaboratorRole, InvitationDto, MemberDto, PrincipalDto, Role, WorkspaceDetailDto } from '@collab/protocol';
import { api, describeError } from '../api.js';
import { Avatar } from '../components/Avatar.js';
import { useToast } from '../hooks/useToast.js';
import { ROLE_HINT, ROLE_LABEL } from '../lib/permissions.js';
import { Modal } from '../ui/Modal.js';

const ASSIGNABLE: CollaboratorRole[] = ['viewer', 'commenter', 'suggester', 'editor'];

export interface MembersDialogProps {
  open: boolean;
  workspace: WorkspaceDetailDto;
  viewerId: string;
  onClose: () => void;
  onChanged: () => void;
  onConfigureAgent: (agentId: string) => void;
}

/** Owners change roles, remove members, and invite registered accounts by handle or email. */
export function MembersDialog({ open, workspace, viewerId, onClose, onChanged, onConfigureAgent }: MembersDialogProps): React.ReactElement {
  const notify = useToast();
  const [invitations, setInvitations] = useState<InvitationDto[]>([]);
  const [identifier, setIdentifier] = useState('');
  const [role, setRole] = useState<CollaboratorRole>('commenter');
  const [matches, setMatches] = useState<PrincipalDto[]>([]);
  const [busy, setBusy] = useState(false);
  const base = `/api/workspaces/${encodeURIComponent(workspace.id)}`;

  useEffect(() => {
    if (!open) return;
    api<InvitationDto[]>(`${base}/invitations`).then(setInvitations).catch(() => setInvitations([]));
  }, [open, base]);

  useEffect(() => {
    const query = identifier.trim().replace(/^@/u, '');
    if (query.length < 2) { setMatches([]); return undefined; }
    const timer = window.setTimeout(() => {
      api<PrincipalDto[]>(`/api/accounts/search?q=${encodeURIComponent(query)}`)
        .then((found) => setMatches(found.filter((candidate) => !workspace.members.some((member) => member.id === candidate.id))))
        .catch(() => setMatches([]));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [identifier, workspace.members]);

  const invite = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    try {
      const invitation = await api<InvitationDto>(`${base}/invitations`, { body: { identifier: identifier.trim().replace(/^@/u, ''), role } });
      setInvitations((current) => [invitation, ...current.filter((item) => item.id !== invitation.id)]);
      setIdentifier('');
      setMatches([]);
      notify(`已邀请 ${invitation.invitee?.displayName ?? '对方'}，对方接受后加入项目。`, 'success');
    } catch (error) {
      notify(describeError(error, '邀请没有发出。'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (member: MemberDto, next: Role): Promise<void> => {
    try {
      await api(`${base}/members/${encodeURIComponent(member.id)}`, { method: 'PUT', body: { role: next } });
      notify(`${member.displayName} 现在是${ROLE_LABEL[next]}。`, 'success');
      onChanged();
    } catch (error) {
      notify(describeError(error, '角色没有修改成功。'), 'error');
    }
  };

  const remove = async (member: MemberDto): Promise<void> => {
    if (!window.confirm(`把 ${member.displayName} 移出项目？对方将无法再访问项目中的文档。`)) return;
    try {
      await api(`${base}/members/${encodeURIComponent(member.id)}`, { method: 'DELETE' });
      notify(`${member.displayName} 已移出项目。`, 'success');
      onChanged();
    } catch (error) {
      notify(describeError(error, '移除失败。'), 'error');
    }
  };

  const pending = invitations.filter((invitation) => invitation.status === 'pending');
  return (
    <Modal open={open} title="项目成员" description="邀请已注册的账户加入项目，并设置每个人与 Agent 的权限。" onClose={onClose} size="lg">
      <form className="invite-form" onSubmit={(event) => void invite(event)}>
        <label className="field grow">
          <span>邀请成员</span>
          <input value={identifier} onChange={(event) => setIdentifier(event.target.value)} placeholder="对方的账号标识、邮箱或名称" autoComplete="off" />
          {matches.length > 0 ? (
            <div className="lookup-results" role="listbox" aria-label="匹配的账户">
              {matches.map((candidate) => (
                <button key={candidate.id} type="button" role="option" aria-selected={false} className="lookup-result" onClick={() => { setIdentifier(candidate.handle ?? candidate.displayName); setMatches([]); }}>
                  <Avatar id={candidate.id} name={candidate.displayName} kind="human" size="sm" />
                  <span><strong>{candidate.displayName}</strong><small>{candidate.handle ? `@${candidate.handle}` : ''}</small></span>
                </button>
              ))}
            </div>
          ) : null}
        </label>
        <label className="field">
          <span>权限</span>
          <select value={role} onChange={(event) => setRole(event.target.value as CollaboratorRole)}>
            {ASSIGNABLE.map((item) => <option key={item} value={item}>{ROLE_LABEL[item]} · {ROLE_HINT[item]}</option>)}
          </select>
        </label>
        <button type="submit" className="button primary" disabled={busy || !identifier.trim()}>发送邀请</button>
      </form>
      {pending.length > 0 ? (
        <div className="pending-invites">
          <span className="muted">等待接受：</span>
          {pending.map((invitation) => <span key={invitation.id} className="scope-pill">{invitation.invitee?.displayName ?? invitation.principalId} · {ROLE_LABEL[invitation.role]}</span>)}
        </div>
      ) : null}
      <ul className="member-table">
        {workspace.members.map((member) => (
          <li key={member.id} className="member-table-row">
            <Avatar id={member.id} name={member.displayName} kind={member.kind} />
            <span className="member-copy">
              <strong>{member.displayName}{member.id === viewerId ? <span className="muted">（你）</span> : null}</strong>
              <small>{member.kind === 'agent' ? 'Agent' : member.handle ? `@${member.handle}` : ''}</small>
            </span>
            {member.role === 'owner' ? <span className="role-badge role-owner">{ROLE_LABEL.owner}</span> : (
              <select aria-label={`${member.displayName} 的权限`} value={member.role} onChange={(event) => void changeRole(member, event.target.value as Role)}>
                {ASSIGNABLE.map((item) => <option key={item} value={item}>{ROLE_LABEL[item]}</option>)}
              </select>
            )}
            {member.kind === 'agent' ? <button type="button" className="button ghost small" onClick={() => onConfigureAgent(member.id)}>配置</button> : null}
            {member.role !== 'owner' && member.id !== viewerId ? <button type="button" className="button ghost small danger" onClick={() => void remove(member)}>移出</button> : null}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

export function InvitationsDialog({ open, invitations, onClose, onResponded }: { open: boolean; invitations: InvitationDto[]; onClose: () => void; onResponded: (invitation: InvitationDto, accepted: boolean) => void }): React.ReactElement {
  const notify = useToast();
  const respond = async (invitation: InvitationDto, action: 'accept' | 'reject'): Promise<void> => {
    try {
      await api(`/api/invitations/${encodeURIComponent(invitation.id)}/${action}`, { method: 'POST' });
      notify(action === 'accept' ? `已加入“${invitation.workspace?.title ?? '项目'}”。` : '已拒绝邀请。', 'success');
      onResponded(invitation, action === 'accept');
    } catch (error) {
      notify(describeError(error, '操作没有完成。'), 'error');
    }
  };
  return (
    <Modal open={open} title="待处理邀请" description="接受后即可进入对应项目。" onClose={onClose} size="sm">
      {invitations.length === 0 ? <p className="panel-empty">没有待处理的邀请。</p> : (
        <ul className="invitation-list">
          {invitations.map((invitation) => (
            <li key={invitation.id} className="invitation">
              <div>
                <strong>{invitation.workspace?.title ?? '项目'}</strong>
                <small>{invitation.inviter?.displayName ?? '项目所有者'} 邀请你成为{ROLE_LABEL[invitation.role]}</small>
              </div>
              <div className="row-actions">
                <button type="button" className="button ghost small" onClick={() => void respond(invitation, 'reject')}>拒绝</button>
                <button type="button" className="button primary small" onClick={() => void respond(invitation, 'accept')}>接受</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
