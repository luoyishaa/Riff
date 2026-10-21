import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalProjectService, normalizeLocalProjectPath, normalizeRelativeProjectPath } from '../src/infra/local-project.js';
import type { DocumentRecord, DocumentStore, WorkspaceRecord, WorkspaceSource } from '../src/infra/document-store.js';
import { YjsDocument } from '@collab/kernel';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'collab-local-project-'));
  temporaryDirectories.push(directory);
  return directory;
}

class MemoryDocumentStore {
  readonly workspaces = new Map<string, WorkspaceRecord>();
  readonly documents = new Map<string, DocumentRecord>();

  createWorkspace(id: string, title: string, createdBy: string): WorkspaceRecord {
    const workspace: WorkspaceRecord = { id, title, createdBy, createdAt: 1, source: 'managed' };
    this.workspaces.set(id, workspace);
    return workspace;
  }

  workspace(id: string): WorkspaceRecord | undefined { return this.workspaces.get(id); }

  setWorkspaceSource(workspaceId: string, source: WorkspaceSource, rootPath?: string): void {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) {
      workspace.source = source;
      workspace.rootPath = rootPath;
    }
  }

  workspaceDocuments(workspaceId: string): DocumentRecord[] {
    return [...this.documents.values()].filter((document) => document.workspaceId === workspaceId);
  }

  documentByRelativePath(workspaceId: string, relativePath: string): DocumentRecord | undefined {
    return this.workspaceDocuments(workspaceId).find((document) => document.relativePath === relativePath);
  }

  create(id: string, title: string, text: string, _memberships: never[] = [], workspaceId?: string): DocumentRecord {
    const handle = new YjsDocument(id);
    if (text) handle.ydoc.getText('content').insert(0, text);
    const document: DocumentRecord = { id, title, workspaceId, syncStatus: 'managed', handle };
    this.documents.set(id, document);
    return document;
  }

  get(id: string): DocumentRecord | undefined { return this.documents.get(id); }

  setDocumentSource(docId: string, relativePath: string, sourceHash: string, sourceMtime: number, sourceSize: number, syncStatus: DocumentRecord['syncStatus']): void {
    const document = this.documents.get(docId);
    if (document) Object.assign(document, { relativePath, sourceHash, sourceMtime, sourceSize, syncStatus });
  }

  setDocumentSyncStatus(docId: string, syncStatus: DocumentRecord['syncStatus']): void {
    const document = this.documents.get(docId);
    if (document) document.syncStatus = syncStatus;
  }

  replaceDocumentText(docId: string, text: string, origin?: unknown): boolean {
    const document = this.documents.get(docId);
    return document?.handle.replace(0, document.handle.getText().length, text, origin).ok ?? false;
  }

  list(): Array<{ id: string; title: string; text: string; workspaceId?: string; relativePath?: string; syncStatus: DocumentRecord['syncStatus'] }> {
    return [...this.documents.values()].map((document) => ({ id: document.id, title: document.title, text: document.handle.getText(), workspaceId: document.workspaceId, relativePath: document.relativePath, syncStatus: document.syncStatus }));
  }
}

