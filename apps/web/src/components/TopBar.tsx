import type { PrincipalDto, WorkspaceDto } from '@collab/protocol';
import type { SavedAccount } from '../lib/storage.js';
import { ROLE_LABEL } from '../lib/permissions.js';
import { Menu } from '../ui/Menu.js';
import { Brand } from './AuthScreen.js';
import { Avatar } from './Avatar.js';
import { Icon } from './Icon.js';

export interface TopBarProps {
  principal: PrincipalDto;
  workspaces: WorkspaceDto[];
  workspaceId: string | undefined;
  invitationCount: number;
  savedAccounts: SavedAccount[];
  onSelectWorkspace: (workspaceId: string) => void;
  onNewProject: () => void;
  onOpenInvitations: () => void;
  onOpenProviders: () => void;
  onEditProfile: () => void;
  onSwitchAccount: (account: SavedAccount) => void;
  onForgetAccounts: () => void;
  onSignOut: () => void;
}

export function TopBar(props: TopBarProps): React.ReactElement {
  const { principal, workspaces, workspaceId } = props;
  const current = workspaces.find((workspace) => workspace.id === workspaceId);
  const otherAccounts = props.savedAccounts.filter((account) => account.principalId !== principal.id);
  return (
    <header className="topbar">
      <Brand />
      <span className="topbar-divider" aria-hidden="true" />
      <Menu
        label="切换项目"
        trigger={({ open, toggle }) => (
          <button type="button" className="project-switcher" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
            <span className="project-switcher-name">{current?.title ?? (workspaces.length ? '选择项目' : '还没有项目')}</span>
            {current ? <span className="project-switcher-meta">{ROLE_LABEL[current.role]}</span> : null}
            <Icon name="chevronDown" size={14} />
          </button>
        )}
        sections={[
          {
            title: workspaces.length ? '我的项目' : undefined,
            items: workspaces.map((workspace) => ({
              id: workspace.id,
              label: workspace.title,
              hint: `${workspace.documents.length} 份文档 · ${ROLE_LABEL[workspace.role]}`,
              selected: workspace.id === workspaceId,
              onSelect: () => props.onSelectWorkspace(workspace.id),
            })),
          },
          { items: [{ id: 'new', label: <><Icon name="plus" size={14} /> 新建项目</>, onSelect: props.onNewProject }] },
        ]}
      />
      <span className="topbar-spacer" />
      {props.invitationCount > 0 ? (
        <button type="button" className="topbar-chip is-attention" onClick={props.onOpenInvitations}>
          <Icon name="inbox" size={14} /> 待处理邀请 <span className="count">{props.invitationCount}</span>
        </button>
      ) : null}
      <button type="button" className="topbar-chip" onClick={props.onOpenProviders}><Icon name="spark" size={14} /> 模型</button>
      <Menu
        label="账户"
        align="end"
        header={<div className="account-summary"><Avatar id={principal.id} name={principal.displayName} kind="human" /><span><strong>{principal.displayName}</strong><small>{principal.handle ? `@${principal.handle}` : principal.id}</small></span></div>}
        trigger={({ open, toggle }) => (
          <button type="button" className="account-trigger" aria-haspopup="menu" aria-expanded={open} aria-label="账户菜单" onClick={toggle}>
            <Avatar id={principal.id} name={principal.displayName} kind="human" />
          </button>
        )}
        sections={[
          {
            title: otherAccounts.length ? '切换到本机保存的账号' : undefined,
            items: otherAccounts.map((account) => ({
              id: account.identifier,
              label: account.displayName,
              hint: account.handle ? `@${account.handle}` : account.identifier,
              onSelect: () => props.onSwitchAccount(account),
            })),
          },
          {
            items: [
              { id: 'profile', label: '编辑个人资料', onSelect: props.onEditProfile },
              { id: 'providers', label: '模型提供商', onSelect: props.onOpenProviders },
              ...(props.savedAccounts.length ? [{ id: 'forget', label: '清除本机保存的账号', onSelect: props.onForgetAccounts }] : []),
              { id: 'logout', label: <><Icon name="logout" size={14} /> 退出登录</>, danger: true, onSelect: props.onSignOut },
            ],
          },
        ]}
      />
    </header>
  );
}
