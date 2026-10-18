import { useEffect, useMemo, useState } from 'react';
import { agentStatusCopy, type AgentFailureKind } from './agentStatus.js';

export type AgentSummary = {
  id: string;
  displayName: string;
  adapter: string;
  contextStrategy: 'selection' | 'window' | 'full';
  grantedRole: string;
  accessPolicy?: 'public' | 'private';
  status: 'working' | 'idle' | 'failed';
  error?: string;
  errorKind?: AgentFailureKind;
};

type AdapterConfig =
  | { type: 'mock' }
  | { type: 'openai-compatible'; baseUrl: string; apiKeyEnv: string; model: string }
  | { type: 'cli'; command: string; args?: string[]; timeoutMs?: number; includeSystemInPrompt?: boolean }
  | { type: 'openai-responses'; baseUrl: string; accessTokenEnv: string; model: string; profileId?: string; ownerPrincipalId?: string };

type AgentConfig = {
  principalId: string;
  adapter: AdapterConfig;
  grantedRole: 'viewer' | 'commenter' | 'suggester' | 'editor' | 'owner';
  contextStrategy: 'selection' | 'window' | 'full';
  accessPolicy: 'public' | 'private';
};

type ModelProvider = {
  id: string;
  displayName: string;
  kind: 'cli' | 'api-key';
  description: string;
  state: 'connected' | 'not-connected' | 'unavailable' | 'error';
  detail: string;
  baseUrl?: string;
  defaultModel?: string;
  models?: Array<{ slug: string; displayName: string }>;
};

type Props = {
  docId: string;
  agents: AgentSummary[];
  owner: boolean;
  allowCreate?: boolean;
  onOpenProviders?: () => void;
  onUpdated: () => void;
};

async function readJson<T>(url: string, options: RequestInit = {}): Promise<{ ok: boolean; value: T | null }> {
  const response = await fetch(url, { credentials: 'include', ...options });
  const value = (await response.json()) as T | { error?: { message?: string } };
  return { ok: response.ok, value: response.ok ? (value as T) : null };
}

function defaultConfig(agent: AgentSummary): AgentConfig {
  const adapter: AdapterConfig = agent.adapter === 'openai-compatible'
    ? { type: 'openai-compatible', baseUrl: '', apiKeyEnv: '', model: '' }
    : agent.adapter === 'cli'
      ? { type: 'cli', command: '', args: [], timeoutMs: 30000 }
      : agent.adapter === 'openai-responses' || agent.adapter === 'chatgpt-plan'
        ? { type: 'mock' }
      : { type: 'mock' };
  return {
    principalId: agent.id,
    adapter,
    grantedRole: (['viewer', 'commenter', 'suggester', 'editor', 'owner'].includes(agent.grantedRole) ? agent.grantedRole : 'suggester') as AgentConfig['grantedRole'],
    contextStrategy: agent.contextStrategy,
    accessPolicy: agent.accessPolicy ?? 'public',
  };
}

function selectedProvider(config: AgentConfig): 'codex' | 'claude' | 'openai-compatible' | null {
  if (config.adapter.type === 'openai-compatible') return 'openai-compatible';
  if (config.adapter.type !== 'cli') return null;
  if (config.adapter.command === 'codex') return 'codex';
  if (config.adapter.command === 'claude') return 'claude';
  return null;
}

