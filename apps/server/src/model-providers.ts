import type { ModelProviderDto, ModelProviderId, ModelProviderState } from '@collab/protocol';
import { inspectCliProviders, type CliProviderStatus } from './cli-providers.js';

/**
 * The provider catalog is deliberately small. Each entry describes a transport
 * the server can actually use today; a provider that needs a different wire
 * protocol gets a dedicated adapter instead of pretending to be OpenAI
 * compatible. The web client renders this catalog and keeps no copy of it.
 */
type CliProviderId = 'codex-cli' | 'claude-code';
type ApiProviderId = Exclude<ModelProviderId, CliProviderId>;

interface CatalogEntry {
  id: ModelProviderId;
  displayName: string;
  kind: 'cli' | 'api-key';
  description: string;
  defaultBaseUrl?: string;
  defaultModel?: string;
  modelPlaceholder?: string;
}

const CATALOG: readonly CatalogEntry[] = [
  { id: 'codex-cli', displayName: 'Codex CLI', kind: 'cli', description: '使用本机已安装并登录的 Codex CLI' },
  { id: 'claude-code', displayName: 'Claude Code', kind: 'cli', description: '使用本机已安装并登录的 Claude Code' },
  { id: 'openrouter', displayName: 'OpenRouter', kind: 'api-key', description: '通过统一接口访问多家模型，模型 ID 以 OpenRouter 目录为准', defaultBaseUrl: 'https://openrouter.ai/api/v1', modelPlaceholder: '例如 provider/model-name' },
  { id: 'deepseek', displayName: 'DeepSeek', kind: 'api-key', description: '通过 DeepSeek API 调用 DeepSeek 模型', defaultBaseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-flash', modelPlaceholder: 'deepseek-flash' },
  { id: 'openai-api', displayName: 'OpenAI API', kind: 'api-key', description: '使用 OpenAI API key 调用 OpenAI 模型', defaultBaseUrl: 'https://api.openai.com/v1', modelPlaceholder: '填写账号可用的模型 ID' },
  { id: 'openai-compatible', displayName: '自定义兼容接口', kind: 'api-key', description: '连接任意兼容 OpenAI Chat Completions 的服务', modelPlaceholder: '填写服务商提供的模型 ID' },
];

/**
 * Fixed command lines for the local CLIs (decision 2026-10-16). The prompt is
 * written to stdin: on Windows the `.cmd` shims run through cmd.exe, which
 * truncates arguments at the first newline and limits their length.
 */
export const CLI_PRESETS: Record<CliProviderId, { command: string; args: string[] }> = {
  'codex-cli': { command: 'codex', args: ['exec', '--skip-git-repo-check', '-c', 'model_reasoning_effort=medium', '-'] },
  'claude-code': { command: 'claude', args: ['-p', '--output-format', 'text'] },
};

export function isCliProvider(id: ModelProviderId): id is CliProviderId {
  return id === 'codex-cli' || id === 'claude-code';
}

/** The CLI preset whose command a stored configuration runs, if any. */
export function cliProviderForCommand(command: string): CliProviderId | undefined {
  return (Object.keys(CLI_PRESETS) as CliProviderId[]).find((id) => CLI_PRESETS[id].command === command);
}

const CLI_STATUS_ID: Record<CliProviderId, CliProviderStatus['id']> = { 'codex-cli': 'codex', 'claude-code': 'claude' };
/** CLI probes spawn processes; their result is reused briefly so panels open instantly. */
const CLI_STATUS_TTL_MS = 30_000;

interface ApiKeyConnection { baseUrl: string; apiKey: string; model: string; connectedAt: number }

function card(entry: CatalogEntry, state: ModelProviderState, detail: string, extra: Partial<ModelProviderDto> = {}): ModelProviderDto {
  return {
    id: entry.id,
    displayName: entry.displayName,
    kind: entry.kind,
    description: entry.description,
    state,
    detail,
    baseUrlEditable: entry.kind === 'api-key' && entry.defaultBaseUrl === undefined,
    ...(entry.defaultBaseUrl === undefined ? {} : { baseUrl: entry.defaultBaseUrl }),
    ...(entry.defaultModel === undefined ? {} : { defaultModel: entry.defaultModel }),
    ...(entry.modelPlaceholder === undefined ? {} : { modelPlaceholder: entry.modelPlaceholder }),
    ...extra,
  };
}

function cliCard(entry: CatalogEntry, status: CliProviderStatus | undefined): ModelProviderDto {
  if (!status) return card(entry, 'unavailable', '未检测到可执行文件');
  const state: ModelProviderState = !status.installed
    ? 'unavailable'
    : status.auth === 'authenticated' ? 'connected' : status.auth === 'not-authenticated' ? 'not-connected' : 'error';
  return card(entry, state, status.detail, status.version === undefined ? {} : { version: status.version });
}

export interface ModelProviderRegistryOptions {
  inspectCli?: () => Promise<CliProviderStatus[]>;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

/**
 * Account-scoped provider connections kept in the running server process.
 *
 * API keys are intentionally not written to SQLite, returned by an endpoint,
 * or put into agent configs; an agent bound to a provider looks its key up
 * here at run time, so disconnecting a provider disconnects its agents too.
 */
export class ModelProviderRegistry {
  private readonly apiKeys = new Map<string, Map<ApiProviderId, ApiKeyConnection>>();
  private readonly inspectCli: () => Promise<CliProviderStatus[]>;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private cliStatus: { at: number; value: Promise<CliProviderStatus[]> } | undefined;

  constructor(options: ModelProviderRegistryOptions = {}) {
    this.inspectCli = options.inspectCli ?? (() => inspectCliProviders());
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async list(principalId: string, options: { refresh?: boolean } = {}): Promise<ModelProviderDto[]> {
    const cliStatuses = await this.cliStatuses(options.refresh === true);
    return CATALOG.map((entry) => {
      if (isCliProvider(entry.id)) return cliCard(entry, cliStatuses.find((status) => status.id === CLI_STATUS_ID[entry.id as CliProviderId]));
      const connection = this.apiKeys.get(principalId)?.get(entry.id as ApiProviderId);
      if (!connection) return card(entry, 'not-connected', '需要配置 API key');
      return card(entry, 'connected', `已连接 · ${connection.model}`, { baseUrl: connection.baseUrl, models: [{ slug: connection.model, displayName: connection.model }] });
    });
  }

  async isConnected(principalId: string, providerId: ModelProviderId): Promise<boolean> {
    if (!isCliProvider(providerId)) return this.credentials(principalId, providerId) !== undefined;
    const providers = await this.list(principalId);
    return providers.some((provider) => provider.id === providerId && provider.state === 'connected');
  }

  connectApiKey(principalId: string, providerId: ModelProviderId, input: { apiKey: string; model: string; baseUrl?: string }): ModelProviderDto | undefined {
    const entry = CATALOG.find((item) => item.id === providerId);
    if (!entry || isCliProvider(entry.id)) return undefined;
    // Known providers use their official endpoint; only the custom entry takes a URL.
    const baseUrl = entry.defaultBaseUrl ?? input.baseUrl;
    if (!baseUrl) return undefined;
    const connections = this.apiKeys.get(principalId) ?? new Map<ApiProviderId, ApiKeyConnection>();
    connections.set(entry.id as ApiProviderId, { baseUrl, apiKey: input.apiKey, model: input.model, connectedAt: this.now() });
    this.apiKeys.set(principalId, connections);
    return card(entry, 'connected', `已连接 · ${input.model}`, { baseUrl, models: [{ slug: input.model, displayName: input.model }] });
  }

  disconnect(principalId: string, providerId: ModelProviderId): boolean {
    return !isCliProvider(providerId) && (this.apiKeys.get(principalId)?.delete(providerId) ?? false);
  }

  credentials(principalId: string, providerId: ModelProviderId): { baseUrl: string; apiKey: string; model: string } | undefined {
    if (isCliProvider(providerId)) return undefined;
    const connection = this.apiKeys.get(principalId)?.get(providerId);
    return connection === undefined ? undefined : { baseUrl: connection.baseUrl, apiKey: connection.apiKey, model: connection.model };
  }

  async models(principalId: string, providerId: ModelProviderId): Promise<Array<{ slug: string; displayName: string }>> {
    const connection = this.credentials(principalId, providerId);
    if (connection === undefined) return [];
    try {
      const response = await this.fetchImpl(`${connection.baseUrl.replace(/\/$/u, '')}/models`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${connection.apiKey}` },
      });
      if (response.ok) {
        const body: unknown = await response.json();
        if (typeof body === 'object' && body !== null && 'data' in body && Array.isArray(body.data)) {
          const models = body.data.flatMap((item): Array<{ slug: string; displayName: string }> => {
            if (typeof item !== 'object' || item === null || !('id' in item) || typeof item.id !== 'string' || item.id.length === 0) return [];
            const displayName = 'name' in item && typeof item.name === 'string' && item.name.length > 0 ? item.name : item.id;
            return [{ slug: item.id, displayName }];
          });
          if (models.length > 0) return models;
        }
      }
    } catch {
      // Keep the saved default model available when a provider catalog is down.
    }
    return [{ slug: connection.model, displayName: connection.model }];
  }

  private cliStatuses(refresh: boolean): Promise<CliProviderStatus[]> {
    const cached = this.cliStatus;
    if (!refresh && cached !== undefined && this.now() - cached.at < CLI_STATUS_TTL_MS) return cached.value;
    const value = this.inspectCli().catch(() => []);
    this.cliStatus = { at: this.now(), value };
    return value;
  }
}
