import type { DatabaseSync } from 'node:sqlite';
import type { AgentRun, AgentRunRepository, AgentView, AgentViewRepository } from '@collab/agent';

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
