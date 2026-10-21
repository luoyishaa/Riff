import { useEffect, useState, type FormEvent } from 'react';
import type { AccessPolicy, AgentSummaryDto, CollaboratorRole, ContextStrategy, CreatedAgentResponse, ModelProviderDto, ModelProviderId, Role } from '@collab/protocol';
import { api, describeError } from '../api.js';
import { Avatar } from '../components/Avatar.js';
import { agentConnectionLabel } from '../components/MembersPanel.js';
import { useToast } from '../hooks/useToast.js';
import { agentStatusText } from '../lib/agentStatus.js';
import { atMost, ROLE_HINT, ROLE_LABEL } from '../lib/permissions.js';
import { Modal } from '../ui/Modal.js';

const ROLES: CollaboratorRole[] = ['commenter', 'suggester', 'editor'];
const STRATEGIES: Array<{ value: ContextStrategy; label: string; hint: string }> = [
  { value: 'selection', label: '仅选区', hint: '选中的文字与讨论' },
  { value: 'window', label: '附近段落', hint: '选区前后段落、大纲与讨论（推荐）' },
  { value: 'full', label: '全文', hint: '整篇文档与讨论' },
];

export type AgentDrawerMode = { kind: 'create' } | { kind: 'configure'; agentId: string };

export interface AgentDrawerProps {
  open: boolean;
  mode: AgentDrawerMode;
  docId: string;
  role: Role;
  agents: AgentSummaryDto[];
  onClose: () => void;
  onChanged: () => void;
  onOpenProviders: () => void;
}

function useConnectedProviders(open: boolean): ModelProviderDto[] {
  const [providers, setProviders] = useState<ModelProviderDto[]>([]);
  useEffect(() => {
    if (!open) return;
    api<{ providers: ModelProviderDto[] }>('/api/model-providers').then((value) => setProviders(value.providers.filter((provider) => provider.state === 'connected'))).catch(() => setProviders([]));
  }, [open]);
  return providers;
}

export function AgentDrawer({ open, mode, docId, role, agents, onClose, onChanged, onOpenProviders }: AgentDrawerProps): React.ReactElement {
  const agent = mode.kind === 'configure' ? agents.find((item) => item.id === mode.agentId) : undefined;
  return (
    <Modal open={open} variant="drawer" title={agent ? `${agent.displayName} · 配置` : '添加 Agent'} description={agent ? 'Agent 是项目成员：它的角色决定能否提出修改，所有修改都要人来审批。' : '为这个项目添加一个 Agent。之后在评论里 @ 它，它会回复并提出可审批的修改。'} onClose={onClose}>
      {mode.kind === 'create' ? <CreateAgent docId={docId} role={role} open={open} onCreated={() => { onChanged(); onClose(); }} onOpenProviders={onOpenProviders} /> : null}
      {agent ? <ConfigureAgent key={agent.id} agent={agent} docId={docId} role={role} open={open} onChanged={onChanged} onOpenProviders={onOpenProviders} /> : null}
    </Modal>
  );
}

function ProviderPicker({ providers, value, onChange, onOpenProviders }: { providers: ModelProviderDto[]; value: ModelProviderId | 'mock'; onChange: (value: ModelProviderId | 'mock') => void; onOpenProviders: () => void }): React.ReactElement {
  return (
    <div className="provider-picker" role="radiogroup" aria-label="连接方式">
      <button type="button" role="radio" aria-checked={value === 'mock'} className={`provider-option${value === 'mock' ? ' is-selected' : ''}`} onClick={() => onChange('mock')}>
        <strong>内置演示</strong><small>按“把「A」改成「B」”规则回复，无需模型</small>
      </button>
      {providers.map((provider) => (
        <button key={provider.id} type="button" role="radio" aria-checked={value === provider.id} className={`provider-option${value === provider.id ? ' is-selected' : ''}`} onClick={() => onChange(provider.id)}>
          <strong>{provider.displayName}</strong><small>{provider.detail}</small>
        </button>
      ))}
      <button type="button" className="provider-option is-link" onClick={onOpenProviders}><strong>连接更多模型…</strong><small>Codex、Claude Code、DeepSeek、OpenRouter 等</small></button>
    </div>
  );
}

