import { useEffect, useState } from 'react';

export type AgentSummary = {
  id: string;
  displayName: string;
  adapter: string;
  contextStrategy: 'selection' | 'window' | 'full';
  grantedRole: string;
  status: 'working' | 'idle' | 'failed';
};

type AdapterConfig =
  | { type: 'mock' }
  | { type: 'openai-compatible'; baseUrl: string; apiKeyEnv: string; model: string }
  | { type: 'cli'; command: string; args?: string[]; timeoutMs?: number };

type AgentConfig = {
  principalId: string;
  adapter: AdapterConfig;
  grantedRole: 'viewer' | 'commenter' | 'suggester' | 'editor' | 'owner';
  contextStrategy: 'selection' | 'window' | 'full';
};

type Props = {
  docId: string;
  principalId: string;
  agents: AgentSummary[];
  owner: boolean;
  onUpdated: () => void;
};

async function readJson<T>(
  url: string,
  options: RequestInit,
): Promise<{ ok: boolean; value: T | null }> {
  const response = await fetch(url, options);
  const value = (await response.json()) as T | { error?: { message?: string } };
  return { ok: response.ok, value: response.ok ? (value as T) : null };
}

function defaultConfig(agent: AgentSummary): AgentConfig {
  return {
    principalId: agent.id,
    adapter: {
      type:
        agent.adapter === 'openai-compatible'
          ? 'openai-compatible'
          : agent.adapter === 'cli'
            ? 'cli'
            : 'mock',
      ...(agent.adapter === 'openai-compatible'
        ? { baseUrl: '', apiKeyEnv: '', model: '' }
        : agent.adapter === 'cli'
          ? { command: '', args: [], timeoutMs: 30000 }
          : {}),
    } as AdapterConfig,
    grantedRole: (['viewer', 'commenter', 'suggester', 'editor', 'owner'].includes(
      agent.grantedRole,
    )
      ? agent.grantedRole
      : 'suggester') as AgentConfig['grantedRole'],
    contextStrategy: agent.contextStrategy,
  };
}

