import type { AgentSummaryDto, DocumentDto, MemberDto } from '@collab/protocol';
import type { ConnectionStatus } from '../collab/connection.js';
import { ROLE_LABEL } from '../lib/permissions.js';
import { Avatar } from './Avatar.js';
import { Icon } from './Icon.js';

export interface DocumentHeaderProps {
  document: DocumentDto;
  status: ConnectionStatus;
  online: MemberDto[];
  agents: AgentSummaryDto[];
  viewMode: 'source' | 'preview';
  versionCount: number;
  onViewMode: (mode: 'source' | 'preview') => void;
  onOpenVersions: () => void;
  onOpenAgent: (agentId: string) => void;
}

const STATUS_TEXT: Record<ConnectionStatus, string> = { connected: '已同步', connecting: '连接中…', offline: '已断开，正在重连' };

export function DocumentHeader({ document, status, online, agents, viewMode, versionCount, onViewMode, onOpenVersions, onOpenAgent }: DocumentHeaderProps): React.ReactElement {
  const people = online.filter((member) => member.kind === 'human');
  return (
    <div className="doc-header">
      <div className="doc-title">
        <h1 title={document.title}>{document.title}</h1>
        <div className="doc-meta">
          {document.relativePath ? <span className="doc-path">{document.relativePath}</span> : null}
          <span className={`role-badge role-${document.role}`}>{ROLE_LABEL[document.role]}</span>
          <span className={`sync-status is-${status}`}><span className="sync-dot" aria-hidden="true" />{STATUS_TEXT[status]}</span>
        </div>
      </div>
      <div className="doc-actions">
        <div className="presence" aria-label={`${people.length} 人在线，${agents.length} 个 Agent`}>
          {people.slice(0, 5).map((member) => <Avatar key={member.id} id={member.id} name={member.displayName} kind="human" size="sm" />)}
          {people.length > 5 ? <span className="presence-more">+{people.length - 5}</span> : null}
          {agents.map((agent) => (
            <button key={agent.id} type="button" className="presence-agent" onClick={() => onOpenAgent(agent.id)} title={`${agent.displayName}${agent.state === 'working' ? '：正在处理' : ''}`}>
              <Avatar id={agent.id} name={agent.displayName} kind="agent" size="sm" working={agent.state === 'working'} />
            </button>
          ))}
        </div>
        {document.kind === 'markdown' ? (
          <div className="segmented" role="group" aria-label="Markdown 视图">
            <button type="button" aria-pressed={viewMode === 'source'} className={viewMode === 'source' ? 'is-active' : ''} onClick={() => onViewMode('source')}><Icon name="code" size={14} />源码</button>
            <button type="button" aria-pressed={viewMode === 'preview'} className={viewMode === 'preview' ? 'is-active' : ''} onClick={() => onViewMode('preview')}><Icon name="eye" size={14} />预览</button>
          </div>
        ) : null}
        <button type="button" className="button ghost small" onClick={onOpenVersions} disabled={versionCount === 0} title={versionCount ? '查看并恢复历史版本' : '接受修改后会在这里保留版本'}>
          <Icon name="history" size={14} />版本{versionCount ? ` ${versionCount}` : ''}
        </button>
      </div>
    </div>
  );
}
