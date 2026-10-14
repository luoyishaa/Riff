import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { YjsDocument, type Membership, type Principal, type Role } from '@collab/kernel';
import * as Y from 'yjs';
import { z } from 'zod';

export interface DocumentRecord { id: string; title: string; handle: YjsDocument }
const seedSchema = z.object({
  principals: z.array(z.object({ id: z.string(), kind: z.enum(['human', 'agent']), displayName: z.string(), ownerId: z.string().optional() })),
  document: z.object({ id: z.string(), title: z.string(), text: z.string() }),
  memberships: z.array(z.object({ principalId: z.string(), role: z.enum(['viewer', 'commenter', 'suggester', 'editor', 'owner']) })),
});
export class DocumentStore {
  readonly db: DatabaseSync;
  private readonly docs = new Map<string, DocumentRecord>();
  constructor(path = process.env.COLLAB_DB_PATH ?? 'collab.db') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS principals (id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT NOT NULL, owner_id TEXT);
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memberships (doc_id TEXT NOT NULL, principal_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (doc_id, principal_id));
      CREATE TABLE IF NOT EXISTS updates (doc_id TEXT NOT NULL, seq INTEGER PRIMARY KEY AUTOINCREMENT, "update" BLOB NOT NULL);`);
    this.loadDocuments();
  }
  private loadDocuments(): void {
    const rows = this.db.prepare('SELECT id, title FROM documents').all() as Array<{ id: string; title: string }>;
    for (const row of rows) {
      const handle = new YjsDocument(row.id);
      const updates = this.db.prepare('SELECT "update" FROM updates WHERE doc_id = ? ORDER BY seq').all(row.id) as Array<{ update: Uint8Array }>;
      for (const update of updates) handle.applyUpdate(new Uint8Array(update.update));
      this.docs.set(row.id, { id: row.id, title: row.title, handle });
    }
  }
  list(): Array<{ id: string; title: string; text: string }> { return [...this.docs.values()].map((doc) => ({ id: doc.id, title: doc.title, text: doc.handle.getText() })); }
  get(id: string): DocumentRecord | undefined { return this.docs.get(id); }
  create(id: string, title: string, text: string, memberships: Membership[] = []): DocumentRecord {
    const handle = new YjsDocument(id);
    if (text) handle.ydoc.getText('content').insert(0, text);
    this.db.prepare('INSERT INTO documents(id, title) VALUES (?, ?)').run(id, title);
    for (const member of memberships) this.setMembership(member);
    const record = { id, title, handle };
    this.docs.set(id, record);
    const update = Buffer.from(Y.encodeStateAsUpdate(handle.ydoc));
    if (update.length) this.db.prepare('INSERT INTO updates(doc_id, "update") VALUES (?, ?)').run(id, update);
    return record;
  }
  persistUpdate(docId: string, update: Uint8Array): void { this.db.prepare('INSERT INTO updates(doc_id, "update") VALUES (?, ?)').run(docId, update); }
  principals(): Principal[] { return this.db.prepare('SELECT id, kind, display_name as displayName, owner_id as ownerId FROM principals').all() as unknown as Principal[]; }
  upsertPrincipal(principal: Principal): void { this.db.prepare('INSERT OR REPLACE INTO principals(id, kind, display_name, owner_id) VALUES (?, ?, ?, ?)').run(principal.id, principal.kind, principal.displayName, principal.ownerId ?? null); }
  setMembership(membership: Membership): void { this.db.prepare('INSERT OR REPLACE INTO memberships(doc_id, principal_id, role) VALUES (?, ?, ?)').run(membership.docId, membership.principalId, membership.role); }
  role(docId: string, principalId: string): Role | null {
    const row = this.db.prepare('SELECT role FROM memberships WHERE doc_id = ? AND principal_id = ?').get(docId, principalId) as { role?: Role } | undefined;
    return row?.role ?? null;
  }
  members(docId: string): Array<Principal & { role: Role }> {
    return this.db.prepare(`SELECT p.id, p.kind, p.display_name as displayName, p.owner_id as ownerId, m.role
      FROM memberships m JOIN principals p ON p.id = m.principal_id WHERE m.doc_id = ?`).all(docId) as unknown as Array<Principal & { role: Role }>;
  }
  seed(): void {
    if (this.principals().length) return;
    const config = seedSchema.parse(JSON.parse(readFileSync(new URL('../../../../seed.config.json', import.meta.url), 'utf8')));
    for (const principal of config.principals) {
      const value: Principal = principal.ownerId === undefined
        ? { id: principal.id, kind: principal.kind, displayName: principal.displayName }
        : { id: principal.id, kind: principal.kind, displayName: principal.displayName, ownerId: principal.ownerId };
      this.upsertPrincipal(value);
    }
    const doc = this.create(config.document.id, config.document.title, config.document.text);
    for (const member of config.memberships) this.setMembership({ docId: doc.id, principalId: member.principalId, role: member.role });
  }
}
