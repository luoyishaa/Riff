import { z } from 'zod';
import { accessPolicySchema, contextStrategySchema, modelProviderIdSchema, type AccessPolicy, type ContextStrategy, type ModelProviderId } from '@collab/protocol';
import type { AdapterConfig } from '@collab/agent';
import type { AgentStore } from './infra/agent-store.js';

/**
 * How an agent participates in one workspace. The agent's role is not part of
 * it: that is the agent's membership role, the same one the members dialog
 * edits, so there is a single source of truth for what the agent may do.
 */
export interface AgentSettings {
  adapter: AdapterConfig;
  contextStrategy: ContextStrategy;
  accessPolicy: AccessPolicy;
  /** API-key provider binding; the key is read from this account's connection at run time. */
  provider?: { id: ModelProviderId; ownerId: string };
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = { adapter: { type: 'mock' }, contextStrategy: 'window', accessPolicy: 'public' };

const adapterSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mock') }),
  z.object({ type: z.literal('openai-compatible'), baseUrl: z.string().url(), model: z.string().min(1), apiKeyEnv: z.string().min(1).optional() }),
  z.object({
    type: z.literal('cli'),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    timeoutMs: z.number().int().positive().max(300_000).optional(),
    includeSystemInPrompt: z.boolean().optional(),
  }),
]);
// Not strict: rows written by older versions also carry principalId and grantedRole.
const settingsSchema = z.object({
  adapter: adapterSchema,
  contextStrategy: contextStrategySchema,
  accessPolicy: accessPolicySchema.default('public'),
  provider: z.object({ id: modelProviderIdSchema, ownerId: z.string().min(1) }).optional(),
});

function toAdapter(adapter: z.infer<typeof adapterSchema>): AdapterConfig {
  if (adapter.type === 'mock') return { type: 'mock' };
  if (adapter.type === 'openai-compatible') {
    return { type: 'openai-compatible', baseUrl: adapter.baseUrl, model: adapter.model, ...(adapter.apiKeyEnv === undefined ? {} : { apiKeyEnv: adapter.apiKeyEnv }) };
  }
  return {
    type: 'cli',
    command: adapter.command,
    ...(adapter.args === undefined ? {} : { args: adapter.args }),
    ...(adapter.timeoutMs === undefined ? {} : { timeoutMs: adapter.timeoutMs }),
    ...(adapter.includeSystemInPrompt === undefined ? {} : { includeSystemInPrompt: adapter.includeSystemInPrompt }),
  };
}

/** Parse settings from storage, the environment or a request; undefined when invalid. */
export function parseAgentSettings(value: unknown): AgentSettings | undefined {
  const parsed = settingsSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return {
    adapter: toAdapter(parsed.data.adapter),
    contextStrategy: parsed.data.contextStrategy,
    accessPolicy: parsed.data.accessPolicy,
    ...(parsed.data.provider === undefined ? {} : { provider: parsed.data.provider }),
  };
}

/**
 * `COLLAB_AGENT_CONFIG_JSON` is an array of `{ principalId, adapter,
 * contextStrategy, accessPolicy? }`. Invalid entries are skipped so a typo
 * leaves the safe mock default in place instead of stopping the server.
 */
export function parseEnvironmentAgentSettings(raw: string | undefined): Map<string, AgentSettings> {
  const settings = new Map<string, AgentSettings>();
  if (!raw) return settings;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return settings; }
  if (!Array.isArray(value)) return settings;
  for (const item of value) {
    const principalId = typeof item === 'object' && item !== null && 'principalId' in item ? item.principalId : undefined;
    const parsed = parseAgentSettings(item);
    if (typeof principalId === 'string' && parsed) settings.set(principalId, parsed);
  }
  return settings;
}

/** Saved settings win over startup configuration, which wins over the mock default. */
export class AgentSettingsStore {
  constructor(
    private readonly agentStore: AgentStore,
    private readonly environment: ReadonlyMap<string, AgentSettings>,
    private readonly now: () => number,
  ) {}

  get(workspaceId: string | undefined, agentId: string): AgentSettings {
    const saved = workspaceId === undefined
      ? undefined
      : this.agentStore.listSettings(workspaceId).find((row) => row.agentId === agentId)?.value;
    return parseAgentSettings(saved) ?? this.environment.get(agentId) ?? DEFAULT_AGENT_SETTINGS;
  }

  save(workspaceId: string, agentId: string, settings: AgentSettings): void {
    this.agentStore.saveSettings(workspaceId, agentId, settings, this.now());
  }

  reset(workspaceId: string, agentId: string): void {
    this.agentStore.deleteSettings(workspaceId, agentId);
  }
}
