import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { YjsDocument, type Membership, type Principal, type Role } from '@collab/kernel';
import { z } from 'zod';
import { documentKind, type DocumentSummaryDto } from '@collab/protocol';

// Loading the experimental built-in through require keeps Vite/Vitest from rewriting
// the `node:sqlite` specifier to a non-existent userland package.
const { DatabaseSync: DatabaseSyncConstructor } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSync;
};

export type WorkspaceSource = 'managed' | 'local' | 'imported';
export interface WorkspaceRecord { id: string; title: string; createdBy: string; createdAt: number; source: WorkspaceSource; rootPath?: string }
export interface WorkspaceMembership { workspaceId: string; principalId: string; role: Role }
export interface PrincipalRecord extends Principal { handle?: string; email?: string }
export type WorkspaceInvitationStatus = 'pending' | 'accepted' | 'rejected' | 'revoked';
export interface WorkspaceInvitationRecord {
  id: string;
  workspaceId: string;
  principalId: string;
  role: Exclude<Role, 'owner'>;
  invitedBy: string;
  status: WorkspaceInvitationStatus;
  createdAt: number;
  respondedAt?: number;
}
export interface DocumentRecord {
  id: string;
  title: string;
  workspaceId?: string;
  relativePath?: string;
  sourceHash?: string;
  sourceMtime?: number;
  sourceSize?: number;
  syncStatus: 'managed' | 'synced' | 'updated' | 'conflict' | 'missing';
  handle: YjsDocument;
}
type PrincipalRow = PrincipalRecord & { ownerId?: string | null; handle?: string | null; email?: string | null };
const PRINCIPAL_COLUMNS = 'id, kind, display_name as displayName, owner_id as ownerId, account_handle as handle, account_email as email';

function toPrincipal(row: PrincipalRow): PrincipalRecord {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.displayName,
    ...(row.ownerId === null || row.ownerId === undefined ? {} : { ownerId: row.ownerId }),
    ...(row.handle === null || row.handle === undefined ? {} : { handle: row.handle }),
    ...(row.email === null || row.email === undefined ? {} : { email: row.email }),
  };
}

/** Member queries select no email column, so members never carry one. */
function toMember(row: PrincipalRow & { role: Role }): PrincipalRecord & { role: Role } {
  return { ...toPrincipal(row), role: row.role };
}

