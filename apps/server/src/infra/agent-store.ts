import type { DatabaseSync } from 'node:sqlite';
import { roles, type Role } from '@collab/kernel';
import type { AgentConfig, AgentRun, AgentRunRepository, AgentView, AgentViewRepository } from '@collab/agent';

function isAgentConfig(value: unknown): value is AgentConfig {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.principalId !== 'string' || !roles.includes(item.grantedRole as Role)) return false;
  if (item.contextStrategy !== 'selection' && item.contextStrategy !== 'window' && item.contextStrategy !== 'full') return false;
  if (item.accessPolicy !== undefined && item.accessPolicy !== 'public' && item.accessPolicy !== 'private') return false;
  if (typeof item.adapter !== 'object' || item.adapter === null) return false;
  const adapter = item.adapter as Record<string, unknown>;
  if (adapter.type === 'mock') return true;
  if (adapter.type === 'openai-compatible') {
    return typeof adapter.baseUrl === 'string' && typeof adapter.apiKeyEnv === 'string' && typeof adapter.model === 'string';
  }
  if (adapter.type === 'openai-responses') {
    return typeof adapter.baseUrl === 'string' && typeof adapter.accessTokenEnv === 'string' && typeof adapter.model === 'string'
      && (adapter.profileId === undefined || typeof adapter.profileId === 'string')
      && (adapter.ownerPrincipalId === undefined || typeof adapter.ownerPrincipalId === 'string');
  }
  return adapter.type === 'cli' && typeof adapter.command === 'string'
    && (adapter.args === undefined || Array.isArray(adapter.args))
    && (adapter.timeoutMs === undefined || typeof adapter.timeoutMs === 'number')
    && (adapter.includeSystemInPrompt === undefined || typeof adapter.includeSystemInPrompt === 'boolean');
}

export class AgentStore implements AgentRunRepository, AgentViewRepository {
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      requester_id TEXT NOT NULL,
      strategy TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      input_chars INTEGER NOT NULL,
      output_valid INTEGER NOT NULL,
      retries INTEGER NOT NULL,
      error TEXT,
      suggestion_ids_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_views (
      agent_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      text_snapshot TEXT NOT NULL,
      taken_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, doc_id)
    );
    CREATE TABLE IF NOT EXISTS agent_configs (
      doc_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      config_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (doc_id, agent_id)
    );
    CREATE INDEX IF NOT EXISTS agent_runs_doc_started ON agent_runs(doc_id, started_at);`);
  }

  save(run: AgentRun): void;
  save(view: AgentView): void;
  save(value: AgentRun | AgentView): void {
    if ('threadId' in value) {
      this.db.prepare(`INSERT OR REPLACE INTO agent_runs
        (id, agent_id, doc_id, thread_id, requester_id, strategy, started_at, duration_ms, input_chars, output_valid, retries, error, suggestion_ids_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(value.id, value.agentId, value.docId, value.threadId, value.requesterId, value.strategy, value.startedAt, value.durationMs,
          value.inputChars, value.outputValid ? 1 : 0, value.retries, value.error ?? null, JSON.stringify(value.suggestionIds));
      return;
    }
    this.db.prepare(`INSERT OR REPLACE INTO agent_views(agent_id, doc_id, text_snapshot, taken_at) VALUES (?, ?, ?, ?)`)
      .run(value.agentId, value.docId, value.textSnapshot, value.takenAt);
  }

  get(agentId: string, docId: string): AgentView | undefined {
    const row = this.db.prepare(`SELECT agent_id as agentId, doc_id as docId, text_snapshot as textSnapshot, taken_at as takenAt
      FROM agent_views WHERE agent_id = ? AND doc_id = ?`).get(agentId, docId) as AgentView | undefined;
    return row;
  }

  getConfig(docId: string, agentId: string): AgentConfig | undefined {
    const row = this.db.prepare('SELECT config_json as configJson FROM agent_configs WHERE doc_id = ? AND agent_id = ?')
      .get(docId, agentId) as { configJson?: string } | undefined;
    if (!row?.configJson) return undefined;
    try {
      const value: unknown = JSON.parse(row.configJson);
      return isAgentConfig(value) && value.principalId === agentId ? value : undefined;
    } catch {
      return undefined;
    }
  }

  listConfigs(docId: string): AgentConfig[] {
    const rows = this.db.prepare('SELECT agent_id as agentId, config_json as configJson FROM agent_configs WHERE doc_id = ?')
      .all(docId) as Array<{ agentId: string; configJson: string }>;
    const configs: AgentConfig[] = [];
    for (const row of rows) {
      try {
        const value: unknown = JSON.parse(row.configJson);
        if (isAgentConfig(value) && value.principalId === row.agentId) configs.push(value);
      } catch {
        // A malformed row is ignored; the runtime falls back to its safe default.
      }
    }
    return configs;
  }

  saveConfig(docId: string, config: AgentConfig): void {
    this.db.prepare(`INSERT OR REPLACE INTO agent_configs(doc_id, agent_id, config_json, updated_at)
      VALUES (?, ?, ?, ?)`)
      .run(docId, config.principalId, JSON.stringify(config), Date.now());
  }

  deleteConfig(docId: string, agentId: string): void {
    this.db.prepare('DELETE FROM agent_configs WHERE doc_id = ? AND agent_id = ?').run(docId, agentId);
  }

  listRuns(docId: string): AgentRun[] {
    const rows = this.db.prepare(`SELECT id, agent_id as agentId, doc_id as docId, thread_id as threadId,
      requester_id as requesterId, strategy, started_at as startedAt, duration_ms as durationMs,
      input_chars as inputChars, output_valid as outputValid, retries, error, suggestion_ids_json as suggestionIds
      FROM agent_runs WHERE doc_id = ? ORDER BY started_at`).all(docId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...row,
      outputValid: Boolean(row.outputValid),
      suggestionIds: JSON.parse(String(row.suggestionIds)),
    }) as AgentRun);
  }
}