function AgentConfigCard({ docId, agent, owner, modelProviders, onBindProvider, onUpdated }: {
  docId: string;
  agent: AgentSummary;
  owner: boolean;
  modelProviders: ModelProvider[];
  onBindProvider: (provider: ModelProvider, agent: AgentSummary, config: AgentConfig) => Promise<AgentConfig | null>;
  onUpdated: () => void;
}): React.ReactElement {
  const [config, setConfig] = useState<AgentConfig>(() => defaultConfig(agent));
  const [message, setMessage] = useState('');
  const headers = useMemo(() => ({ 'Content-Type': 'application/json' }), []);
  const activeProvider = selectedProvider(config);
  useEffect(() => {
    let active = true;
    void readJson<AgentConfig>(`/api/docs/${docId}/agents/${agent.id}`, { headers }).then((result) => {
      if (active && result.ok && result.value) setConfig(result.value);
    });
    return () => { active = false; };
  }, [docId, agent.id, headers]);

  const bindProvider = async (provider: ModelProvider) => {
    const next = await onBindProvider(provider, agent, config);
    if (next) {
      setConfig(next);
      setMessage(`已绑定 ${provider.displayName}`);
      onUpdated();
    }
  };

  const save = async () => {
    const result = await readJson<AgentConfig>(`/api/docs/${docId}/agents/${agent.id}`, { method: 'PUT', headers, body: JSON.stringify(config) });
    setMessage(result.ok ? '配置已保存' : '保存失败');
    if (result.ok) { if (result.value) setConfig(result.value); onUpdated(); }
  };

  const reset = async () => {
    const result = await readJson<{ ok: boolean }>(`/api/docs/${docId}/agents/${agent.id}`, { method: 'DELETE', headers, body: '{}' });
    setMessage(result.ok ? '已恢复安全默认' : '恢复失败');
    if (result.ok) { setConfig(defaultConfig({ ...agent, adapter: 'mock', contextStrategy: 'window' })); onUpdated(); }
  };

  return (
    <div className="agent-card agent-config-card">
      <div className="agent-card-heading">
        <span className="avatar agent">AI</span>
        <div><strong>{agent.displayName}</strong><p>{agent.adapter} · {agent.accessPolicy === 'private' ? '私有' : '公开'} · {agent.contextStrategy}</p></div>
        <span className={`agent-status ${agent.status}`}>{agentStatusCopy(agent.displayName, agent.status, agent.error, agent.errorKind).label}</span>
      </div>
      {agent.status === 'failed' ? <p className="agent-status-detail" role="status">{agentStatusCopy(agent.displayName, agent.status, agent.error, agent.errorKind).detail}</p> : null}
      {owner ? (
        <div className="agent-config-form">
          <div className="provider-strip">
            {modelProviders.map((provider) => {
              const selected = (provider.id === 'codex-cli' && activeProvider === 'codex') || (provider.id === 'claude-code' && activeProvider === 'claude') || (provider.kind === 'api-key' && activeProvider === 'openai-compatible' && config.adapter.type === 'openai-compatible' && provider.baseUrl === config.adapter.baseUrl);
              return <button className={`provider-chip ${selected ? 'selected' : ''}`} key={provider.id} type="button" aria-pressed={selected} onClick={() => void bindProvider(provider)} disabled={provider.state !== 'connected'}><span className={`provider-dot ${provider.state === 'connected' ? 'good' : provider.state === 'error' ? 'warn' : 'muted'}`} /><span>{provider.displayName}</span><span className="provider-selected-mark" aria-hidden="true">{selected ? '✓' : ''}</span><small>{selected ? '当前使用' : provider.state === 'connected' ? '已连接' : provider.state === 'error' ? '需重新授权' : '未连接'}</small></button>;
            })}
          </div>
          <label>交互权限<select value={config.accessPolicy} onChange={(event) => setConfig((current) => ({ ...current, accessPolicy: event.target.value as AgentConfig['accessPolicy'] }))}><option value="public">公开：文档成员可交互</option><option value="private">私有：仅所有者与文档 owner</option></select></label>
          <label>授予角色<select value={config.grantedRole} onChange={(event) => setConfig((current) => ({ ...current, grantedRole: event.target.value as AgentConfig['grantedRole'] }))}><option value="viewer">viewer</option><option value="commenter">commenter</option><option value="suggester">suggester</option><option value="editor">editor</option></select></label>
          <label>上下文<select value={config.contextStrategy} onChange={(event) => setConfig((current) => ({ ...current, contextStrategy: event.target.value as AgentConfig['contextStrategy'] }))}><option value="selection">选区</option><option value="window">附近窗口</option><option value="full">全文</option></select></label>
          {config.adapter.type === 'openai-compatible' ? <>
            <label>Base URL<input value={config.adapter.baseUrl} readOnly aria-readonly="true" /></label>
            <label>模型 ID<input value={config.adapter.model} placeholder="填写该提供商支持的模型 ID" onChange={(event) => setConfig((current) => ({ ...current, adapter: current.adapter.type === 'openai-compatible' ? { ...current.adapter, model: event.target.value } : current.adapter }))} /></label>
            <small className="field-hint">API key 由“模型提供商”统一管理，这里只调整当前 Agent 使用的模型。</small>
          </> : null}
          {config.adapter.type === 'openai-responses' ? <p className="field-hint">当前 Agent 使用了已移除的 ChatGPT 计划连接，请切换到上方的 CLI 或 API 提供商。</p> : null}
          {config.adapter.type === 'cli' ? <label>自定义命令<input value={config.adapter.command} placeholder="留空则使用上方预设" onChange={(event) => setConfig((current) => ({ ...current, adapter: current.adapter.type === 'cli' ? { ...current.adapter, command: event.target.value } : current.adapter }))} /></label> : null}
          <div className="agent-form-actions"><button className="action-button" type="button" onClick={() => void save()}>保存权限</button><button className="subtle-button" type="button" onClick={() => void reset()}>恢复默认</button>{message ? <small className="agent-config-message">{message}</small> : null}</div>
        </div>
      ) : null}
    </div>
  );
}