const seedSchema = z.object({
  principals: z.array(z.object({ id: z.string(), kind: z.enum(['human', 'agent']), displayName: z.string(), ownerId: z.string().optional() })),
  workspace: z.object({ id: z.string(), title: z.string(), ownerId: z.string() }),
  document: z.object({ id: z.string(), title: z.string(), text: z.string() }),
  memberships: z.array(z.object({ principalId: z.string(), role: z.enum(['viewer', 'commenter', 'suggester', 'editor', 'owner']) })),
});
export class DocumentStore {
  readonly db: DatabaseSync;
  private readonly docs = new Map<string, DocumentRecord>();
  constructor(path = process.env.COLLAB_DB_PATH ?? 'collab.db') {
    this.db = new DatabaseSyncConstructor(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS principals (id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT NOT NULL, owner_id TEXT, account_handle TEXT, account_email TEXT, password_hash TEXT);
      CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, principal_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'managed', root_path TEXT);
      CREATE TABLE IF NOT EXISTS workspace_memberships (workspace_id TEXT NOT NULL, principal_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (workspace_id, principal_id));
      CREATE TABLE IF NOT EXISTS workspace_invitations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        role TEXT NOT NULL,
        invited_by TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        responded_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_id TEXT, relative_path TEXT, source_hash TEXT, source_mtime INTEGER, source_size INTEGER, sync_status TEXT NOT NULL DEFAULT 'managed');
      CREATE TABLE IF NOT EXISTS memberships (doc_id TEXT NOT NULL, principal_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (doc_id, principal_id));
      CREATE TABLE IF NOT EXISTS updates (doc_id TEXT NOT NULL, seq INTEGER PRIMARY KEY AUTOINCREMENT, "update" BLOB NOT NULL);`);
    const documentColumns = this.db.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>;
    if (!documentColumns.some((column) => column.name === 'workspace_id')) this.db.exec('ALTER TABLE documents ADD COLUMN workspace_id TEXT');
    if (!documentColumns.some((column) => column.name === 'relative_path')) this.db.exec('ALTER TABLE documents ADD COLUMN relative_path TEXT');
    if (!documentColumns.some((column) => column.name === 'source_hash')) this.db.exec('ALTER TABLE documents ADD COLUMN source_hash TEXT');
    if (!documentColumns.some((column) => column.name === 'source_mtime')) this.db.exec('ALTER TABLE documents ADD COLUMN source_mtime INTEGER');
    if (!documentColumns.some((column) => column.name === 'source_size')) this.db.exec('ALTER TABLE documents ADD COLUMN source_size INTEGER');
    if (!documentColumns.some((column) => column.name === 'sync_status')) this.db.exec("ALTER TABLE documents ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'managed'");
    const workspaceColumns = this.db.prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>;
    if (!workspaceColumns.some((column) => column.name === 'source')) this.db.exec("ALTER TABLE workspaces ADD COLUMN source TEXT NOT NULL DEFAULT 'managed'");
    if (!workspaceColumns.some((column) => column.name === 'root_path')) this.db.exec('ALTER TABLE workspaces ADD COLUMN root_path TEXT');
    const principalColumns = this.db.prepare('PRAGMA table_info(principals)').all() as Array<{ name: string }>;
    if (!principalColumns.some((column) => column.name === 'account_handle')) this.db.exec('ALTER TABLE principals ADD COLUMN account_handle TEXT');
    if (!principalColumns.some((column) => column.name === 'account_email')) this.db.exec('ALTER TABLE principals ADD COLUMN account_email TEXT');
    if (!principalColumns.some((column) => column.name === 'password_hash')) this.db.exec('ALTER TABLE principals ADD COLUMN password_hash TEXT');
    this.backfillAccountHandles();
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS principals_account_handle_idx ON principals(account_handle) WHERE account_handle IS NOT NULL');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS principals_account_email_idx ON principals(account_email) WHERE account_email IS NOT NULL');
    this.loadDocuments();
  }
  private loadDocuments(): void {
    const rows = this.db.prepare(`SELECT id, title, workspace_id as workspaceId, relative_path as relativePath,
      source_hash as sourceHash, source_mtime as sourceMtime, source_size as sourceSize,
      sync_status as syncStatus FROM documents`).all() as Array<{
      id: string; title: string; workspaceId?: string | null; relativePath?: string | null;
      sourceHash?: string | null; sourceMtime?: number | null; sourceSize?: number | null;
      syncStatus?: string | null;
    }>;
    for (const row of rows) {
      const handle = new YjsDocument(row.id);
      const updates = this.db.prepare('SELECT "update" FROM updates WHERE doc_id = ? ORDER BY seq').all(row.id) as Array<{ update: Uint8Array }>;
      for (const update of updates) handle.applyUpdate(new Uint8Array(update.update));
      const syncStatus = row.syncStatus === 'synced' || row.syncStatus === 'updated' || row.syncStatus === 'conflict' || row.syncStatus === 'missing' ? row.syncStatus : 'managed';
      this.docs.set(row.id, {
        id: row.id,
        title: row.title,
        ...(row.workspaceId === null || row.workspaceId === undefined ? {} : { workspaceId: row.workspaceId }),
        ...(row.relativePath === null || row.relativePath === undefined ? {} : { relativePath: row.relativePath }),
        ...(row.sourceHash === null || row.sourceHash === undefined ? {} : { sourceHash: row.sourceHash }),
        ...(row.sourceMtime === null || row.sourceMtime === undefined ? {} : { sourceMtime: row.sourceMtime }),
        ...(row.sourceSize === null || row.sourceSize === undefined ? {} : { sourceSize: row.sourceSize }),
        syncStatus,
        handle,
      });
    }
  }
  /** Document summaries; the text itself is only sent when a document is opened. */
  list(): DocumentSummaryDto[] {
    return [...this.docs.values()].map((doc) => ({
      id: doc.id,
      title: doc.title,
      ...(doc.workspaceId === undefined ? {} : { workspaceId: doc.workspaceId }),
      ...(doc.relativePath === undefined ? {} : { relativePath: doc.relativePath }),
      kind: documentKind(doc.relativePath ?? doc.title),
    }));
  }
  get(id: string): DocumentRecord | undefined { return this.docs.get(id); }
  create(id: string, title: string, text: string, memberships: Membership[] = [], workspaceId?: string): DocumentRecord {
    const handle = new YjsDocument(id, text);
    this.db.prepare('INSERT INTO documents(id, title, workspace_id, sync_status) VALUES (?, ?, ?, ?)').run(id, title, workspaceId ?? null, 'managed');
    for (const member of memberships) this.setMembership(member);
    const record: DocumentRecord = { id, title, ...(workspaceId === undefined ? {} : { workspaceId }), syncStatus: 'managed', handle };
    this.docs.set(id, record);
    const update = Buffer.from(handle.encodeStateAsUpdate());
    if (update.length) this.db.prepare('INSERT INTO updates(doc_id, "update") VALUES (?, ?)').run(id, update);
    return record;
  }
  persistUpdate(docId: string, update: Uint8Array): void { this.db.prepare('INSERT INTO updates(doc_id, "update") VALUES (?, ?)').run(docId, update); }
  principals(): PrincipalRecord[] {
    return (this.db.prepare(`SELECT ${PRINCIPAL_COLUMNS} FROM principals`).all() as unknown as PrincipalRow[]).map(toPrincipal);
  }
  principal(id: string): PrincipalRecord | undefined {
    const row = this.db.prepare(`SELECT ${PRINCIPAL_COLUMNS} FROM principals WHERE id = ?`).get(id) as PrincipalRow | undefined;
    return row ? toPrincipal(row) : undefined;
  }
  upsertPrincipal(principal: PrincipalRecord): void {
    const handle = principal.handle === undefined ? null : normalizeHandle(principal.handle);
    const email = principal.email === undefined ? null : normalizeHandle(principal.email);
    this.db.prepare(`INSERT INTO principals(id, kind, display_name, owner_id, account_handle, account_email) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, display_name = excluded.display_name,
      owner_id = excluded.owner_id, account_handle = COALESCE(excluded.account_handle, principals.account_handle),
      account_email = COALESCE(excluded.account_email, principals.account_email)`).run(principal.id, principal.kind, principal.displayName, principal.ownerId ?? null, handle, email);
  }
  humanPrincipalByIdentifier(identifier: string): PrincipalRecord | undefined {
    const normalized = normalizeHandle(identifier);
    if (!normalized) return undefined;
    const row = this.db.prepare(`SELECT ${PRINCIPAL_COLUMNS} FROM principals
      WHERE kind = 'human' AND (lower(account_handle) = ? OR lower(account_email) = ?)`).get(normalized, normalized) as PrincipalRow | undefined;
    return row ? toPrincipal(row) : undefined;
  }
  humanPrincipalByHandle(handle: string): PrincipalRecord | undefined {
    const normalized = normalizeHandle(handle);
    if (!normalized) return undefined;
    const row = this.db.prepare(`SELECT ${PRINCIPAL_COLUMNS} FROM principals WHERE kind = 'human' AND lower(account_handle) = ?`).get(normalized) as PrincipalRow | undefined;
    return row ? toPrincipal(row) : undefined;
  }
  searchHumanPrincipals(query: string, limit = 20): PrincipalRecord[] {
    const normalized = normalizeHandle(query);
    if (!normalized) return [];
    const pattern = `%${normalized}%`;
    const rows = this.db.prepare(`SELECT ${PRINCIPAL_COLUMNS} FROM principals
      WHERE kind = 'human' AND (lower(account_handle) LIKE ? OR lower(account_email) LIKE ? OR lower(display_name) LIKE ?)
      ORDER BY display_name, id LIMIT ?`).all(pattern, pattern, pattern, limit) as unknown as PrincipalRow[];
    return rows.map(toPrincipal);
  }
  principalHandleTaken(handle: string, exceptId?: string): boolean {
    const normalized = normalizeHandle(handle);
    if (!normalized) return false;
    const row = exceptId === undefined
      ? this.db.prepare("SELECT id FROM principals WHERE lower(account_handle) = ?").get(normalized) as { id?: string } | undefined
      : this.db.prepare("SELECT id FROM principals WHERE lower(account_handle) = ? AND id <> ?").get(normalized, exceptId) as { id?: string } | undefined;
    return row?.id !== undefined;
  }
  principalEmailTaken(email: string, exceptId?: string): boolean {
    const normalized = normalizeHandle(email);
    if (!normalized) return false;
    const row = exceptId === undefined
      ? this.db.prepare('SELECT id FROM principals WHERE lower(account_email) = ?').get(normalized) as { id?: string } | undefined
      : this.db.prepare('SELECT id FROM principals WHERE lower(account_email) = ? AND id <> ?').get(normalized, exceptId) as { id?: string } | undefined;
    return row?.id !== undefined;
  }
  setPrincipalPasswordHash(principalId: string, passwordHash: string): boolean {
    const result = this.db.prepare('UPDATE principals SET password_hash = ? WHERE id = ?').run(passwordHash, principalId);
    return result.changes > 0;
  }
  principalPasswordHash(principalId: string): string | undefined {
    const row = this.db.prepare('SELECT password_hash as passwordHash FROM principals WHERE id = ?').get(principalId) as { passwordHash?: string | null } | undefined;
    return row?.passwordHash === null || row?.passwordHash === undefined ? undefined : row.passwordHash;
  }
  createAuthSession(tokenHash: string, principalId: string, createdAt: number, expiresAt: number): void {
    this.db.prepare('INSERT INTO auth_sessions(token_hash, principal_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash, principalId, createdAt, expiresAt);
  }
  authSession(tokenHash: string, now: number): { principalId: string; expiresAt: number } | undefined {
    const row = this.db.prepare('SELECT principal_id as principalId, expires_at as expiresAt FROM auth_sessions WHERE token_hash = ?').get(tokenHash) as { principalId?: string; expiresAt?: number } | undefined;
    if (!row?.principalId || row.expiresAt === undefined) return undefined;
    if (row.expiresAt <= now) {
      this.revokeAuthSession(tokenHash);
      return undefined;
    }
    return { principalId: row.principalId, expiresAt: row.expiresAt };
  }
  principalIdForAuthSession(tokenHash: string, now: number): string | undefined {
    return this.authSession(tokenHash, now)?.principalId;
  }
  revokeAuthSession(tokenHash: string): void { this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash); }
  revokePrincipalSessions(principalId: string): void { this.db.prepare('DELETE FROM auth_sessions WHERE principal_id = ?').run(principalId); }
  updatePrincipalDisplayName(principalId: string, displayName: string): Principal | undefined {
    this.db.prepare('UPDATE principals SET display_name = ? WHERE id = ?').run(displayName, principalId);
    return this.principal(principalId);
  }
  updatePrincipalProfile(principalId: string, displayName: string, handle?: string, email?: string): PrincipalRecord | undefined {
    this.db.prepare(`UPDATE principals SET display_name = ?,
      account_handle = COALESCE(?, account_handle), account_email = COALESCE(?, account_email) WHERE id = ?`)
      .run(displayName, handle === undefined ? null : normalizeHandle(handle), email === undefined ? null : normalizeHandle(email), principalId);
    return this.principal(principalId);
  }
  setMembership(membership: Membership): void { this.db.prepare('INSERT OR REPLACE INTO memberships(doc_id, principal_id, role) VALUES (?, ?, ?)').run(membership.docId, membership.principalId, membership.role); }
  createWorkspace(id: string, title: string, createdBy: string, createdAt = Date.now()): WorkspaceRecord {
    this.db.prepare('INSERT INTO workspaces(id, title, created_by, created_at, source) VALUES (?, ?, ?, ?, ?)').run(id, title, createdBy, createdAt, 'managed');
    const workspace: WorkspaceRecord = { id, title, createdBy, createdAt, source: 'managed' };
    this.setWorkspaceMembership({ workspaceId: id, principalId: createdBy, role: 'owner' });
    return workspace;
  }
  updateWorkspaceTitle(id: string, title: string): WorkspaceRecord | undefined {
    const result = this.db.prepare('UPDATE workspaces SET title = ? WHERE id = ?').run(title, id);
    return result.changes === 0 ? undefined : this.workspace(id);
  }
  /**
   * Permanently removes a workspace and its documents. The caller must perform
   * the owner/confirmation checks before invoking this method.
   */
  deleteWorkspace(id: string): boolean {
    if (!this.workspace(id)) return false;
    const documentIds = this.workspaceDocuments(id).map((document) => document.id);
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM workspace_invitations WHERE workspace_id = ?').run(id);
      this.db.prepare('DELETE FROM workspace_memberships WHERE workspace_id = ?').run(id);
      for (const documentId of documentIds) {
        this.db.prepare('DELETE FROM memberships WHERE doc_id = ?').run(documentId);
        this.db.prepare('DELETE FROM updates WHERE doc_id = ?').run(documentId);
        this.db.prepare('DELETE FROM documents WHERE id = ?').run(documentId);
        this.deleteOptionalDocumentRows(documentId);
      }
      if (this.tableExists('agent_settings')) this.db.prepare('DELETE FROM agent_settings WHERE workspace_id = ?').run(id);
      this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
      this.db.exec('COMMIT');
      for (const documentId of documentIds) this.docs.delete(documentId);
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  /**
   * Permanently removes one document and its collaboration data. The caller
   * must perform membership and confirmation checks before invoking this
   * method. Local source files are intentionally left untouched; deleting a
   * document only removes the server-side mapping and collaboration state.
   */
  deleteDocument(id: string): boolean {
    if (!this.docs.has(id)) return false;
    this.db.exec('BEGIN');
    try {
      this.deleteOptionalDocumentRows(id);
      this.db.prepare('DELETE FROM memberships WHERE doc_id = ?').run(id);
      this.db.prepare('DELETE FROM updates WHERE doc_id = ?').run(id);
      const result = this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
      if (result.changes === 0) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db.exec('COMMIT');
      this.docs.delete(id);
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private tableExists(name: string): boolean {
    return this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  }
  /** Review and agent tables belong to other stores sharing this connection and may not exist yet. */
  private deleteOptionalDocumentRows(documentId: string): void {
    if (this.tableExists('threads')) {
      const threadIds = this.db.prepare('SELECT id FROM threads WHERE doc_id = ?').all(documentId) as Array<{ id: string }>;
      for (const thread of threadIds) {
        this.db.prepare('DELETE FROM messages WHERE thread_id = ?').run(thread.id);
        this.db.prepare('DELETE FROM batches WHERE thread_id = ?').run(thread.id);
        if (this.tableExists('thread_reads')) this.db.prepare('DELETE FROM thread_reads WHERE thread_id = ?').run(thread.id);
      }
      this.db.prepare('DELETE FROM threads WHERE doc_id = ?').run(documentId);
    }
    for (const table of ['suggestions', 'document_versions', 'agent_runs', 'agent_views']) {
      if (this.tableExists(table)) this.db.prepare(`DELETE FROM ${table} WHERE doc_id = ?`).run(documentId);
    }
  }
  workspace(id: string): WorkspaceRecord | undefined {
    const row = this.db.prepare(`SELECT id, title, created_by as createdBy, created_at as createdAt,
      source, root_path as rootPath FROM workspaces WHERE id = ?`).get(id) as (WorkspaceRecord & { rootPath?: string | null }) | undefined;
    if (!row) return undefined;
    return { ...row, ...(row.rootPath === null || row.rootPath === undefined ? {} : { rootPath: row.rootPath }) };
  }
  workspaces(principalId?: string): WorkspaceRecord[] {
    const rows = principalId === undefined
      ? this.db.prepare(`SELECT id, title, created_by as createdBy, created_at as createdAt,
          source, root_path as rootPath FROM workspaces ORDER BY created_at, id`).all()
      : this.db.prepare(`SELECT w.id, w.title, w.created_by as createdBy, w.created_at as createdAt,
          w.source, w.root_path as rootPath
        FROM workspaces w JOIN workspace_memberships m ON m.workspace_id = w.id
        WHERE m.principal_id = ? ORDER BY w.created_at, w.id`).all(principalId);
    return (rows as unknown as Array<WorkspaceRecord & { rootPath?: string | null }>).map((row) => ({ ...row, ...(row.rootPath === null || row.rootPath === undefined ? {} : { rootPath: row.rootPath }) }));
  }
  setWorkspaceSource(workspaceId: string, source: WorkspaceSource, rootPath?: string): void {
    this.db.prepare('UPDATE workspaces SET source = ?, root_path = ? WHERE id = ?').run(source, rootPath ?? null, workspaceId);
  }
  workspaceDocuments(workspaceId: string): DocumentRecord[] { return [...this.docs.values()].filter((doc) => doc.workspaceId === workspaceId); }
  documentByRelativePath(workspaceId: string, relativePath: string): DocumentRecord | undefined {
    return [...this.docs.values()].find((doc) => doc.workspaceId === workspaceId && doc.relativePath === relativePath);
  }
  setDocumentSource(docId: string, relativePath: string, sourceHash: string, sourceMtime: number, sourceSize: number, syncStatus: DocumentRecord['syncStatus']): void {
    this.db.prepare(`UPDATE documents SET relative_path = ?, source_hash = ?, source_mtime = ?, source_size = ?, sync_status = ? WHERE id = ?`).run(relativePath, sourceHash, sourceMtime, sourceSize, syncStatus, docId);
    const record = this.docs.get(docId);
    if (record) { record.relativePath = relativePath; record.sourceHash = sourceHash; record.sourceMtime = sourceMtime; record.sourceSize = sourceSize; record.syncStatus = syncStatus; }
  }
  setDocumentSyncStatus(docId: string, syncStatus: DocumentRecord['syncStatus']): void {
    this.db.prepare('UPDATE documents SET sync_status = ? WHERE id = ?').run(syncStatus, docId);
    const record = this.docs.get(docId); if (record) record.syncStatus = syncStatus;
  }
  replaceDocumentText(docId: string, text: string, origin?: unknown): boolean {
    const record = this.docs.get(docId); if (!record) return false;
    return record.handle.replace(0, record.handle.getText().length, text, origin).ok;
  }
  workspaceIdForDocument(docId: string): string | undefined {
    const row = this.db.prepare('SELECT workspace_id as workspaceId FROM documents WHERE id = ?').get(docId) as { workspaceId?: string | null } | undefined;
    return row?.workspaceId ?? undefined;
  }
  setDocumentWorkspace(docId: string, workspaceId: string): void {
    this.db.prepare('UPDATE documents SET workspace_id = ? WHERE id = ?').run(workspaceId, docId);
    const record = this.docs.get(docId);
    if (record) record.workspaceId = workspaceId;
  }
  workspaceRole(workspaceId: string, principalId: string): Role | null {
    const row = this.db.prepare('SELECT role FROM workspace_memberships WHERE workspace_id = ? AND principal_id = ?').get(workspaceId, principalId) as { role?: Role } | undefined;
    return row?.role ?? null;
  }
  setWorkspaceMembership(membership: WorkspaceMembership): void {
    this.db.prepare('INSERT OR REPLACE INTO workspace_memberships(workspace_id, principal_id, role) VALUES (?, ?, ?)').run(membership.workspaceId, membership.principalId, membership.role);
  }
  /**
   * Change a member's project role. Document-level memberships inside the
   * project override the project role, and no screen edits them separately,
   * so they follow the new role instead of silently keeping the old one.
   */
  updateWorkspaceMemberRole(workspaceId: string, principalId: string, role: Role): void {
    this.transaction(() => {
      this.setWorkspaceMembership({ workspaceId, principalId, role });
      this.db.prepare('UPDATE memberships SET role = ? WHERE principal_id = ? AND doc_id IN (SELECT id FROM documents WHERE workspace_id = ?)').run(role, principalId, workspaceId);
    });
  }
  /** Removing a member also removes their document-level access inside the project. */
  removeWorkspaceMembership(workspaceId: string, principalId: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM workspace_memberships WHERE workspace_id = ? AND principal_id = ?').run(workspaceId, principalId);
      this.db.prepare('DELETE FROM memberships WHERE principal_id = ? AND doc_id IN (SELECT id FROM documents WHERE workspace_id = ?)').run(principalId, workspaceId);
    });
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN');
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  workspaceMembers(workspaceId: string): Array<PrincipalRecord & { role: Role }> {
    const rows = this.db.prepare(`SELECT p.id, p.kind, p.display_name as displayName, p.owner_id as ownerId, p.account_handle as handle, m.role
      FROM workspace_memberships m JOIN principals p ON p.id = m.principal_id WHERE m.workspace_id = ? ORDER BY p.display_name`).all(workspaceId) as unknown as Array<PrincipalRow & { role: Role }>;
    return rows.map(toMember);
  }
  createWorkspaceInvitation(id: string, workspaceId: string, principalId: string, role: Exclude<Role, 'owner'>, invitedBy: string, createdAt = Date.now()): WorkspaceInvitationRecord {
    const existing = this.db.prepare(`SELECT id FROM workspace_invitations
      WHERE workspace_id = ? AND principal_id = ? AND status = 'pending'`).get(workspaceId, principalId) as { id?: string } | undefined;
    if (existing?.id !== undefined) {
      this.db.prepare('UPDATE workspace_invitations SET role = ?, invited_by = ?, created_at = ? WHERE id = ?').run(role, invitedBy, createdAt, existing.id);
      return this.workspaceInvitation(existing.id) as WorkspaceInvitationRecord;
    }
    this.db.prepare(`INSERT INTO workspace_invitations
      (id, workspace_id, principal_id, role, invited_by, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(id, workspaceId, principalId, role, invitedBy, createdAt);
    return {
      id,
      workspaceId,
      principalId,
      role,
      invitedBy,
      status: 'pending',
      createdAt,
    };
  }
  workspaceInvitation(id: string): WorkspaceInvitationRecord | undefined {
    const row = this.db.prepare(`SELECT id, workspace_id as workspaceId, principal_id as principalId,
      role, invited_by as invitedBy, status, created_at as createdAt, responded_at as respondedAt
      FROM workspace_invitations WHERE id = ?`).get(id) as (WorkspaceInvitationRecord & { respondedAt?: number | null }) | undefined;
    if (!row) return undefined;
    const status: WorkspaceInvitationStatus = row.status === 'accepted' || row.status === 'rejected' || row.status === 'revoked' ? row.status : 'pending';
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      principalId: row.principalId,
      role: row.role,
      invitedBy: row.invitedBy,
      status,
      createdAt: row.createdAt,
      ...(row.respondedAt === null || row.respondedAt === undefined ? {} : { respondedAt: row.respondedAt }),
    };
  }
  workspaceInvitations(workspaceId: string, status?: WorkspaceInvitationStatus): WorkspaceInvitationRecord[] {
    const rows = status === undefined
      ? this.db.prepare(`SELECT id FROM workspace_invitations WHERE workspace_id = ? ORDER BY created_at DESC, id`).all(workspaceId) as Array<{ id: string }>
      : this.db.prepare(`SELECT id FROM workspace_invitations WHERE workspace_id = ? AND status = ? ORDER BY created_at DESC, id`).all(workspaceId, status) as Array<{ id: string }>;
    return rows.flatMap((row) => {
      const invitation = this.workspaceInvitation(row.id);
      return invitation === undefined ? [] : [invitation];
    });
  }
  pendingWorkspaceInvitations(principalId: string): WorkspaceInvitationRecord[] {
    const rows = this.db.prepare(`SELECT id FROM workspace_invitations
      WHERE principal_id = ? AND status = 'pending' ORDER BY created_at DESC, id`).all(principalId) as Array<{ id: string }>;
    return rows.flatMap((row) => {
      const invitation = this.workspaceInvitation(row.id);
      return invitation === undefined ? [] : [invitation];
    });
  }
  acceptWorkspaceInvitation(id: string, principalId: string, respondedAt = Date.now()): WorkspaceInvitationRecord | undefined {
    const invitation = this.workspaceInvitation(id);
    if (invitation === undefined || invitation.status !== 'pending' || invitation.principalId !== principalId) return undefined;
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`UPDATE workspace_invitations SET status = 'accepted', responded_at = ? WHERE id = ? AND status = 'pending'`).run(respondedAt, id);
      this.setWorkspaceMembership({ workspaceId: invitation.workspaceId, principalId, role: invitation.role });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.workspaceInvitation(id);
  }
  rejectWorkspaceInvitation(id: string, principalId: string, respondedAt = Date.now()): WorkspaceInvitationRecord | undefined {
    const invitation = this.workspaceInvitation(id);
    if (invitation === undefined || invitation.status !== 'pending' || invitation.principalId !== principalId) return undefined;
    this.db.prepare(`UPDATE workspace_invitations SET status = 'rejected', responded_at = ? WHERE id = ? AND status = 'pending'`).run(respondedAt, id);
    return this.workspaceInvitation(id);
  }
  private directRole(docId: string, principalId: string): Role | null {
    const row = this.db.prepare('SELECT role FROM memberships WHERE doc_id = ? AND principal_id = ?').get(docId, principalId) as { role?: Role } | undefined;
    return row?.role ?? null;
  }
  role(docId: string, principalId: string): Role | null {
    const direct = this.directRole(docId, principalId);
    if (direct) return direct;
    const workspaceId = this.workspaceIdForDocument(docId);
    return workspaceId === undefined ? null : this.workspaceRole(workspaceId, principalId);
  }
  members(docId: string): Array<PrincipalRecord & { role: Role }> {
    const rows = this.db.prepare(`SELECT p.id, p.kind, p.display_name as displayName, p.owner_id as ownerId, p.account_handle as handle, m.role
      FROM memberships m JOIN principals p ON p.id = m.principal_id WHERE m.doc_id = ?`).all(docId) as unknown as Array<PrincipalRow & { role: Role }>;
    const direct = rows.map(toMember);
    const seen = new Set(direct.map((member) => member.id));
    const workspaceId = this.workspaceIdForDocument(docId);
    if (workspaceId === undefined) return direct;
    return [...direct, ...this.workspaceMembers(workspaceId).filter((member) => !seen.has(member.id))];
  }
  private backfillWorkspaces(): void {
    const count = Number((this.db.prepare('SELECT COUNT(*) as count FROM workspaces').get() as { count: number }).count);
    if (count > 0) return;
    const owner = this.principals().find((principal) => principal.kind === 'human');
    if (!owner) return;
    const workspace = this.createWorkspace('default-space', '默认空间', owner.id);
    const docs = this.db.prepare('SELECT id FROM documents WHERE workspace_id IS NULL').all() as Array<{ id: string }>;
    for (const doc of docs) {
      this.setDocumentWorkspace(doc.id, workspace.id);
      const members = this.db.prepare('SELECT principal_id as principalId, role FROM memberships WHERE doc_id = ?').all(doc.id) as Array<{ principalId: string; role: Role }>;
      for (const member of members) this.setWorkspaceMembership({ workspaceId: workspace.id, principalId: member.principalId, role: member.role });
    }
  }
  seed(): void {
    if (this.principals().length) { this.backfillWorkspaces(); return; }
    const config = seedSchema.parse(JSON.parse(readFileSync(new URL('../../../../seed.config.json', import.meta.url), 'utf8')));
    for (const principal of config.principals) {
      const value: PrincipalRecord = principal.ownerId === undefined
        ? { id: principal.id, kind: principal.kind, displayName: principal.displayName, ...(principal.kind === 'human' ? { handle: normalizeHandle(principal.id) } : {}) }
        : { id: principal.id, kind: principal.kind, displayName: principal.displayName, ownerId: principal.ownerId, ...(principal.kind === 'human' ? { handle: normalizeHandle(principal.id) } : {}) };
      this.upsertPrincipal(value);
    }
    const workspace = this.createWorkspace(config.workspace.id, config.workspace.title, config.workspace.ownerId);
    const doc = this.create(config.document.id, config.document.title, config.document.text, [], workspace.id);
    for (const member of config.memberships) this.setMembership({ docId: doc.id, principalId: member.principalId, role: member.role });
    for (const member of config.memberships) this.setWorkspaceMembership({ workspaceId: workspace.id, principalId: member.principalId, role: member.role });
  }
  private backfillAccountHandles(): void {
    const rows = this.db.prepare("SELECT id FROM principals WHERE kind = 'human' AND (account_handle IS NULL OR trim(account_handle) = '') ORDER BY id").all() as Array<{ id: string }>;
    const used = new Set<string>((this.db.prepare("SELECT account_handle as handle FROM principals WHERE account_handle IS NOT NULL").all() as Array<{ handle: string }>).map((row) => normalizeHandle(row.handle)).filter((handle) => handle.length > 0));
    for (const row of rows) {
      const base = normalizeHandle(row.id) || 'user';
      let candidate = base;
      let suffix = 2;
      while (used.has(candidate)) candidate = `${base}-${suffix++}`;
      this.db.prepare('UPDATE principals SET account_handle = ? WHERE id = ?').run(candidate, row.id);
      used.add(candidate);
    }
  }
}

function normalizeHandle(value: string): string {
  return value.trim().replace(/^@/u, '').toLocaleLowerCase();
}
