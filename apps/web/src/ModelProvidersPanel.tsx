import { useCallback, useEffect, useMemo, useState } from 'react';

type ProviderKind = 'cli' | 'api-key';
type ProviderStatus = 'connected' | 'not-connected' | 'unavailable' | 'error';

export type ModelProvider = {
  id: string;
  displayName: string;
  kind: ProviderKind;
  description: string;
  state: ProviderStatus;
  detail: string;
  baseUrl?: string;
  defaultModel?: string;
  models?: Array<{ slug: string; displayName: string }>;
};

type Props = {
  onChanged?: () => void;
};

async function readJson<T>(url: string, options: RequestInit = {}): Promise<{ ok: boolean; value: T | null }> {
  const response = await fetch(url, { credentials: 'include', ...options });
  const value = (await response.json()) as T | { error?: { message?: string } };
  return { ok: response.ok, value: response.ok ? value as T : null };
}

const fallbackProviders: ModelProvider[] = [
  { id: 'codex-cli', displayName: 'Codex CLI', kind: 'cli', description: '使用本机已经登录的 Codex CLI。', state: 'unavailable', detail: '检测中' },
  { id: 'claude-code', displayName: 'Claude Code', kind: 'cli', description: '使用本机已经登录的 Claude Code。', state: 'unavailable', detail: '检测中' },
  { id: 'openrouter', displayName: 'OpenRouter', kind: 'api-key', description: '通过统一接口访问多家模型，模型 ID 以 OpenRouter 目录为准。', state: 'not-connected', detail: '需要配置 API key', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'deepseek', displayName: 'DeepSeek', kind: 'api-key', description: '通过 DeepSeek API 调用 DeepSeek 模型。', state: 'not-connected', detail: '需要配置 API key', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-flash' },
  { id: 'openai-api', displayName: 'OpenAI API', kind: 'api-key', description: '使用 OpenAI API key 调用 OpenAI 模型。', state: 'not-connected', detail: '需要配置 API key', baseUrl: 'https://api.openai.com/v1' },
  { id: 'openai-compatible', displayName: '自定义兼容接口', kind: 'api-key', description: '连接任意兼容 OpenAI Chat Completions 的服务。', state: 'not-connected', detail: '需要配置 API key' },
];

const customApiProviderDefaults = { baseUrl: '', model: '', modelPlaceholder: '填写服务商提供的模型 ID' };
const apiProviderDefaults: Record<string, { baseUrl: string; model: string; modelPlaceholder: string }> = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: '', modelPlaceholder: '例如 provider/model-name' },
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', modelPlaceholder: 'deepseek-flash' },
  'openai-api': { baseUrl: 'https://api.openai.com/v1', model: '', modelPlaceholder: '例如 gpt-4.1-mini' },
  'openai-compatible': customApiProviderDefaults,
};

function statusClass(status: ProviderStatus): string {
  if (status === 'connected') return 'good';
  if (status === 'error') return 'warn';
  return 'muted';
}

function statusText(provider: ModelProvider): string {
  if (provider.state === 'connected') return '已连接';
  if (provider.state === 'unavailable') return '不可用';
  if (provider.state === 'error') return '需要重新授权';
  return '未连接';
}

