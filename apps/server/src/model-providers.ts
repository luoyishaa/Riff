import { inspectCliProviders, type CliProviderStatus } from './cli-providers.js';

/**
 * The provider catalog is deliberately small. Each entry describes a transport
 * that the server can actually use today; providers that need a different wire
 * protocol should be added with a dedicated adapter instead of pretending to
 * be OpenAI compatible.
 */
export type ModelProviderId = 'codex-cli' | 'claude-code' | 'openrouter' | 'deepseek' | 'openai-api' | 'openai-compatible';
export type ModelProviderKind = 'cli' | 'api-key';
export type ModelProviderState = 'connected' | 'not-connected' | 'unavailable' | 'error';

export interface ProviderModel {
  slug: string;
  displayName: string;
}

export interface ModelProviderCard {
  id: ModelProviderId;
  displayName: string;
  kind: ModelProviderKind;
  description: string;
  state: ModelProviderState;
  detail: string;
  /** Adapter id used by the agent configuration API, when one exists. */
  agentProvider: 'codex' | 'claude' | 'openai-compatible';
  baseUrl?: string;
  defaultModel?: string;
  version?: string;
  models?: ProviderModel[];
}

interface ApiKeyConnection {
  baseUrl: string;
  apiKey: string;
  model: string;
  connectedAt: number;
}

interface ProviderCatalogEntry {
  id: ModelProviderId;
  displayName: string;
  kind: ModelProviderKind;
  description: string;
  agentProvider: ModelProviderCard['agentProvider'];
  defaultBaseUrl?: string;
  defaultModel?: string;
}

const CATALOG: readonly ProviderCatalogEntry[] = [
  {
    id: 'codex-cli',
    displayName: 'Codex CLI',
    kind: 'cli',
    description: '使用本机已安装并登录的 Codex CLI',
    agentProvider: 'codex',
  },
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    kind: 'cli',
    description: '使用本机已安装并登录的 Claude Code',
    agentProvider: 'claude',
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    kind: 'api-key',
    description: '通过统一接口访问多家模型，模型 ID 以 OpenRouter 目录为准',
    agentProvider: 'openai-compatible',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    kind: 'api-key',
    description: '通过 DeepSeek API 调用 DeepSeek 模型',
    agentProvider: 'openai-compatible',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-flash',
  },
  {
    id: 'openai-api',
    displayName: 'OpenAI API',
    kind: 'api-key',
    description: '使用 OpenAI API key 调用 OpenAI 模型',
    agentProvider: 'openai-compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
  },
  {
    id: 'openai-compatible',
    displayName: '自定义兼容接口',
    kind: 'api-key',
    description: '连接任意兼容 OpenAI Chat Completions 的服务',
    agentProvider: 'openai-compatible',
  },
];

function fromCli(id: 'codex-cli' | 'claude-code', status: CliProviderStatus): ModelProviderCard {
  const provider = CATALOG.find((item) => item.id === id);
  if (!provider) throw new Error(`Unknown CLI provider: ${id}`);
  const connected = status.installed && status.auth === 'authenticated';
  const state: ModelProviderState = !status.installed
    ? 'unavailable'
    : connected
      ? 'connected'
      : status.auth === 'not-authenticated'
        ? 'not-connected'
        : 'error';
  return {
    id: provider.id,
    displayName: provider.displayName,
    kind: provider.kind,
    description: provider.description,
    state,
    detail: status.detail,
    agentProvider: provider.agentProvider,
    ...(status.version === undefined ? {} : { version: status.version }),
  };
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
 * or put into agent configs. This mirrors the existing session-only adapter
 * policy while giving the UI one provider directory to work with. A future
 * encrypted credential store can replace this map without changing the API.
 */
export class ModelProviderRegistry {
  private readonly apiKeys = new Map<string, Map<ModelProviderId, ApiKeyConnection>>();
  private readonly inspectCli: () => Promise<CliProviderStatus[]>;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ModelProviderRegistryOptions) {
    this.inspectCli = options.inspectCli ?? (() => inspectCliProviders());
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  catalog(): readonly ProviderCatalogEntry[] { return CATALOG; }

  async list(principalId: string): Promise<ModelProviderCard[]> {
    const cliStatuses = await this.inspectCli();
    const cards: ModelProviderCard[] = [];
    const codex = cliStatuses.find((status) => status.id === 'codex');
    const claude = cliStatuses.find((status) => status.id === 'claude');
    if (codex) cards.push(fromCli('codex-cli', codex));
    if (claude) cards.push(fromCli('claude-code', claude));
    for (const entry of CATALOG.filter((item) => item.kind === 'api-key')) {
      const connection = this.apiKeys.get(principalId)?.get(entry.id);
      cards.push({
        id: entry.id,
        displayName: entry.displayName,
        kind: entry.kind,
        description: entry.description,
        state: connection === undefined ? 'not-connected' : 'connected',
        detail: connection === undefined ? '需要配置 API key' : `已连接 · ${connection.model}`,
        agentProvider: entry.agentProvider,
        ...(entry.defaultModel === undefined ? {} : { defaultModel: entry.defaultModel }),
        ...(connection === undefined ? (entry.defaultBaseUrl === undefined ? {} : { baseUrl: entry.defaultBaseUrl }) : { baseUrl: connection.baseUrl, models: [{ slug: connection.model, displayName: connection.model }] }),
      });
    }
    return cards;
  }

  connectApiKey(principalId: string, providerId: ModelProviderId, input: { apiKey: string; model: string; baseUrl?: string }): ModelProviderCard | undefined {
    const entry = CATALOG.find((item) => item.id === providerId);
    if (!entry || entry.kind !== 'api-key' || !entry.defaultBaseUrl && !input.baseUrl) return undefined;
    const baseUrl = providerId === 'openai-compatible' ? input.baseUrl ?? entry.defaultBaseUrl : entry.defaultBaseUrl;
    if (!baseUrl) return undefined;
    let connections = this.apiKeys.get(principalId);
    if (!connections) {
      connections = new Map();
      this.apiKeys.set(principalId, connections);
    }
    connections.set(providerId, { baseUrl, apiKey: input.apiKey, model: input.model, connectedAt: this.now() });
    return {
      id: entry.id,
      displayName: entry.displayName,
      kind: entry.kind,
      description: entry.description,
      state: 'connected',
      detail: `已连接 · ${input.model}`,
      agentProvider: entry.agentProvider,
      baseUrl,
      ...(entry.defaultModel === undefined ? {} : { defaultModel: entry.defaultModel }),
      models: [{ slug: input.model, displayName: input.model }],
    };
  }

  disconnect(principalId: string, providerId: ModelProviderId): boolean {
    return this.apiKeys.get(principalId)?.delete(providerId) ?? false;
  }

  credentials(principalId: string, providerId: ModelProviderId): { baseUrl: string; apiKey: string; model: string } | undefined {
    const connection = this.apiKeys.get(principalId)?.get(providerId);
    if (!connection) return undefined;
    return { baseUrl: connection.baseUrl, apiKey: connection.apiKey, model: connection.model };
  }

  async models(principalId: string, providerId: ModelProviderId): Promise<ProviderModel[]> {
    const connection = this.apiKeys.get(principalId)?.get(providerId);
    if (connection === undefined) return [];
    try {
      const response = await this.fetchImpl(`${connection.baseUrl.replace(/\/$/u, '')}/models`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${connection.apiKey}` },
      });
      if (response.ok) {
        const body: unknown = await response.json();
        if (typeof body === 'object' && body !== null && 'data' in body && Array.isArray(body.data)) {
          const models = body.data.flatMap((item): ProviderModel[] => {
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
}
