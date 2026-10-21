import { useEffect, useRef } from 'react';
import { folderBinding } from '../lib/folderRegistry.js';
import { writeBack } from '../lib/localFolder.js';
import { useToast } from './useToast.js';

const WRITE_DELAY_MS = 700;

/**
 * When this page holds write access to the project's folder (File System
 * Access API), edits to the open document are written back to its file.
 */
export function useFolderWriteBack(workspaceId: string | undefined, docId: string | undefined, text: string, synced: boolean): void {
  const notify = useToast();
  const lastWritten = useRef<{ docId: string; text: string }>();
  useEffect(() => {
    if (!synced || docId === undefined) return undefined;
    // The text the document opened with is already on disk.
    if (lastWritten.current?.docId !== docId) { lastWritten.current = { docId, text }; return undefined; }
    if (lastWritten.current.text === text) return undefined;
    const binding = folderBinding(workspaceId);
    const path = binding?.paths.get(docId);
    const handle = path === undefined ? undefined : binding?.handles.get(path);
    if (!binding || path === undefined || !handle) return undefined;
    const timer = window.setTimeout(() => {
      void writeBack(handle, text, binding.baselines.get(path)).then((result) => {
        if (result === 'written') {
          binding.baselines.set(path, Date.now());
          lastWritten.current = { docId, text };
        } else if (result === 'conflict') {
          notify(`${path} 在别处被修改过，没有覆盖。请在侧栏同步后再编辑。`, 'error');
        }
      }).catch(() => notify(`写回 ${path} 失败，请重新选择文件夹。`, 'error'));
    }, WRITE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [workspaceId, docId, text, synced, notify]);
}
