import type { DatabaseSync } from 'node:sqlite';
import type { AgentRun, AgentRunRepository, AgentView, AgentViewRepository } from '@collab/agent';

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/**
 * Agent runs, views and per-workspace agent settings. Settings are stored as
 * JSON and validated by the caller, so this class never decides what a valid
 * configuration is.
 */
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
    CREATE TABLE IF NOT EXISTS agent_settings (
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, agent_id)
    );
    CREATE INDEX IF NOT EXISTS agent_runs_doc_started ON agent_runs(doc_id, started_at);`);
    this.migrateDocumentConfigs();
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
    this.db.prepare('INSERT OR REPLACE INTO agent_views(agent_id, doc_id, text_snapshot, taken_at) VALUES (?, ?, ?, ?)')
      .run(value.agentId, value.docId, value.textSnapshot, value.takenAt);
  }

  get(agentId: string, docId: string): AgentView | undefined {
    return this.db.prepare(`SELECT agent_id as agentId, doc_id as docId, text_snapshot as textSnapshot, taken_at as takenAt
      FROM agent_views WHERE agent_id = ? AND doc_id = ?`).get(agentId, docId) as AgentView | undefined;
  }

  /** Raw settings JSON per agent of a workspace; unparsable rows are the caller's to ignore. */
  listSettings(workspaceId: string): Array<{ agentId: string; value: unknown }> {
    const rows = this.db.prepare('SELECT agent_id as agentId, settings_json as json FROM agent_settings WHERE workspace_id = ?').all(workspaceId) as Array<{ agentId: string; json: string }>;
    return rows.flatMap((row) => {
      try { return [{ agentId: row.agentId, value: JSON.parse(row.json) as unknown }]; } catch { return []; }
    });
  }

  saveSettings(workspaceId: string, agentId: string, settings: unknown, updatedAt: number): void {
    this.db.prepare('INSERT OR REPLACE INTO agent_settings(workspace_id, agent_id, settings_json, updated_at) VALUES (?, ?, ?, ?)')
      .run(workspaceId, agentId, JSON.stringify(settings), updatedAt);
  }

  deleteSettings(workspaceId: string, agentId: string): void {
    this.db.prepare('DELETE FROM agent_settings WHERE workspace_id = ? AND agent_id = ?').run(workspaceId, agentId);
  }

  listRuns(docId: string): AgentRun[] {
    const rows = this.db.prepare(`SELECT id, agent_id as agentId, doc_id as docId, thread_id as threadId,
      requester_id as requesterId, strategy, started_at as startedAt, duration_ms as durationMs,
      input_chars as inputChars, output_valid as outputValid, retries, error, suggestion_ids_json as suggestionIds
      FROM agent_runs WHERE doc_id = ? ORDER BY started_at`).all(docId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      agentId: String(row.agentId),
      docId: String(row.docId),
      threadId: String(row.threadId),
      requesterId: String(row.requesterId),
      strategy: row.strategy as AgentRun['strategy'],
      startedAt: Number(row.startedAt),
      durationMs: Number(row.durationMs),
      inputChars: Number(row.inputChars),
      outputValid: Boolean(row.outputValid),
      retries: Number(row.retries),
      ...(row.error === null || row.error === undefined ? {} : { error: String(row.error) }),
      suggestionIds: JSON.parse(String(row.suggestionIds)) as string[],
    }));
  }

  /**
   * Before settings became workspace-wide they were stored per document. Copy
   * the newest per-document row of each agent into its workspace once.
   */
  private migrateDocumentConfigs(): void {
    if (!tableExists(this.db, 'agent_configs') || !tableExists(this.db, 'documents')) return;
    this.db.exec(`INSERT OR IGNORE INTO agent_settings(workspace_id, agent_id, settings_json, updated_at)
      SELECT d.workspace_id, c.agent_id, c.config_json, c.updated_at
      FROM agent_configs c JOIN documents d ON d.id = c.doc_id
      WHERE d.workspace_id IS NOT NULL
      ORDER BY c.updated_at DESC`);
    // Kept under another name so the copy is not repeated and nothing is lost.
    this.db.exec('ALTER TABLE agent_configs RENAME TO agent_configs_before_workspace_settings');
  }
}
