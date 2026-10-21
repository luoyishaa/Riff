import type { AgentSummaryDto, MemberDto, ModelProviderId, Role } from '@collab/protocol';
import { agentStatusText } from '../lib/agentStatus.js';
import { can, ROLE_LABEL } from '../lib/permissions.js';
import { Avatar } from './Avatar.js';
import { Icon } from './Icon.js';

export const PROVIDER_LABEL: Record<ModelProviderId, string> = {
  'codex-cli': 'Codex CLI',
  'claude-code': 'Claude Code',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  'openai-api': 'OpenAI API',
  'openai-compatible': '自定义接口',
};

export function agentConnectionLabel(agent: AgentSummaryDto): string {
  if (agent.adapter === 'mock') return '内置演示（Mock）';
  const provider = agent.providerId ? PROVIDER_LABEL[agent.providerId] : agent.adapter === 'cli' ? '命令行' : 'API';
  return agent.model ? `${provider} · ${agent.model}` : provider;
}

export interface MembersPanelProps {
  members: MemberDto[];
  agents: AgentSummaryDto[];
  onlineIds: Set<string>;
  role: Role;
  workspaceRole: Role | undefined;
  onManageMembers: () => void;
  onConfigureAgent: (agentId: string) => void;
  onAddAgent: () => void;
}

export function MembersPanel({ members, agents, onlineIds, role, workspaceRole, onManageMembers, onConfigureAgent, onAddAgent }: MembersPanelProps): React.ReactElement {
  const people = members.filter((member) => member.kind === 'human').sort((left, right) => Number(onlineIds.has(right.id)) - Number(onlineIds.has(left.id)));
  return (
    <div className="members-panel">
      <section>
        <div className="panel-heading">
          <h3>成员 <span className="muted">{onlineIds.size} 人在线</span></h3>
          {can(workspaceRole, 'manage') ? <button type="button" className="button ghost small" onClick={onManageMembers}><Icon name="users" size={14} />管理</button> : null}
        </div>
        <ul className="member-list">
          {people.map((member) => (
            <li key={member.id} className="member-row">
              <Avatar id={member.id} name={member.displayName} kind="human" online={onlineIds.has(member.id)} />
              <span className="member-copy"><strong>{member.displayName}</strong><small>{member.handle ? `@${member.handle} · ` : ''}{ROLE_LABEL[member.role]}</small></span>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <div className="panel-heading">
          <h3>Agent</h3>
          {can(role, 'comment') ? <button type="button" className="button ghost small" onClick={onAddAgent}><Icon name="plus" size={14} />添加</button> : null}
        </div>
        {agents.length === 0 ? <p className="panel-empty">还没有 Agent。添加后在评论里 @ 它就会回复并提出可审批的修改。</p> : (
          <ul className="member-list">
            {agents.map((agent) => (
              <li key={agent.id} className="member-row agent-row">
                <Avatar id={agent.id} name={agent.displayName} kind="agent" working={agent.state === 'working'} />
                <span className="member-copy">
                  <strong>{agent.displayName}{agent.accessPolicy === 'private' ? <span className="scope-pill">私有</span> : null}</strong>
                  <small>{agentConnectionLabel(agent)} · {ROLE_LABEL[agent.grantedRole]}</small>
                  {agent.state !== 'idle' ? <small className={`agent-state is-${agent.state}`}>{agentStatusText(agent.displayName, agent.state, agent.errorKind)}</small> : null}
                </span>
                {agent.canManage ? <button type="button" className="button ghost small" onClick={() => onConfigureAgent(agent.id)}>配置</button> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
