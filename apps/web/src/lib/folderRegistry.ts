import type { LocalProjectStatusDto } from '@collab/protocol';
import type { LocalFileHandle, PickedFolder } from './localFolder.js';

/**
 * Folders picked in this page with write access, per project. Browsers do not
 * let a page keep directory access across reloads, so this lives in memory
 * only; after a reload the project falls back to its imported copy.
 */
export interface FolderBinding {
  name: string;
  handles: Map<string, LocalFileHandle>;
  /** Document id → relative path inside the folder. */
  paths: Map<string, string>;
  /** File modification time when this page last read or wrote it. */
  baselines: Map<string, number>;
  rescan?: () => Promise<PickedFolder>;
}

const bindings = new Map<string, FolderBinding>();

export function rememberFolder(workspaceId: string, folder: PickedFolder, status: LocalProjectStatusDto): void {
  if (!folder.handles) { bindings.delete(workspaceId); return; }
  bindings.set(workspaceId, {
    name: folder.name,
    handles: folder.handles,
    paths: new Map(status.files.map((file) => [file.documentId, file.relativePath])),
    baselines: new Map(folder.files.map((file) => [file.relativePath, file.mtimeMs ?? 0])),
    ...(folder.rescan ? { rescan: folder.rescan } : {}),
  });
}

export function folderBinding(workspaceId: string | undefined): FolderBinding | undefined {
  return workspaceId === undefined ? undefined : bindings.get(workspaceId);
}

export function forgetFolder(workspaceId: string): void {
  bindings.delete(workspaceId);
}
