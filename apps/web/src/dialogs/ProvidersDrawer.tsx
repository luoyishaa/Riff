import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ModelProviderDto } from '@collab/protocol';
import { api, describeError } from '../api.js';
import { useToast } from '../hooks/useToast.js';
import { Modal } from '../ui/Modal.js';

const STATE_LABEL: Record<ModelProviderDto['state'], string> = { connected: '已连接', 'not-connected': '未连接', unavailable: '未安装', error: '状态未知' };

/** The account's model connections; agents bind to one of them. */
export function ProvidersDrawer({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }): React.ReactElement {
  const notify = useToast();
  const [providers, setProviders] = useState<ModelProviderDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<{ provider: ModelProviderDto; baseUrl: string; model: string; apiKey: string }>();

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try { setProviders((await api<{ providers: ModelProviderDto[] }>(`/api/model-providers${refresh ? '?refresh=1' : ''}`)).providers); } catch (error) { notify(describeError(error, '无法读取模型提供商。'), 'error'); } finally { setLoading(false); }
  }, [notify]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  const connect = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!form) return;
    try {
      await api(`/api/model-providers/${form.provider.id}/connect`, { body: { apiKey: form.apiKey, model: form.model.trim(), ...(form.provider.baseUrlEditable ? { baseUrl: form.baseUrl.trim() } : {}) } });
      notify(`${form.provider.displayName} 已连接。密钥只保存在当前服务进程，重启后需要重新连接。`, 'success');
      setForm(undefined);
      await load();
      onChanged();
    } catch (error) {
      notify(describeError(error, '连接失败，请检查地址、模型 ID 和 API key。'), 'error');
    }
  };

  const disconnect = async (provider: ModelProviderDto): Promise<void> => {
    try {
      await api(`/api/model-providers/${provider.id}`, { method: 'DELETE' });
      notify(`已断开 ${provider.displayName}，绑定它的 Agent 需要重新连接后才能使用。`, 'success');
      await load();
      onChanged();
    } catch (error) {
      notify(describeError(error, '断开失败。'), 'error');
    }
  };

  const sorted = [...providers].sort((left, right) => Number(right.state === 'connected') - Number(left.state === 'connected'));
  return (
    <Modal open={open} variant="drawer" title="模型提供商" description="本机已登录的 CLI 会被自动检测；API key 只保存在当前服务进程中，不写入数据库。" onClose={onClose}>
      <div className="provider-toolbar"><button type="button" className="button ghost small" onClick={() => void load(true)} disabled={loading}>{loading ? '检测中…' : '重新检测'}</button></div>
      <ul className="provider-list">
        {sorted.map((provider) => (
          <li key={provider.id} className={`provider-card is-${provider.state}`}>
            <div className="provider-card-head">
              <span className="provider-dot" aria-hidden="true" />
              <div className="provider-card-copy">
                <strong>{provider.displayName}</strong>
                <small>{provider.description}</small>
                <small className="muted">{provider.version ?? provider.detail}</small>
              </div>
              <span className={`status-chip is-${provider.state}`}>{STATE_LABEL[provider.state]}</span>
            </div>
            {provider.kind === 'api-key' ? (
              <div className="row-actions">
                {provider.state === 'connected'
                  ? <button type="button" className="button ghost small" onClick={() => void disconnect(provider)}>断开</button>
                  : <button type="button" className="button secondary small" onClick={() => setForm({ provider, baseUrl: provider.baseUrl ?? '', model: provider.defaultModel ?? '', apiKey: '' })}>连接</button>}
              </div>
            ) : provider.state !== 'connected' ? <p className="muted small">在终端里安装并登录 {provider.displayName} 后点“重新检测”。</p> : null}
            {form?.provider.id === provider.id ? (
              <form className="form provider-form" onSubmit={(event) => void connect(event)}>
                <label className="field"><span>接口地址</span><input value={form.baseUrl} readOnly={!provider.baseUrlEditable} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label>
                <label className="field"><span>模型 ID</span><input value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} placeholder={provider.modelPlaceholder ?? '模型 ID'} /></label>
                <label className="field"><span>API key</span><input type="password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} autoComplete="off" /></label>
                <div className="form-actions">
                  <button type="button" className="button ghost small" onClick={() => setForm(undefined)}>取消</button>
                  <button type="submit" className="button primary small" disabled={!form.apiKey || !form.model.trim() || !form.baseUrl.trim()}>连接</button>
                </div>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </Modal>
  );
}
