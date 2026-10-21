import { useState } from 'react';
import type { AgentStatusEventDto, SuggestionDto, ThreadDto } from '@collab/protocol';
import { excerpt, relativeTime } from '../lib/format.js';
import { Icon } from './Icon.js';

export interface ThreadListProps {
  threads: ThreadDto[];
  suggestions: SuggestionDto[];
  activity: Record<string, AgentStatusEventDto>;
  identify: (principalId: string) => { name: string; kind: 'human' | 'agent' };
  onOpen: (thread: ThreadDto) => void;
}

/** Whole-document discussions first, then anchored ones in reading order; lost anchors last. */
function readingOrder(left: ThreadDto, right: ThreadDto): number {
  const position = (thread: ThreadDto): number => {
    if (thread.scope.type === 'document') return -1;
    return thread.scope.resolved.status === 'detached' ? Number.MAX_SAFE_INTEGER : thread.scope.resolved.start;
  };
  return position(left) - position(right) || right.latestActivityAt - left.latestActivityAt;
}

export function ThreadList({ threads, suggestions, activity, identify, onOpen }: ThreadListProps): React.ReactElement {
  const [filter, setFilter] = useState<'open' | 'resolved'>('open');
  const visible = threads.filter((thread) => thread.status === filter).sort(readingOrder);
  const resolvedCount = threads.filter((thread) => thread.status === 'resolved').length;
  return (
    <div className="thread-list">
      <div className="segmented small" role="tablist" aria-label="讨论状态">
        <button type="button" role="tab" aria-selected={filter === 'open'} className={filter === 'open' ? 'is-active' : ''} onClick={() => setFilter('open')}>进行中 {threads.length - resolvedCount}</button>
        <button type="button" role="tab" aria-selected={filter === 'resolved'} className={filter === 'resolved' ? 'is-active' : ''} onClick={() => setFilter('resolved')}>已解决 {resolvedCount}</button>
      </div>
      {visible.length === 0 ? (
        <div className="empty-state">
          <Icon name="comment" size={20} />
          <p>{filter === 'open' ? '还没有进行中的讨论。' : '没有已解决的讨论。'}</p>
          {filter === 'open' ? <small>在正文中选中文字后点“评论”，或输入 @Agent 请它修改。</small> : null}
        </div>
      ) : (
        <ul className="thread-cards">
          {visible.map((thread) => {
            const last = [...thread.messages].reverse().find((message) => message.status === 'visible') ?? thread.messages.at(-1);
            const pending = suggestions.filter((suggestion) => suggestion.threadId === thread.id && suggestion.status === 'pending' && suggestion.withdrawnAt === undefined).length;
            const status = activity[thread.id];
            const scope = thread.scope;
            return (
              <li key={thread.id}>
                <button type="button" className={`thread-card${thread.unread ? ' is-unread' : ''}`} onClick={() => onOpen(thread)}>
                  <span className="thread-card-scope">
                    {scope.type === 'document' ? <span className="scope-pill">整篇文档</span> : scope.resolved.status === 'detached' ? <span className="scope-pill is-detached">原文已修改</span> : <q>{excerpt(scope.quote, 48)}</q>}
                    {thread.kind === 'task' ? <span className="scope-pill is-task">任务{thread.agentId ? ` · ${identify(thread.agentId).name}` : ''}</span> : null}
                    {thread.unread ? <span className="unread-dot" aria-label="有新消息" /> : null}
                  </span>
                  {last ? (
                    <span className="thread-card-message">
                      <strong>{identify(last.authorId).name}</strong>
                      {last.status === 'withdrawn' ? <span className="muted">已撤回一条消息</span> : <span>{excerpt(last.body, 90)}</span>}
                    </span>
                  ) : null}
                  <span className="thread-card-foot">
                    <span>{thread.messages.length} 条消息</span>
                    {pending > 0 ? <span className="pending-pill">{pending} 条待审</span> : null}
                    {status?.state === 'working' ? <span className="working-pill"><span className="working-dot" />{identify(status.agentId).name} 处理中</span> : null}
                    <span className="thread-card-time">{relativeTime(thread.latestActivityAt)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