export function AgentConfigPanel({ docId, agents, owner, allowCreate = true, onOpenProviders, onUpdated }: Props): React.ReactElement {
  const [modelProviders, setModelProviders] = useState<ModelProvider[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<'mock' | `provider:${string}`>('mock');
  const [role, setRole] = useState<'viewer' | 'commenter' | 'suggester' | 'editor'>('suggester');
  const [accessPolicy, setAccessPolicy] = useState<'public' | 'private'>('public');
  const [createMessage, setCreateMessage] = useState('');
  const headers = useMemo(() => ({ 'Content-Type': 'application/json' }), []);

  const refreshModelProviders = async () => {
    if (!owner) return;
    const result = await readJson<{ providers: ModelProvider[] }>('/api/model-providers');
    if (result.ok && result.value?.providers) setModelProviders(result.value.providers);
  };

  useEffect(() => { void refreshModelProviders(); }, [owner]);

  const bindProvider = async (provider: ModelProvider, agent: AgentSummary, config: AgentConfig): Promise<AgentConfig | null> => {
    const selectedModel = provider.kind === 'api-key'
        ? config.adapter.type === 'openai-compatible' && config.adapter.model ? config.adapter.model : provider.models?.[0]?.slug
        : undefined;
    const body = {
      providerId: provider.id,
      ...(selectedModel === undefined ? {} : { model: selectedModel }),
      grantedRole: config.grantedRole,
      contextStrategy: config.contextStrategy,
      accessPolicy: config.accessPolicy,
    };
    const result = await readJson<{ config: AgentConfig }>(`/api/docs/${docId}/agents/${agent.id}/bind-provider`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!result.ok || !result.value) return null;
    return result.value.config;
  };

  const createAgent = async () => {
    if (!name.trim()) { setCreateMessage('请填写 Agent 名称'); return; }
    const selectedProvider = provider.startsWith('provider:') ? modelProviders.find((item) => item.id === provider.slice('provider:'.length)) : undefined;
    if (provider.startsWith('provider:') && (!selectedProvider || selectedProvider.state !== 'connected')) { setCreateMessage('请先在顶部模型设置中连接该提供商'); return; }
    const result = await readJson<{ config: AgentConfig }>(`/api/docs/${docId}/agents`, { method: 'POST', headers, body: JSON.stringify({ displayName: name.trim(), provider: 'mock', grantedRole: role, contextStrategy: 'window', accessPolicy }) });
    if (result.ok && result.value) {
      let message = 'Agent 已加入文档';
      if (selectedProvider) {
        const createdAgent: AgentSummary = { id: result.value.config.principalId, displayName: name.trim(), adapter: 'mock', contextStrategy: 'window', grantedRole: role, accessPolicy, status: 'idle' };
        const bound = await bindProvider(selectedProvider, createdAgent, result.value.config);
        message = bound ? `Agent 已加入并绑定 ${selectedProvider.displayName}` : 'Agent 已加入，但提供商绑定失败，请稍后在配置中重试';
      }
      setName(''); setCreateMessage(message); setShowCreate(false); onUpdated();
    }
    else setCreateMessage('创建失败，请检查权限或连接配置');
  };

  return <>
    {owner ? <section className="agent-provider-binding" aria-label="Agent 模型连接">
      <div><strong>模型连接</strong><p>连接在全局提供商里管理；这里仅选择当前 Agent 使用的连接和模型。</p></div>
      {onOpenProviders ? <button className="subtle-button" type="button" onClick={onOpenProviders}>管理提供商</button> : null}
    </section> : null}
    {owner && allowCreate ? <div className="agent-create-block">
      <div className="agent-create-head"><div><strong>添加 Agent</strong><p>把本机 CLI 或模型接口注册为文档成员。</p></div><button className="subtle-button" type="button" onClick={() => setShowCreate((value) => !value)}>{showCreate ? '收起' : '新建'}</button></div>
      {showCreate ? <div className="agent-config-form agent-create-form">
        <label>名称<input value={name} placeholder="例如：研究助手" onChange={(event) => setName(event.target.value)} /></label>
        <label>默认提供商<select value={provider} onChange={(event) => setProvider(event.target.value as typeof provider)}><option value="mock">暂不绑定</option>{modelProviders.filter((item) => item.state === 'connected').map((item) => <option key={item.id} value={`provider:${item.id}`}>{item.displayName}</option>)}</select></label>
        <small className="field-hint">连接由顶部“模型”统一管理。新建后也可以在 Agent 配置中切换提供商和模型。</small>
        <label>交互权限<select value={accessPolicy} onChange={(event) => setAccessPolicy(event.target.value as typeof accessPolicy)}><option value="public">公开</option><option value="private">私有</option></select></label>
        <label>授予角色<select value={role} onChange={(event) => setRole(event.target.value as typeof role)}><option value="commenter">commenter</option><option value="suggester">suggester</option><option value="editor">editor</option></select></label>
        <div className="agent-form-actions"><button className="action-button primary" type="button" onClick={() => void createAgent()}>注册 Agent</button>{createMessage ? <small className="agent-config-message">{createMessage}</small> : null}</div>
      </div> : null}
    </div> : null}
    {agents.map((agent) => <AgentConfigCard key={agent.id} docId={docId} agent={agent} owner={owner} modelProviders={modelProviders} onBindProvider={bindProvider} onUpdated={() => { onUpdated(); void refreshModelProviders(); }} />)}
  </>;
}