function AgentConfigCard({
  docId,
  principalId,
  agent,
  owner,
  onUpdated,
}: {
  docId: string;
  principalId: string;
  agent: AgentSummary;
  owner: boolean;
  onUpdated: () => void;
}): React.ReactElement {
  const [config, setConfig] = useState<AgentConfig>(() => defaultConfig(agent));
  const [message, setMessage] = useState('');
  const headers = { 'x-principal-id': principalId, 'Content-Type': 'application/json' };

  useEffect(() => {
    let active = true;
    void readJson<AgentConfig>(`/api/docs/${docId}/agents/${agent.id}`, { headers }).then(
      (result) => {
        if (active && result.ok && result.value) setConfig(result.value);
      },
    );
    return () => {
      active = false;
    };
  }, [docId, agent.id, principalId]);

  const updateAdapter = (type: AdapterConfig['type']) => {
    if (type === 'mock') setConfig((current) => ({ ...current, adapter: { type } }));
    else if (type === 'openai-compatible')
      setConfig((current) => ({
        ...current,
        adapter: { type, baseUrl: '', apiKeyEnv: '', model: '' },
      }));
    else
      setConfig((current) => ({
        ...current,
        adapter: { type, command: '', args: [], timeoutMs: 30000 },
      }));
  };
  const save = async () => {
    const result = await readJson<AgentConfig>(`/api/docs/${docId}/agents/${agent.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(config),
    });
    setMessage(result.ok ? '已保存' : '保存失败');
    if (result.ok) {
      if (result.value) setConfig(result.value);
      onUpdated();
    }
  };
  const reset = async () => {
    const result = await readJson<{ ok: boolean }>(`/api/docs/${docId}/agents/${agent.id}`, {
      method: 'DELETE',
      headers,
      body: '{}',
    });
    setMessage(result.ok ? '已恢复默认配置' : '恢复失败');
    if (result.ok) {
      setConfig(defaultConfig({ ...agent, adapter: 'mock', contextStrategy: 'window' }));
      onUpdated();
    }
  };

  return (
    <div className="agent-card agent-config-card">
      <div className="agent-card-heading">
        <span className="avatar agent">AI</span>
        <div>
          <strong>{agent.displayName}</strong>
          <p>
            {agent.adapter} · {agent.contextStrategy}
          </p>
        </div>
        <span className={`agent-status ${agent.status}`}>
          {agent.status === 'working' ? '处理中' : agent.status === 'failed' ? '失败' : '空闲'}
        </span>
      </div>
      {owner ? (
        <div className="agent-config-form">
          <label>
            适配器
            <select
              value={config.adapter.type}
              onChange={(event) => updateAdapter(event.target.value as AdapterConfig['type'])}
            >
              <option value="mock">Mock</option>
              <option value="openai-compatible">OpenAI Compatible</option>
              <option value="cli">CLI</option>
            </select>
          </label>
          <label>
            授予角色
            <select
              value={config.grantedRole}
              onChange={(event) =>
                setConfig((current) => ({
                  ...current,
                  grantedRole: event.target.value as AgentConfig['grantedRole'],
                }))
              }
            >
              <option value="viewer">viewer</option>
              <option value="commenter">commenter</option>
              <option value="suggester">suggester</option>
              <option value="editor">editor</option>
              <option value="owner">owner</option>
            </select>
          </label>
          <label>
            上下文
            <select
              value={config.contextStrategy}
              onChange={(event) =>
                setConfig((current) => ({
                  ...current,
                  contextStrategy: event.target.value as AgentConfig['contextStrategy'],
                }))
              }
            >
              <option value="selection">selection</option>
              <option value="window">window</option>
              <option value="full">full</option>
            </select>
          </label>
          {config.adapter.type === 'openai-compatible' ? (
            <>
              <label>
                Base URL
                <input
                  value={config.adapter.baseUrl}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      adapter: { ...current.adapter, baseUrl: event.target.value },
                    }))
                  }
                />
              </label>
              <label>
                API Key 环境变量
                <input
                  value={config.adapter.apiKeyEnv}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      adapter: { ...current.adapter, apiKeyEnv: event.target.value },
                    }))
                  }
                />
              </label>
              <label>
                模型
                <input
                  value={config.adapter.model}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      adapter: { ...current.adapter, model: event.target.value },
                    }))
                  }
                />
              </label>
            </>
          ) : null}
          {config.adapter.type === 'cli' ? (
            <>
              <label>
                命令
                <input
                  value={config.adapter.command}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      adapter: { ...current.adapter, command: event.target.value },
                    }))
                  }
                />
              </label>
              <label>
                参数（每行一个）
                <textarea
                  value={config.adapter.args?.join('\n') ?? ''}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      adapter: {
                        ...current.adapter,
                        args: event.target.value.split('\n').filter(Boolean),
                      },
                    }))
                  }
                />
              </label>
              <label>
                超时（毫秒）
                <input
                  type="number"
                  min="1"
                  max="300000"
                  value={config.adapter.timeoutMs ?? 30000}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      adapter: { ...current.adapter, timeoutMs: Number(event.target.value) },
                    }))
                  }
                />
              </label>
            </>
          ) : null}
          <div>
            <button onClick={() => void save()}>保存配置</button>
            <button onClick={() => void reset()}>恢复默认</button>
            {message ? <small className="agent-config-message">{message}</small> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function AgentConfigPanel({
  docId,
  principalId,
  agents,
  owner,
  onUpdated,
}: Props): React.ReactElement {
  return (
    <>
      {agents.map((agent) => (
        <AgentConfigCard
          key={agent.id}
          docId={docId}
          principalId={principalId}
          agent={agent}
          owner={owner}
          onUpdated={onUpdated}
        />
      ))}
    </>
  );
}
