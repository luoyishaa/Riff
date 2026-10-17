import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import type { Batch, Message, ReviewRepository, Suggestion, Thread } from '@collab/review';

const { DatabaseSync: DatabaseSyncConstructor } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSync;
};

export type StoredThread = Thread;
export type StoredMessage = Message;
export type StoredSuggestion = Suggestion;

export class ReviewStore implements ReviewRepository {
  readonly db: DatabaseSync;
  constructor(database: DatabaseSync | string) {
    this.db = typeof database === 'string' ? new DatabaseSyncConstructor(database) : database;
    this.db.exec(`CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, scope_json TEXT NOT NULL, kind TEXT NOT NULL, agent_id TEXT, status TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, author_id TEXT NOT NULL, body TEXT NOT NULL, mentions_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS suggestions (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, thread_id TEXT, batch_id TEXT, author_id TEXT NOT NULL, anchor_json TEXT NOT NULL, new_text TEXT NOT NULL, rationale TEXT, status TEXT NOT NULL, decided_by TEXT, decided_at INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS threads_doc_created ON threads(doc_id, created_at);
      CREATE INDEX IF NOT EXISTS messages_thread_created ON messages(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS suggestions_doc_status ON suggestions(doc_id, status);`);
    try { this.db.exec('ALTER TABLE threads ADD COLUMN agent_id TEXT'); } catch { /* Existing databases already have the column. */ }
  }
  listThreads(docId: string): StoredThread[] {
    return (this.db.prepare('SELECT id, doc_id as docId, scope_json as scope, kind, agent_id as agentId, status, created_by as createdBy, created_at as createdAt FROM threads WHERE doc_id = ? ORDER BY created_at').all(docId) as Array<Record<string, unknown>>).map((row) => this.thread(row));
  }
  getThread(id: string): StoredThread | undefined {
    const row = this.db.prepare('SELECT id, doc_id as docId, scope_json as scope, kind, agent_id as agentId, status, created_by as createdBy, created_at as createdAt FROM threads WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.thread(row) : undefined;
  }
  createThread(thread: StoredThread): void {
    this.db.prepare('INSERT INTO threads(id, doc_id, scope_json, kind, agent_id, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(thread.id, thread.docId, JSON.stringify(thread.scope), thread.kind, thread.agentId ?? null, thread.status, thread.createdBy, thread.createdAt);
  }
  saveThread(thread: Thread): void { this.db.prepare('INSERT OR REPLACE INTO threads(id, doc_id, scope_json, kind, agent_id, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(thread.id, thread.docId, JSON.stringify(thread.scope), thread.kind, thread.agentId ?? null, thread.status, thread.createdBy, thread.createdAt); }
  resolveThread(id: string): void { this.db.prepare('UPDATE threads SET status = \'resolved\' WHERE id = ?').run(id); }
  listMessages(threadId: string): StoredMessage[] {
    return (this.db.prepare('SELECT id, thread_id as threadId, author_id as authorId, body, mentions_json as mentions, created_at as createdAt FROM messages WHERE thread_id = ? ORDER BY created_at').all(threadId) as Array<Record<string, unknown>>).map((row) => ({ ...row, mentions: JSON.parse(String(row.mentions)) }) as StoredMessage);
  }
  addMessage(message: StoredMessage): void { this.db.prepare('INSERT INTO messages(id, thread_id, author_id, body, mentions_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(message.id, message.threadId, message.authorId, message.body, JSON.stringify(message.mentions), message.createdAt); }
  getMessage(id: string): Message | undefined {
    const row = this.db.prepare('SELECT id, thread_id as threadId, author_id as authorId, body, mentions_json as mentions, created_at as createdAt FROM messages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? ({ ...row, mentions: JSON.parse(String(row.mentions)) } as Message) : undefined;
  }
  saveMessage(message: Message): void { this.addMessage(message); }
  listSuggestions(docId: string): StoredSuggestion[] {
    const rows = this.db.prepare('SELECT id, doc_id as docId, thread_id as threadId, batch_id as batchId, author_id as authorId, anchor_json as anchor, new_text as newText, rationale, status, decided_by as decidedBy, decided_at as decidedAt, created_at as createdAt FROM suggestions WHERE doc_id = ? ORDER BY created_at').all(docId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ ...row, anchor: JSON.parse(String(row.anchor)) }) as StoredSuggestion);
  }
  getSuggestion(id: string): StoredSuggestion | undefined {
    const row = this.db.prepare('SELECT id, doc_id as docId, thread_id as threadId, batch_id as batchId, author_id as authorId, anchor_json as anchor, new_text as newText, rationale, status, decided_by as decidedBy, decided_at as decidedAt, created_at as createdAt FROM suggestions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? ({ ...row, anchor: JSON.parse(String(row.anchor)) } as StoredSuggestion) : undefined;
  }
  createSuggestion(suggestion: StoredSuggestion): void {
    this.db.prepare('INSERT INTO suggestions(id, doc_id, thread_id, batch_id, author_id, anchor_json, new_text, rationale, status, decided_by, decided_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(suggestion.id, suggestion.docId, suggestion.threadId ?? null, suggestion.batchId ?? null, suggestion.authorId, JSON.stringify(suggestion.anchor), suggestion.newText, suggestion.rationale ?? null, suggestion.status, suggestion.decidedBy ?? null, suggestion.decidedAt ?? null, suggestion.createdAt);
  }
  saveSuggestion(suggestion: Suggestion): void { this.db.prepare('INSERT OR REPLACE INTO suggestions(id, doc_id, thread_id, batch_id, author_id, anchor_json, new_text, rationale, status, decided_by, decided_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(suggestion.id, suggestion.docId, suggestion.threadId ?? null, suggestion.batchId ?? null, suggestion.authorId, JSON.stringify(suggestion.anchor), suggestion.newText, suggestion.rationale ?? null, suggestion.status, suggestion.decidedBy ?? null, suggestion.decidedAt ?? null, suggestion.createdAt); }
  updateSuggestionStatus(id: string, status: Suggestion['status'], decidedBy?: string, decidedAt?: number): void { this.db.prepare('UPDATE suggestions SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(status, decidedBy ?? null, decidedAt ?? null, id); }
  getBatch(id: string): Batch | undefined { return this.db.prepare('SELECT id, thread_id as threadId, created_by as createdBy, created_at as createdAt FROM batches WHERE id = ?').get(id) as Batch | undefined; }
  listBatches(threadId: string): Batch[] { return this.db.prepare('SELECT id, thread_id as threadId, created_by as createdBy, created_at as createdAt FROM batches WHERE thread_id = ? ORDER BY created_at').all(threadId) as unknown as Batch[]; }
  saveBatch(batch: Batch): void { this.db.prepare('INSERT OR REPLACE INTO batches(id, thread_id, created_by, created_at) VALUES (?, ?, ?, ?)').run(batch.id, batch.threadId, batch.createdBy, batch.createdAt); }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN');
    try { const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private thread(row: Record<string, unknown>): StoredThread {
    return {
      id: String(row.id), docId: String(row.docId), scope: JSON.parse(String(row.scope)) as StoredThread['scope'], kind: row.kind as StoredThread['kind'],
      ...(row.agentId === null || row.agentId === undefined ? {} : { agentId: String(row.agentId) }),
      status: row.status as StoredThread['status'], createdBy: String(row.createdBy), createdAt: Number(row.createdAt),
    };
  }
}