export function ModelProvidersPanel({ onChanged }: Props): React.ReactElement {
  const [providers, setProviders] = useState<ModelProvider[]>(fallbackProviders);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [showApiForm, setShowApiForm] = useState(false);
  const [apiProviderId, setApiProviderId] = useState('openai-compatible');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [apiModel, setApiModel] = useState('');
  const [apiModelPlaceholder, setApiModelPlaceholder] = useState(customApiProviderDefaults.modelPlaceholder);
  const [apiKey, setApiKey] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await readJson<{ providers: ModelProvider[] }>('/api/model-providers');
    if (result.ok && result.value?.providers) {
      setProviders(result.value.providers);
      setLoading(false);
      return;
    }

    const next = fallbackProviders.map((provider) => ({ ...provider }));
    const cliResult = await readJson<Array<{ id: string; installed: boolean; auth: string; version?: string; detail: string }>>('/api/agent-providers');
    if (cliResult.ok && cliResult.value) {
      for (const cli of cliResult.value) {
        const target = next.find((provider) => (cli.id === 'codex' && provider.id === 'codex-cli') || (cli.id === 'claude' && provider.id === 'claude-code'));
        if (!target) continue;
        target.state = cli.installed && cli.auth === 'authenticated' ? 'connected' : cli.installed ? 'not-connected' : 'unavailable';
        target.detail = cli.version ?? cli.detail;
      }
    }
    setProviders(next);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveApiProvider = async () => {
    if (!apiBaseUrl.trim() || !apiModel.trim() || !apiKey.trim()) {
      setMessage('请填写 Base URL、模型和 API key。');
      return;
    }
    setBusyId(apiProviderId);
    const result = await readJson<{ provider: ModelProvider }>('/api/model-providers/' + encodeURIComponent(apiProviderId) + '/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: apiBaseUrl.trim(), model: apiModel.trim(), apiKey }),
    });
    setBusyId(null);
    if (!result.ok || !result.value?.provider) {
      setMessage('提供商连接失败，请检查地址、模型 ID 和 API key。');
      return;
    }
    setApiKey('');
    setShowApiForm(false);
    setMessage('已连接；API key 只保存在当前 server 进程。');
    await refresh();
    onChanged?.();
  };

  const disconnectApiProvider = async (providerId: string) => {
    setBusyId(providerId);
    const result = await readJson<{ ok: boolean }>(`/api/model-providers/${encodeURIComponent(providerId)}`, { method: 'DELETE' });
    setBusyId(null);
    setMessage(result.ok ? '已断开提供商连接。' : '断开连接失败，请稍后重试。');
    if (result.ok) { await refresh(); onChanged?.(); }
  };

  const openApiForm = (provider: ModelProvider) => {
    setApiProviderId(provider.id);
    const defaults = apiProviderDefaults[provider.id] ?? customApiProviderDefaults;
    setApiBaseUrl(provider.baseUrl ?? defaults.baseUrl);
    setApiModel(provider.models?.[0]?.slug ?? provider.defaultModel ?? defaults.model);
    setApiModelPlaceholder(defaults.modelPlaceholder);
    setShowApiForm(true);
  };

  const sortedProviders = useMemo(() => [...providers].sort((a, b) => Number(b.state === 'connected') - Number(a.state === 'connected')), [providers]);

  return <div className="provider-settings-panel">
    <div className="provider-settings-intro">
      <div><strong>模型提供商</strong><p>连接一次，之后在每个 Agent 的配置里选择提供商和模型。</p></div>
      <button className="subtle-button" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? '检测中…' : '重新检测'}</button>
    </div>
    {message ? <p className="provider-settings-message" role="status">{message}</p> : null}
    <section className="provider-group" aria-labelledby="connected-provider-heading">
      <h3 id="connected-provider-heading">已连接</h3>
      {sortedProviders.filter((provider) => provider.state === 'connected').length ? sortedProviders.filter((provider) => provider.state === 'connected').map((provider) => (
        <ProviderRow key={provider.id} provider={provider} busy={busyId === provider.id} onAction={provider.kind === 'api-key' ? () => void disconnectApiProvider(provider.id) : undefined} />
      )) : <p className="provider-empty">还没有可用的模型连接。</p>}
    </section>
    <section className="provider-group" aria-labelledby="available-provider-heading">
      <h3 id="available-provider-heading">提供商</h3>
      {sortedProviders.filter((provider) => provider.state !== 'connected').map((provider) => (
        <ProviderRow key={provider.id} provider={provider} busy={busyId === provider.id} onAction={provider.kind === 'api-key' ? () => openApiForm(provider) : undefined} />
      ))}
      {showApiForm ? <div className="provider-api-form">
        <label>Base URL<input value={apiBaseUrl} readOnly={apiProviderId !== 'openai-compatible'} aria-readonly={apiProviderId !== 'openai-compatible'} placeholder="https://api.example.com/v1" onChange={(event) => setApiBaseUrl(event.target.value)} /><small className="field-hint">{apiProviderId === 'openai-compatible' ? '填写服务商的 chat/completions 根地址。' : '这是该提供商的官方接口地址。'}</small></label>
        <label>模型<input value={apiModel} placeholder={apiModelPlaceholder} onChange={(event) => setApiModel(event.target.value)} /></label>
        <label>API key <span>只在本机进程使用</span><input type="password" value={apiKey} autoComplete="off" placeholder="sk-…" onChange={(event) => setApiKey(event.target.value)} /></label>
        <div className="provider-api-actions"><button className="subtle-button" type="button" onClick={() => setShowApiForm(false)}>取消</button><button className="action-button primary" type="button" onClick={() => void saveApiProvider()} disabled={busyId === apiProviderId}>{busyId === apiProviderId ? '连接中…' : '连接提供商'}</button></div>
      </div> : null}
    </section>
    <p className="provider-settings-footnote">Agent 只会使用已连接的提供商。CLI 的密钥由本机 CLI 管理；API key 不会返回到浏览器之外的页面。</p>
  </div>;
}

function ProviderRow({ provider, busy, onAction }: { provider: ModelProvider; busy: boolean; onAction: (() => void) | undefined }): React.ReactElement {
  const actionLabel = provider.state === 'connected' ? '断开' : provider.kind === 'cli' ? '重新检测' : '连接';
  return <article className="provider-row">
    <span className={`provider-row-mark ${statusClass(provider.state)}`} aria-hidden="true" />
    <div className="provider-row-copy"><strong>{provider.displayName}</strong><p>{provider.description}</p>{provider.detail ? <small>{provider.detail}</small> : null}{provider.models?.length ? <small>{provider.models.length} 个可用模型</small> : null}</div>
    <span className={`provider-row-state ${statusClass(provider.state)}`}>{statusText(provider)}</span>
    {onAction ? <button className="subtle-button" type="button" onClick={onAction} disabled={busy}>{busy ? '处理中…' : actionLabel}</button> : <span className="provider-row-static">{provider.state === 'not-connected' ? '请先在本机登录' : provider.state === 'unavailable' ? '不可用' : ''}</span>}
  </article>;
}
