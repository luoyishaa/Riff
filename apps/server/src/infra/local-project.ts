import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import type { LocalProjectBindInput } from '@collab/protocol';
import type { WorkspaceSource, DocumentRecord, DocumentStore } from './document-store.js';

export const LOCAL_PROJECT_DISK_ORIGIN = 'local-project:disk';
const SUPPORTED_PROJECT_EXTENSIONS = new Set(['.txt', '.md']);
export type LocalProjectFileStatus = 'imported' | 'synced' | 'updated' | 'conflict' | 'missing';
export interface LocalProjectFile {
  documentId: string;
  title: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
  status: LocalProjectFileStatus;
}
export interface LocalProjectStatus {
  workspaceId: string;
  source: WorkspaceSource;
  path?: string;
  files: LocalProjectFile[];
}
export interface LocalProjectScanResult extends LocalProjectStatus { createdDocumentIds: string[] }
interface DiskFile { relativePath: string; absolutePath: string; text: string; size: number; mtimeMs: number; hash: string }
interface ImportedFile { relativePath: string; text: string; size?: number | undefined; mtimeMs?: number | undefined }

function hashText(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }

export function normalizeLocalProjectPath(input: string): string {
  if (!isAbsolute(input)) throw new Error('Local project path must be absolute');
  const resolved = resolve(normalize(input));
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw new Error('Local project path must be an existing directory');
  return realpathSync(resolved);
}

export function normalizeRelativeProjectPath(input: string): string {
  const value = input.replaceAll('\\', '/');
  if (value.length === 0 || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:\//u.test(value)) throw new Error('Invalid project relative path');
  const normalized = normalize(value).replaceAll(sep, '/');
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error('Project path escapes its root');
  if (!SUPPORTED_PROJECT_EXTENSIONS.has(extname(normalized).toLowerCase())) throw new Error('Only .txt and .md files are supported');
  return normalized;
}

function titleFromPath(relativePath: string): string {
  const file = basename(relativePath);
  const extension = extname(file);
  return extension.length === 0 ? file : file.slice(0, -extension.length);
}

function scanDirectory(rootPath: string): DiskFile[] {
  const files: DiskFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) { visit(absolutePath); continue; }
      if (!entry.isFile() || !SUPPORTED_PROJECT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      const relativePath = normalizeRelativeProjectPath(relative(rootPath, absolutePath));
      const stat = statSync(absolutePath);
      const text = readFileSync(absolutePath, 'utf8');
      files.push({ relativePath, absolutePath, text, size: stat.size, mtimeMs: stat.mtimeMs, hash: hashText(text) });
    }
  };
  visit(rootPath);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function fileStatus(record: DocumentRecord, status: LocalProjectFileStatus): LocalProjectFile {
  return {
    documentId: record.id,
    title: record.title,
    relativePath: record.relativePath ?? '',
    size: record.sourceSize ?? Buffer.byteLength(record.handle.getText(), 'utf8'),
    mtimeMs: record.sourceMtime ?? 0,
    status,
  };
}

export class LocalProjectService {
  constructor(
    private readonly store: DocumentStore,
    private readonly nextId: () => string,
    private readonly onDocumentCreated?: (docId: string) => void,
  ) {}

  bind(workspaceId: string, input: LocalProjectBindInput): LocalProjectScanResult {
    if (input.path !== undefined) {
      const rootPath = normalizeLocalProjectPath(input.path);
      this.store.setWorkspaceSource(workspaceId, 'local', rootPath);
      return this.scanLocal(workspaceId, rootPath);
    }
    this.store.setWorkspaceSource(workspaceId, 'imported');
    return this.importFiles(workspaceId, input.files ?? []);
  }

  scan(workspaceId: string): LocalProjectScanResult {
    const workspace = this.store.workspace(workspaceId);
    if (!workspace) throw new Error('Workspace was not found');
    if (workspace.source !== 'local' || workspace.rootPath === undefined) {
      return { ...this.status(workspaceId), createdDocumentIds: [] };
    }
    return this.scanLocal(workspaceId, workspace.rootPath);
  }

  status(workspaceId: string): LocalProjectStatus {
    const workspace = this.store.workspace(workspaceId);
    if (!workspace) throw new Error('Workspace was not found');
    const source = workspace.source;
    const files = this.store.workspaceDocuments(workspaceId)
      .filter((record) => record.relativePath !== undefined)
      .map((record) => fileStatus(record, record.syncStatus === 'managed' ? 'imported' : record.syncStatus));
    return { workspaceId, source, ...(workspace.rootPath === undefined ? {} : { path: workspace.rootPath }), files };
  }

  /** Updates that came from the disk must not be written back to it. */
  isDiskOrigin(origin: unknown): boolean {
    return origin === LOCAL_PROJECT_DISK_ORIGIN;
  }

  onDocumentUpdate(docId: string): void {
    try {
      this.syncDocument(docId);
    } catch {
      this.store.setDocumentSyncStatus(docId, 'updated');
    }
  }