function workspaceFixture(): { directory: string; store: MemoryDocumentStore; service: LocalProjectService; workspaceId: string } {
  const directory = temporaryDirectory();
  const store = new MemoryDocumentStore();
  store.createWorkspace('workspace-1', 'Local project', 'alice');
  let nextId = 0;
  return {
    directory,
    store,
    service: new LocalProjectService(store as unknown as DocumentStore, () => `doc-${++nextId}`),
    workspaceId: 'workspace-1',
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('LocalProjectService', () => {
  it('scans nested .txt and .md files and ignores other file types', () => {
    const fixture = workspaceFixture();
    mkdirSync(join(fixture.directory, 'nested'));
    writeFileSync(join(fixture.directory, 'z.txt'), 'zeta', 'utf8');
    writeFileSync(join(fixture.directory, 'nested', 'a.TXT'), 'alpha', 'utf8');
    writeFileSync(join(fixture.directory, 'nested', 'guide.MD'), '# Guide', 'utf8');
    writeFileSync(join(fixture.directory, 'nested', 'image.png'), 'ignored', 'utf8');

    const result = fixture.service.bind(fixture.workspaceId, { path: fixture.directory });

    expect(result.source).toBe('local');
    expect(result.path).toBe(normalizeLocalProjectPath(fixture.directory));
    expect(result.files.map((file) => file.relativePath)).toEqual(['nested/a.TXT', 'nested/guide.MD', 'z.txt']);
    expect(result.files.map((file) => file.status)).toEqual(['imported', 'imported', 'imported']);
    expect(fixture.store.list().map((document) => document.title)).toEqual(['a', 'guide', 'z']);
  });

  it('writes an edited document back with an atomic sync', () => {
    const fixture = workspaceFixture();
    const filePath = join(fixture.directory, 'note.txt');
    writeFileSync(filePath, 'before', 'utf8');
    const imported = fixture.service.bind(fixture.workspaceId, { path: fixture.directory });
    const documentId = imported.files[0]?.documentId;
    expect(documentId).toBeDefined();

    const synced = fixture.service.syncDocument(documentId as string, 'after');

    expect(synced?.status).toBe('synced');
    expect(readFileSync(filePath, 'utf8')).toBe('after');
    expect(fixture.store.get(documentId as string)?.syncStatus).toBe('synced');
  });

  it('leaves both sides untouched and reports a conflict when disk and editor diverge', () => {
    const fixture = workspaceFixture();
    const filePath = join(fixture.directory, 'note.txt');
    writeFileSync(filePath, 'baseline', 'utf8');
    const imported = fixture.service.bind(fixture.workspaceId, { path: fixture.directory });
    const documentId = imported.files[0]?.documentId as string;
    writeFileSync(filePath, 'external edit', 'utf8');

    const result = fixture.service.syncDocument(documentId, 'editor edit');

    expect(result?.status).toBe('conflict');
    expect(readFileSync(filePath, 'utf8')).toBe('external edit');
    expect(fixture.store.get(documentId)?.handle.getText()).toBe('editor edit');
  });

  it('does not overwrite an external disk change when the editor is still at the baseline', () => {
    const fixture = workspaceFixture();
    const filePath = join(fixture.directory, 'note.txt');
    writeFileSync(filePath, 'baseline', 'utf8');
    const imported = fixture.service.bind(fixture.workspaceId, { path: fixture.directory });
    const documentId = imported.files[0]?.documentId as string;
    writeFileSync(filePath, 'external edit', 'utf8');

    const result = fixture.service.syncDocument(documentId, 'baseline');

    expect(result?.status).toBe('conflict');
    expect(readFileSync(filePath, 'utf8')).toBe('external edit');
  });

  it('marks a mapped file missing during a later scan', () => {
    const fixture = workspaceFixture();
    const filePath = join(fixture.directory, 'note.txt');
    writeFileSync(filePath, 'content', 'utf8');
    fixture.service.bind(fixture.workspaceId, { path: fixture.directory });
    unlinkSync(filePath);

    const result = fixture.service.scan(fixture.workspaceId);

    expect(result.files).toEqual([expect.objectContaining({ relativePath: 'note.txt', status: 'missing' })]);
  });

  it('keeps browser directory imports separate from live local paths', () => {
    const fixture = workspaceFixture();
    const result = fixture.service.bind(fixture.workspaceId, {
      files: [{ relativePath: 'imported.txt', text: 'uploaded text' }],
    });

    expect(result.source).toBe('imported');
    expect(result.path).toBeUndefined();
    expect(result.files[0]).toMatchObject({ relativePath: 'imported.txt', status: 'imported' });
    expect(fixture.store.workspace(fixture.workspaceId)).toMatchObject({ source: 'imported' });
  });
});

describe('local project path validation', () => {
  it('accepts only an existing absolute directory and .txt relative files', () => {
    const directory = temporaryDirectory();
    expect(normalizeLocalProjectPath(directory)).toBe(directory);
    expect(normalizeRelativeProjectPath('nested\\note.txt')).toBe('nested/note.txt');
    expect(() => normalizeRelativeProjectPath('../note.txt')).toThrow();
    expect(normalizeRelativeProjectPath('note.md')).toBe('note.md');
    expect(normalizeRelativeProjectPath('nested\\guide.MD')).toBe('nested/guide.MD');
    expect(() => normalizeRelativeProjectPath('note.markdown')).toThrow();
  });
});
