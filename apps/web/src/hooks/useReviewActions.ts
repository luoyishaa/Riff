import { useMemo } from 'react';
import type { BatchItemDecisionDto, DocumentVersionDto, MessageDto, SuggestionDto, ThreadDto } from '@collab/protocol';
import { api, describeError } from '../api.js';
import type { SuggestionAction } from '../components/SuggestionCard.js';
import type { DocumentData } from './useDocumentData.js';
import { useToast } from './useToast.js';

export interface NewThread {
  scope: { type: 'document' } | { type: 'range'; start: number; end: number; quote: string };
  body: string;
  agentId?: string;
}

const ACTION_DONE: Record<SuggestionAction, string> = { accept: '修改已应用到正文。', reject: '已拒绝这条修改。', withdraw: '已撤回这条建议。', regenerate: '已请 Agent 重新生成。' };
const ACTION_FAILED: Record<SuggestionAction, string> = { accept: '修改没有应用。', reject: '没有拒绝成功。', withdraw: '没有撤回成功。', regenerate: '无法重新生成。' };

/** Every review operation of one document, with user feedback and the right data refresh. */
export function useReviewActions(docId: string | undefined, data: Pick<DocumentData, 'refresh' | 'setThreads'>) {
  const notify = useToast();
  const { refresh, setThreads } = data;
  return useMemo(() => {
    const base = docId === undefined ? '' : `/api/docs/${encodeURIComponent(docId)}`;
    const attempt = async <T,>(work: () => Promise<T>, failure: string): Promise<T | undefined> => {
      try { return await work(); } catch (error) { notify(describeError(error, failure), 'error'); return undefined; }
    };
    return {
      createThread: async (input: NewThread): Promise<ThreadDto | undefined> => {
        const thread = await attempt(() => api<ThreadDto>(`${base}/threads`, {
          body: { kind: input.agentId ? 'task' : 'discussion', scope: input.scope, body: input.body, ...(input.agentId ? { agentId: input.agentId } : {}) },
        }), '评论没有发布。');
        if (thread) refresh('threads');
        return thread;
      },
      reply: async (threadId: string, body: string): Promise<boolean> => {
        const sent = await attempt(() => api<MessageDto>(`/api/threads/${encodeURIComponent(threadId)}/messages`, { body: { body } }), '回复没有发送。');
        if (sent) refresh('threads');
        return sent !== undefined;
      },
      resolve: async (threadId: string): Promise<void> => {
        if (await attempt(() => api(`/api/threads/${encodeURIComponent(threadId)}/resolve`, { method: 'POST' }), '没有标记为已解决。') !== undefined) {
          notify('讨论已解决。', 'success');
          refresh('threads');
        }
      },
      markRead: (thread: ThreadDto): void => {
        if (!thread.unread) return;
        setThreads((threads) => threads.map((item) => (item.id === thread.id ? { ...item, unread: false } : item)));
        void api(`/api/threads/${encodeURIComponent(thread.id)}/read`, { method: 'POST' }).catch(() => undefined);
      },
      withdrawMessage: async (message: MessageDto): Promise<void> => {
        if (!window.confirm('撤回后其他成员只会看到“已撤回”。确定撤回吗？')) return;
        if (await attempt(() => api(`/api/messages/${encodeURIComponent(message.id)}/withdraw`, { method: 'POST' }), '没有撤回成功。') !== undefined) refresh('threads');
      },
      suggestion: async (suggestion: SuggestionDto, action: SuggestionAction): Promise<void> => {
        if (action === 'withdraw' && !window.confirm('撤回后这条建议不再进入审批。确定撤回吗？')) return;
        const done = await attempt(() => api(`/api/suggestions/${encodeURIComponent(suggestion.id)}/${action}`, { method: 'POST' }), ACTION_FAILED[action]);
        if (done !== undefined) notify(ACTION_DONE[action], 'success');
        refresh('suggestions', 'threads', 'versions');
      },
      revise: async (suggestion: SuggestionDto, newText: string): Promise<boolean> => {
        const updated = await attempt(() => api<SuggestionDto>(`/api/suggestions/${encodeURIComponent(suggestion.id)}`, { method: 'PATCH', body: { newText } }), '建议没有更新。');
        if (updated) refresh('suggestions');
        return updated !== undefined;
      },
      batch: async (batchId: string, action: 'accept' | 'reject'): Promise<void> => {
        const results = await attempt(() => api<BatchItemDecisionDto[]>(`/api/batches/${encodeURIComponent(batchId)}/${action}-remaining`, { method: 'POST' }), '批量处理没有完成。');
        if (results) {
          const changed = results.filter((item) => item.status === (action === 'accept' ? 'accepted' : 'rejected')).length;
          const stale = results.filter((item) => item.status === 'stale').length;
          notify(action === 'accept' ? `已接受 ${changed} 条${stale ? `，${stale} 条因文字已改动而过期` : ''}。` : `已拒绝 ${changed} 条。`, 'success');
        }
        refresh('suggestions', 'threads', 'versions');
      },
      restore: async (version: DocumentVersionDto): Promise<boolean> => {
        if (!window.confirm('正文会回到这个版本，当前正文会先自动保存为一个版本。确定恢复吗？')) return false;
        const restored = await attempt(() => api(`${base}/versions/${encodeURIComponent(version.id)}/restore`, { method: 'POST' }), '版本没有恢复。');
        if (restored !== undefined) notify('已恢复。恢复前的正文已保存到版本历史。', 'success');
        refresh('versions', 'suggestions', 'threads');
        return restored !== undefined;
      },
    };
  }, [docId, refresh, setThreads, notify]);
}
