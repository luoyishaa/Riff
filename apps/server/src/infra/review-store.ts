import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import type { Batch, DocumentVersion, Message, ReviewRepository, Suggestion, Thread } from '@collab/review';

const { DatabaseSync: DatabaseSyncConstructor } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSync;
};

export type StoredThread = Thread;
export type StoredMessage = Message;
export type StoredSuggestion = Suggestion;
export type StoredDocumentVersion = DocumentVersion;

export class ReviewStore implements ReviewRepository {
  readonly db: DatabaseSync;
  constructor(database: DatabaseSync | string) {
    this.db = typeof database === 'string' ? new DatabaseSyncConstructor(database) : database;
    this.db.exec(`CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, scope_json TEXT NOT NULL, kind TEXT NOT NULL, agent_id TEXT, status TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, author_id TEXT NOT NULL, body TEXT NOT NULL, mentions_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'visible', withdrawn_at INTEGER, withdrawn_by TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS suggestions (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, thread_id TEXT, batch_id TEXT, author_id TEXT NOT NULL, author_kind TEXT, anchor_json TEXT NOT NULL, new_text TEXT NOT NULL, rationale TEXT, status TEXT NOT NULL, decided_by TEXT, decided_at INTEGER, withdrawn_at INTEGER, withdrawn_by TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS document_versions (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, suggestion_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'suggestion', phase TEXT, source_version_id TEXT, thread_id TEXT, text TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_reads (thread_id TEXT NOT NULL, principal_id TEXT NOT NULL, read_at INTEGER NOT NULL, PRIMARY KEY (thread_id, principal_id));
      CREATE INDEX IF NOT EXISTS threads_doc_created ON threads(doc_id, created_at);
      CREATE INDEX IF NOT EXISTS messages_thread_created ON messages(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS suggestions_doc_status ON suggestions(doc_id, status);
      CREATE INDEX IF NOT EXISTS document_versions_doc_created ON document_versions(doc_id, created_at);`);
    try { this.db.exec('ALTER TABLE threads ADD COLUMN agent_id TEXT'); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec("ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'visible'"); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec('ALTER TABLE messages ADD COLUMN withdrawn_at INTEGER'); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec('ALTER TABLE messages ADD COLUMN withdrawn_by TEXT'); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec('ALTER TABLE suggestions ADD COLUMN withdrawn_at INTEGER'); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec('ALTER TABLE suggestions ADD COLUMN withdrawn_by TEXT'); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec("ALTER TABLE document_versions ADD COLUMN kind TEXT NOT NULL DEFAULT 'suggestion'"); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec('ALTER TABLE document_versions ADD COLUMN phase TEXT'); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec('ALTER TABLE document_versions ADD COLUMN source_version_id TEXT'); } catch { /* Existing databases already have the column. */ }
    try {
      this.db.exec('ALTER TABLE suggestions ADD COLUMN author_kind TEXT');
      // Rows written before the column existed take the kind of their author.
      if (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'principals'").get() !== undefined) {
        this.db.exec('UPDATE suggestions SET author_kind = (SELECT kind FROM principals WHERE principals.id = suggestions.author_id) WHERE author_kind IS NULL');
      }
    } catch { /* Existing databases already have the column. */ }
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
  getThreadReadAt(threadId: string, principalId: string): number | undefined {
    const row = this.db.prepare('SELECT read_at as readAt FROM thread_reads WHERE thread_id = ? AND principal_id = ?').get(threadId, principalId) as { readAt?: unknown } | undefined;
    return row?.readAt === undefined ? undefined : Number(row.readAt);
  }
  saveThreadReadAt(threadId: string, principalId: string, readAt: number): void {
    this.db.prepare('INSERT OR REPLACE INTO thread_reads(thread_id, principal_id, read_at) VALUES (?, ?, ?)').run(threadId, principalId, readAt);
  }
  resolveThread(id: string): void { this.db.prepare('UPDATE threads SET status = \'resolved\' WHERE id = ?').run(id); }
  listMessages(threadId: string): StoredMessage[] {
    return (this.db.prepare('SELECT id, thread_id as threadId, author_id as authorId, body, mentions_json as mentions, status, withdrawn_at as withdrawnAt, withdrawn_by as withdrawnBy, created_at as createdAt FROM messages WHERE thread_id = ? ORDER BY created_at').all(threadId) as Array<Record<string, unknown>>).map((row) => this.message(row));
  }
  addMessage(message: StoredMessage): void { this.db.prepare('INSERT OR REPLACE INTO messages(id, thread_id, author_id, body, mentions_json, status, withdrawn_at, withdrawn_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(message.id, message.threadId, message.authorId, message.body, JSON.stringify(message.mentions), message.status ?? 'visible', message.withdrawnAt ?? null, message.withdrawnBy ?? null, message.createdAt); }
  getMessage(id: string): Message | undefined {
    const row = this.db.prepare('SELECT id, thread_id as threadId, author_id as authorId, body, mentions_json as mentions, status, withdrawn_at as withdrawnAt, withdrawn_by as withdrawnBy, created_at as createdAt FROM messages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.message(row) : undefined;
  }
  saveMessage(message: Message): void { this.addMessage(message); }
  listSuggestions(docId: string): StoredSuggestion[] {
    const rows = this.db.prepare('SELECT id, doc_id as docId, thread_id as threadId, batch_id as batchId, author_id as authorId, author_kind as authorKind, anchor_json as anchor, new_text as newText, rationale, status, decided_by as decidedBy, decided_at as decidedAt, withdrawn_at as withdrawnAt, withdrawn_by as withdrawnBy, created_at as createdAt FROM suggestions WHERE doc_id = ? ORDER BY created_at').all(docId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.suggestion(row));
  }
  getSuggestion(id: string): StoredSuggestion | undefined {
    const row = this.db.prepare('SELECT id, doc_id as docId, thread_id as threadId, batch_id as batchId, author_id as authorId, author_kind as authorKind, anchor_json as anchor, new_text as newText, rationale, status, decided_by as decidedBy, decided_at as decidedAt, withdrawn_at as withdrawnAt, withdrawn_by as withdrawnBy, created_at as createdAt FROM suggestions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.suggestion(row) : undefined;
  }
  createSuggestion(suggestion: StoredSuggestion): void {
    this.saveSuggestion(suggestion);
  }
  saveSuggestion(suggestion: Suggestion): void { this.db.prepare('INSERT OR REPLACE INTO suggestions(id, doc_id, thread_id, batch_id, author_id, author_kind, anchor_json, new_text, rationale, status, decided_by, decided_at, withdrawn_at, withdrawn_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(suggestion.id, suggestion.docId, suggestion.threadId ?? null, suggestion.batchId ?? null, suggestion.authorId, suggestion.authorKind ?? null, JSON.stringify(suggestion.anchor), suggestion.newText, suggestion.rationale ?? null, suggestion.status, suggestion.decidedBy ?? null, suggestion.decidedAt ?? null, suggestion.withdrawnAt ?? null, suggestion.withdrawnBy ?? null, suggestion.createdAt); }
  updateSuggestionStatus(id: string, status: Suggestion['status'], decidedBy?: string, decidedAt?: number): void { this.db.prepare('UPDATE suggestions SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(status, decidedBy ?? null, decidedAt ?? null, id); }
  getBatch(id: string): Batch | undefined { return this.db.prepare('SELECT id, thread_id as threadId, created_by as createdBy, created_at as createdAt FROM batches WHERE id = ?').get(id) as Batch | undefined; }
  listBatches(threadId: string): Batch[] { return this.db.prepare('SELECT id, thread_id as threadId, created_by as createdBy, created_at as createdAt FROM batches WHERE thread_id = ? ORDER BY created_at').all(threadId) as unknown as Batch[]; }
  saveBatch(batch: Batch): void { this.db.prepare('INSERT OR REPLACE INTO batches(id, thread_id, created_by, created_at) VALUES (?, ?, ?, ?)').run(batch.id, batch.threadId, batch.createdBy, batch.createdAt); }
  getDocumentVersion(id: string): StoredDocumentVersion | undefined {
    const row = this.db.prepare('SELECT id, doc_id as docId, suggestion_id as suggestionId, kind, phase, source_version_id as sourceVersionId, thread_id as threadId, text, created_by as createdBy, created_at as createdAt FROM document_versions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.documentVersion(row) : undefined;
  }
  listDocumentVersions(docId: string): StoredDocumentVersion[] {
    const rows = this.db.prepare('SELECT id, doc_id as docId, suggestion_id as suggestionId, kind, phase, source_version_id as sourceVersionId, thread_id as threadId, text, created_by as createdBy, created_at as createdAt FROM document_versions WHERE doc_id = ? ORDER BY created_at, id').all(docId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.documentVersion(row));
  }
  saveDocumentVersion(version: StoredDocumentVersion): void {
    this.db.prepare('INSERT OR REPLACE INTO document_versions(id, doc_id, suggestion_id, kind, phase, source_version_id, thread_id, text, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(version.id, version.docId, version.suggestionId, version.kind ?? 'suggestion', version.phase ?? null, version.sourceVersionId ?? null, version.threadId ?? null, version.text, version.createdBy, version.createdAt);
  }
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

  private message(row: Record<string, unknown>): StoredMessage {
    return {
      id: String(row.id), threadId: String(row.threadId), authorId: String(row.authorId), body: String(row.body), mentions: JSON.parse(String(row.mentions)) as string[],
      createdAt: Number(row.createdAt), status: row.status === 'withdrawn' ? 'withdrawn' : 'visible',
      ...(row.withdrawnAt === null || row.withdrawnAt === undefined ? {} : { withdrawnAt: Number(row.withdrawnAt) }),
      ...(row.withdrawnBy === null || row.withdrawnBy === undefined ? {} : { withdrawnBy: String(row.withdrawnBy) }),
    };
  }

  private suggestion(row: Record<string, unknown>): StoredSuggestion {
    return {
      id: String(row.id), docId: String(row.docId),
      ...(row.threadId === null || row.threadId === undefined ? {} : { threadId: String(row.threadId) }),
      ...(row.batchId === null || row.batchId === undefined ? {} : { batchId: String(row.batchId) }),
      authorId: String(row.authorId),
      ...(row.authorKind === 'human' || row.authorKind === 'agent' ? { authorKind: row.authorKind } : {}),
      anchor: JSON.parse(String(row.anchor)) as StoredSuggestion['anchor'], newText: String(row.newText),
      ...(row.rationale === null || row.rationale === undefined ? {} : { rationale: String(row.rationale) }), status: row.status as StoredSuggestion['status'],
      ...(row.decidedBy === null || row.decidedBy === undefined ? {} : { decidedBy: String(row.decidedBy) }),
      ...(row.decidedAt === null || row.decidedAt === undefined ? {} : { decidedAt: Number(row.decidedAt) }),
      ...(row.withdrawnAt === null || row.withdrawnAt === undefined ? {} : { withdrawnAt: Number(row.withdrawnAt) }),
      ...(row.withdrawnBy === null || row.withdrawnBy === undefined ? {} : { withdrawnBy: String(row.withdrawnBy) }), createdAt: Number(row.createdAt),
    };
  }

  private documentVersion(row: Record<string, unknown>): StoredDocumentVersion {
    return {
      id: String(row.id),
      docId: String(row.docId),
      suggestionId: String(row.suggestionId),
      kind: row.kind === 'restore' ? 'restore' : 'suggestion',
      ...(row.phase === 'before' || row.phase === 'after' ? { phase: row.phase } : {}),
      ...(row.sourceVersionId === null || row.sourceVersionId === undefined ? {} : { sourceVersionId: String(row.sourceVersionId) }),
      ...(row.threadId === null || row.threadId === undefined ? {} : { threadId: String(row.threadId) }),
      text: String(row.text),
      createdBy: String(row.createdBy),
      createdAt: Number(row.createdAt),
    };
  }
}
