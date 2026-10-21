import type { LocalProjectFileInput } from '@collab/protocol';

/**
 * Browser access to a local folder. With the File System Access API the page
 * keeps file handles and can write edits back; otherwise a folder input only
 * imports the files once.
 */
export interface LocalFileHandle {
  kind: 'file';
  name: string;
  getFile: () => Promise<File>;
  createWritable?: () => Promise<{ write: (value: string) => Promise<void>; close: () => Promise<void> }>;
}
interface LocalDirectoryHandle {
  kind: 'directory';
  name: string;
  values: () => AsyncIterable<LocalFileHandle | LocalDirectoryHandle>;
}
type PickerWindow = Window & { showDirectoryPicker?: () => Promise<LocalDirectoryHandle> };

export interface PickedFolder {
  name: string;
  files: LocalProjectFileInput[];
  /** Present when the browser granted write access through the File System Access API. */
  handles?: Map<string, LocalFileHandle>;
  /** Read the same folder again (new and changed files) without asking the user. */
  rescan?: () => Promise<PickedFolder>;
}

const SUPPORTED = ['.txt', '.md'];

export function isSupportedDocument(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED.some((extension) => lower.endsWith(extension));
}

export function canPickDirectories(): boolean {
  return typeof (window as PickerWindow).showDirectoryPicker === 'function';
}

async function readDirectory(directory: LocalDirectoryHandle, prefix: string, files: LocalProjectFileInput[], handles: Map<string, LocalFileHandle>): Promise<void> {
  for await (const entry of directory.values()) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === 'directory') {
      await readDirectory(entry, relativePath, files, handles);
    } else if (isSupportedDocument(entry.name)) {
      const file = await entry.getFile();
      handles.set(relativePath, entry);
      files.push({ relativePath, text: await file.text(), size: file.size, mtimeMs: file.lastModified });
    }
  }
}

/** Resolves undefined when the user cancels the picker. */
export async function pickDirectory(): Promise<PickedFolder | undefined> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) return undefined;
  let directory: LocalDirectoryHandle;
  try {
    directory = await picker.call(window);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return undefined;
    throw error;
  }
  const read = async (): Promise<PickedFolder> => {
    const files: LocalProjectFileInput[] = [];
    const handles = new Map<string, LocalFileHandle>();
    await readDirectory(directory, '', files, handles);
    return { name: directory.name, files, handles, rescan: read };
  };
  return read();
}

/** Files from an `<input type="file" webkitdirectory>`; an import without write access. */
export async function readFolderInput(list: FileList | null): Promise<PickedFolder | undefined> {
  const selected = Array.from(list ?? []).filter((file) => isSupportedDocument(file.name));
  if (selected.length === 0 && (list?.length ?? 0) === 0) return undefined;
  const files = await Promise.all(selected.map(async (file) => ({
    relativePath: file.webkitRelativePath || file.name,
    text: await file.text(),
    size: file.size,
    mtimeMs: file.lastModified,
  })));
  const name = Array.from(list ?? [])[0]?.webkitRelativePath.split('/')[0] || '已选择的文件夹';
  return { name, files: files.map((file) => ({ ...file, relativePath: file.relativePath.split('/').slice(1).join('/') || file.relativePath })) };
}

/** Write a document back through a kept handle, refusing when the file changed on disk meanwhile. */
export async function writeBack(handle: LocalFileHandle, text: string, baselineMtime: number | undefined): Promise<'written' | 'conflict' | 'unavailable'> {
  if (!handle.createWritable) return 'unavailable';
  const file = await handle.getFile();
  if (baselineMtime !== undefined && file.lastModified > baselineMtime + 1000) return 'conflict';
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
  return 'written';
}