  syncDocument(docId: string, explicitText?: string): LocalProjectFile | undefined {
    const record = this.store.get(docId);
    if (!record || record.relativePath === undefined || record.workspaceId === undefined) return undefined;
    const workspace = this.store.workspace(record.workspaceId);
    if (!workspace) return undefined;
    if (explicitText !== undefined && explicitText !== record.handle.getText()) {
      this.store.replaceDocumentText(docId, explicitText, LOCAL_PROJECT_DISK_ORIGIN);
    }
    if (workspace.source !== 'local' || workspace.rootPath === undefined) {
      this.store.setDocumentSyncStatus(docId, 'updated');
      return fileStatus(record, 'updated');
    }
    const absolutePath = join(workspace.rootPath, record.relativePath);
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      this.store.setDocumentSyncStatus(docId, 'missing');
      return fileStatus(record, 'missing');
    }
    const diskText = readFileSync(absolutePath, 'utf8');
    const diskHash = hashText(diskText);
    const currentText = record.handle.getText();
    const currentHash = hashText(currentText);
    const baseline = record.sourceHash;
    if (baseline !== undefined && diskHash !== baseline && diskHash !== currentHash) {
      this.store.setDocumentSyncStatus(docId, 'conflict');
      return fileStatus(record, 'conflict');
    }
    if (diskHash === currentHash) {
      const stat = statSync(absolutePath);
      this.store.setDocumentSource(docId, record.relativePath, diskHash, stat.mtimeMs, stat.size, 'synced');
      return fileStatus(this.store.get(docId) ?? record, 'synced');
    }
    this.atomicWrite(absolutePath, currentText);
    const stat = statSync(absolutePath);
    this.store.setDocumentSource(docId, record.relativePath, currentHash, stat.mtimeMs, stat.size, 'synced');
    return fileStatus(this.store.get(docId) ?? record, 'synced');
  }

  private scanLocal(workspaceId: string, rootPath: string): LocalProjectScanResult {
    const diskFiles = scanDirectory(rootPath);
    const seen = new Set<string>();
    const createdDocumentIds: string[] = [];
    const statuses: LocalProjectFile[] = [];
    for (const file of diskFiles) {
      seen.add(file.relativePath);
      const existing = this.store.documentByRelativePath(workspaceId, file.relativePath);
      if (!existing) {
        const record = this.store.create(this.nextId(), titleFromPath(file.relativePath), file.text, [], workspaceId);
        this.store.setDocumentSource(record.id, file.relativePath, file.hash, file.mtimeMs, file.size, 'synced');
        createdDocumentIds.push(record.id);
        this.onDocumentCreated?.(record.id);
        statuses.push(fileStatus(this.store.get(record.id) ?? record, 'imported'));
        continue;
      }
      statuses.push(this.reconcileDiskFile(existing, file));
    }
    for (const record of this.store.workspaceDocuments(workspaceId)) {
      if (record.relativePath !== undefined && !seen.has(record.relativePath)) {
        this.store.setDocumentSyncStatus(record.id, 'missing');
        statuses.push(fileStatus(record, 'missing'));
      }
    }
    statuses.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return { workspaceId, source: 'local', path: rootPath, files: statuses, createdDocumentIds };
  }

  private importFiles(workspaceId: string, files: ImportedFile[]): LocalProjectScanResult {
    const statuses: LocalProjectFile[] = [];
    const createdDocumentIds: string[] = [];
    for (const input of files) {
      const relativePath = normalizeRelativeProjectPath(input.relativePath);
      const text = input.text;
      const hash = hashText(text);
      const existing = this.store.documentByRelativePath(workspaceId, relativePath);
      if (!existing) {
        const record = this.store.create(this.nextId(), titleFromPath(relativePath), text, [], workspaceId);
        this.store.setDocumentSource(record.id, relativePath, hash, input.mtimeMs ?? 0, input.size ?? Buffer.byteLength(text, 'utf8'), 'synced');
        createdDocumentIds.push(record.id);
        this.onDocumentCreated?.(record.id);
        statuses.push(fileStatus(this.store.get(record.id) ?? record, 'imported'));
        continue;
      }
      const currentHash = hashText(existing.handle.getText());
      if (existing.sourceHash !== undefined && currentHash !== existing.sourceHash && currentHash !== hash) {
        this.store.setDocumentSyncStatus(existing.id, 'conflict');
        statuses.push(fileStatus(existing, 'conflict'));
        continue;
      }
      this.store.replaceDocumentText(existing.id, text, LOCAL_PROJECT_DISK_ORIGIN);
      this.store.setDocumentSource(existing.id, relativePath, hash, input.mtimeMs ?? existing.sourceMtime ?? 0, input.size ?? Buffer.byteLength(text, 'utf8'), 'synced');
      statuses.push(fileStatus(this.store.get(existing.id) ?? existing, 'updated'));
    }
    return { workspaceId, source: 'imported', files: statuses, createdDocumentIds };
  }

  private reconcileDiskFile(record: DocumentRecord, file: DiskFile): LocalProjectFile {
    const currentHash = hashText(record.handle.getText());
    const baseline = record.sourceHash;
    if (baseline !== undefined && file.hash !== baseline && currentHash !== baseline && currentHash !== file.hash) {
      this.store.setDocumentSyncStatus(record.id, 'conflict');
      return fileStatus(record, 'conflict');
    }
    if (currentHash === file.hash) {
      this.store.setDocumentSource(record.id, file.relativePath, file.hash, file.mtimeMs, file.size, 'synced');
      return fileStatus(this.store.get(record.id) ?? record, 'synced');
    }
    if (baseline === undefined || currentHash === baseline) {
      this.store.replaceDocumentText(record.id, file.text, LOCAL_PROJECT_DISK_ORIGIN);
      this.store.setDocumentSource(record.id, file.relativePath, file.hash, file.mtimeMs, file.size, 'updated');
      return fileStatus(this.store.get(record.id) ?? record, 'updated');
    }
    return this.syncDocument(record.id) ?? fileStatus(record, 'conflict');
  }

  private atomicWrite(filePath: string, text: string): void {
    const temporaryPath = `${filePath}.collab-${process.pid}-${this.nextId()}.tmp`;
    writeFileSync(temporaryPath, text, 'utf8');
    renameSync(temporaryPath, filePath);
  }
}