function CreateAgent({ docId, role, open, onCreated, onOpenProviders }: { docId: string; role: Role; open: boolean; onCreated: () => void; onOpenProviders: () => void }): React.ReactElement {
  const notify = useToast();
  const providers = useConnectedProviders(open);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<ModelProviderId | 'mock'>('mock');
  const [grantedRole, setGrantedRole] = useState<CollaboratorRole>(atMost('suggester', role) ? 'suggester' : 'commenter');
  const [contextStrategy, setContextStrategy] = useState<ContextStrategy>('window');
  const [accessPolicy, setAccessPolicy] = useState<AccessPolicy>('public');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    try {
      const created = await api<CreatedAgentResponse>(`/api/docs/${encodeURIComponent(docId)}/agents`, {
        body: { displayName: name.trim(), grantedRole, contextStrategy, accessPolicy, ...(provider === 'mock' ? {} : { providerId: provider }) },
      });
      notify(`${created.agent.displayName} 已加入项目，在评论里 @${created.agent.displayName} 即可使用。`, 'success');
      onCreated();
    } catch (error) {
      notify(describeError(error, 'Agent 没有创建成功。'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="form" onSubmit={(event) => void submit(event)}>
      <label className="field"><span>名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 Polisher" autoFocus /></label>
      <fieldset className="fieldset"><legend>连接方式</legend><ProviderPicker providers={providers} value={provider} onChange={setProvider} onOpenProviders={onOpenProviders} /></fieldset>
      <PolicyFields role={role} grantedRole={grantedRole} contextStrategy={contextStrategy} accessPolicy={accessPolicy} onRole={setGrantedRole} onStrategy={setContextStrategy} onAccess={setAccessPolicy} />
      <div className="form-actions"><button type="submit" className="button primary" disabled={busy || !name.trim()}>{busy ? '添加中…' : '添加 Agent'}</button></div>
    </form>
  );
}

function ConfigureAgent({ agent, docId, role, open, onChanged, onOpenProviders }: { agent: AgentSummaryDto; docId: string; role: Role; open: boolean; onChanged: () => void; onOpenProviders: () => void }): React.ReactElement {
  const notify = useToast();
  const providers = useConnectedProviders(open);
  const [grantedRole, setGrantedRole] = useState<CollaboratorRole>(agent.grantedRole === 'owner' || agent.grantedRole === 'viewer' ? 'commenter' : agent.grantedRole);
  const [contextStrategy, setContextStrategy] = useState(agent.contextStrategy);
  const [accessPolicy, setAccessPolicy] = useState(agent.accessPolicy);
  const [model, setModel] = useState(agent.model ?? '');
  const [busy, setBusy] = useState(false);
  const base = `/api/docs/${encodeURIComponent(docId)}/agents/${encodeURIComponent(agent.id)}`;
  const run = async (work: () => Promise<unknown>, success: string, failure: string): Promise<void> => {
    setBusy(true);
    try { await work(); notify(success, 'success'); onChanged(); } catch (error) { notify(describeError(error, failure), 'error'); } finally { setBusy(false); }
  };
  const bind = (value: ModelProviderId | 'mock'): void => {
    if (value === 'mock') { void run(() => api(base, { method: 'DELETE' }), '已切换为内置演示。', '没有切换成功。'); return; }
    void run(() => api(`${base}/bind-provider`, { body: { providerId: value } }), '连接已切换。', '没有切换成功。');
  };
  return (
    <div className="form">
      <div className="agent-summary">
        <Avatar id={agent.id} name={agent.displayName} kind="agent" size="lg" working={agent.state === 'working'} />
        <div>
          <strong>{agent.displayName}</strong>
          <small>{agentConnectionLabel(agent)}{agent.sessionOnly ? ' · 密钥只保存在当前服务进程' : ''}</small>
          <small className={`agent-state is-${agent.state}`}>{agentStatusText(agent.displayName, agent.state, agent.errorKind)}</small>
        </div>
      </div>
      <fieldset className="fieldset"><legend>连接方式</legend><ProviderPicker providers={providers} value={agent.adapter === 'mock' ? 'mock' : agent.providerId ?? 'mock'} onChange={bind} onOpenProviders={onOpenProviders} /></fieldset>
      {agent.adapter === 'openai-compatible' ? <label className="field"><span>模型 ID</span><input value={model} onChange={(event) => setModel(event.target.value)} placeholder="提供商的模型 ID" /></label> : null}
      <PolicyFields role={role} grantedRole={grantedRole} contextStrategy={contextStrategy} accessPolicy={accessPolicy} onRole={setGrantedRole} onStrategy={setContextStrategy} onAccess={setAccessPolicy} />
      <div className="form-actions">
        <button type="button" className="button primary" disabled={busy} onClick={() => void run(() => api(base, { method: 'PATCH', body: { grantedRole, contextStrategy, accessPolicy, ...(agent.adapter === 'openai-compatible' && model.trim() ? { model: model.trim() } : {}) } }), '已保存。', '没有保存成功。')}>保存</button>
      </div>
    </div>
  );
}

function PolicyFields(props: { role: Role; grantedRole: CollaboratorRole; contextStrategy: ContextStrategy; accessPolicy: AccessPolicy; onRole: (role: CollaboratorRole) => void; onStrategy: (strategy: ContextStrategy) => void; onAccess: (policy: AccessPolicy) => void }): React.ReactElement {
  return (
    <>
      <label className="field">
        <span>角色</span>
        <select value={props.grantedRole} onChange={(event) => props.onRole(event.target.value as CollaboratorRole)}>
          {ROLES.filter((item) => atMost(item, props.role)).map((item) => <option key={item} value={item}>{ROLE_LABEL[item]} · {ROLE_HINT[item]}</option>)}
        </select>
        <small className="field-hint">每次运行的实际权限还会受触发它的人的角色限制。</small>
      </label>
      <label className="field">
        <span>上下文</span>
        <select value={props.contextStrategy} onChange={(event) => props.onStrategy(event.target.value as ContextStrategy)}>
          {STRATEGIES.map((item) => <option key={item.value} value={item.value}>{item.label} · {item.hint}</option>)}
        </select>
      </label>
      <label className="field">
        <span>谁可以使用</span>
        <select value={props.accessPolicy} onChange={(event) => props.onAccess(event.target.value as AccessPolicy)}>
          <option value="public">所有项目成员</option>
          <option value="private">只有我和文档所有者</option>
        </select>
      </label>
    </>
  );
}
