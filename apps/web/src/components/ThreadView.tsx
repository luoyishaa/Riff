import { useEffect, useRef, useState } from 'react';
import type { AgentStatusEventDto, DocumentVersionDto, MemberDto, MessageDto, Role, SuggestionDto, ThreadDto } from '@collab/protocol';
import { can } from '../lib/permissions.js';
import { excerpt, fullTime, relativeTime } from '../lib/format.js';
import { agentStatusText } from '../lib/agentStatus.js';
import { Avatar } from './Avatar.js';
import { Icon } from './Icon.js';
import { MentionInput } from './MentionInput.js';
import { SuggestionCard, type SuggestionCardProps } from './SuggestionCard.js';

export interface ThreadViewProps {
  thread: ThreadDto;
  suggestions: SuggestionDto[];
  versions: DocumentVersionDto[];
  members: MemberDto[];
  viewerId: string;
  role: Role;
  activity: AgentStatusEventDto | undefined;
  /** Names and kinds of everyone who may appear in a thread, including departed members. */
  identify: (principalId: string) => { name: string; kind: 'human' | 'agent' };
  onBack: () => void;
  onReply: (body: string) => Promise<boolean>;
  onResolve: () => void;
  onWithdrawMessage: (message: MessageDto) => void;
  onLocate: (start: number, end: number) => void;
  onBatch: (batchId: string, action: 'accept' | 'reject') => void;
  suggestionHandlers: Pick<SuggestionCardProps, 'onAction' | 'onRevise' | 'onRestore'>;
}

type Entry = { kind: 'message'; at: number; message: MessageDto } | { kind: 'suggestion'; at: number; suggestion: SuggestionDto };

function BatchCard({ batchId, suggestions, canDecide, onBatch }: { batchId: string; suggestions: SuggestionDto[]; canDecide: boolean; onBatch: ThreadViewProps['onBatch'] }): React.ReactElement {
  const live = suggestions.filter((suggestion) => suggestion.withdrawnAt === undefined);
  const decided = live.filter((suggestion) => suggestion.status !== 'pending').length;
  const pending = live.length - decided;
  return (
    <section className="batch-card" aria-label="批量建议">
      <div className="batch-head">
        <strong>一批 {live.length} 条修改</strong>
        <span className="muted">已处理 {decided} / {live.length}</span>
      </div>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={live.length} aria-valuenow={decided}><span style={{ width: `${live.length ? (decided / live.length) * 100 : 0}%` }} /></div>
      {canDecide && pending > 0 ? (
        <div className="row-actions">
          <button type="button" className="button primary small" onClick={() => onBatch(batchId, 'accept')}>接受剩余 {pending} 条</button>
          <button type="button" className="button ghost small" onClick={() => onBatch(batchId, 'reject')}>拒绝剩余</button>
        </div>
      ) : null}
    </section>
  );
}

/** One discussion: its anchor, messages and suggestions in conversation order, and a reply box. */
export function ThreadView(props: ThreadViewProps): React.ReactElement {
  const { thread, suggestions, members, viewerId, role, activity } = props;
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const nameOf = (id: string): string => props.identify(id).name;
  const kindOf = (id: string): 'human' | 'agent' => props.identify(id).kind;
  const entries: Entry[] = [
    ...thread.messages.map((message): Entry => ({ kind: 'message', at: message.createdAt, message })),
    ...suggestions.map((suggestion): Entry => ({ kind: 'suggestion', at: suggestion.createdAt, suggestion })),
  ].sort((left, right) => left.at - right.at);
  const batches = [...new Set(suggestions.flatMap((suggestion) => suggestion.batchId ?? []))];
  const scope = thread.scope;
  const working = activity?.state === 'working';
  const canReply = thread.status === 'open' && can(role, 'comment');

  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [thread.id, entries.length, working]);

  const send = async (): Promise<void> => {
    if (!reply.trim() || busy) return;
    setBusy(true);
    if (await props.onReply(reply.trim())) setReply('');
    setBusy(false);
  };

  return (
    <div className="thread-view">
      <header className="thread-view-head">
        <button type="button" className="icon-button" onClick={props.onBack} aria-label="返回讨论列表"><Icon name="back" /></button>
        <div className="thread-view-title">
          <strong>{thread.kind === 'task' ? '任务' : '讨论'}{thread.agentId ? ` · 交给 ${nameOf(thread.agentId)}` : ''}</strong>
          <span className="muted">{thread.status === 'resolved' ? '已解决' : '进行中'} · 创建于 {relativeTime(thread.createdAt)}</span>
        </div>
        {thread.status === 'open' && can(role, 'comment') ? <button type="button" className="button ghost small" onClick={props.onResolve}><Icon name="check" size={14} />解决</button> : null}
      </header>
      {scope.type === 'range' ? (
        <button
          type="button"
          className={`thread-quote${scope.resolved.status === 'detached' ? ' is-detached' : ''}`}
          disabled={scope.resolved.status === 'detached'}
          onClick={() => { if (scope.resolved.status !== 'detached') props.onLocate(scope.resolved.start, scope.resolved.end); }}
          title={scope.resolved.status === 'detached' ? '原文已被修改或删除' : '在正文中定位'}
        >
          <span>{excerpt(scope.quote, 140)}</span>
          {scope.resolved.status === 'detached' ? <small>原文已被修改或删除，讨论保留在这里。</small> : null}
        </button>
      ) : <div className="thread-quote is-document">整篇文档</div>}

      <div className="thread-timeline">
        {batches.map((batchId) => <BatchCard key={batchId} batchId={batchId} suggestions={suggestions.filter((suggestion) => suggestion.batchId === batchId)} canDecide={can(role, 'approve')} onBatch={props.onBatch} />)}
        {entries.map((entry) => entry.kind === 'message' ? (
          <article key={entry.message.id} className={`message${entry.message.status === 'withdrawn' ? ' is-withdrawn' : ''}`}>
            <Avatar id={entry.message.authorId} name={nameOf(entry.message.authorId)} kind={kindOf(entry.message.authorId)} size="sm" />
            <div className="message-body">
              <header>
                <strong>{nameOf(entry.message.authorId)}</strong>
                <time className="muted" title={fullTime(entry.message.createdAt)}>{relativeTime(entry.message.createdAt)}</time>
                {entry.message.authorId === viewerId && entry.message.status !== 'withdrawn' ? <button type="button" className="link-button small" onClick={() => props.onWithdrawMessage(entry.message)}>撤回</button> : null}
              </header>
              {entry.message.status === 'withdrawn' ? <p className="muted">这条消息已撤回</p> : <p>{entry.message.body}</p>}
            </div>
          </article>
        ) : (
          <SuggestionCard key={entry.suggestion.id} suggestion={entry.suggestion} authorName={nameOf(entry.suggestion.authorId)} viewerId={viewerId} role={role} versions={props.versions} {...props.suggestionHandlers} onLocate={(suggestion) => { if (suggestion.resolved.status !== 'detached') props.onLocate(suggestion.resolved.start, suggestion.resolved.end); }} />
        ))}
        {activity && activity.state !== 'idle' ? (
          <div className={`agent-activity is-${activity.state}`} role="status">
            <Avatar id={activity.agentId} name={nameOf(activity.agentId)} kind="agent" size="sm" working={working} />
            <span>{agentStatusText(nameOf(activity.agentId), activity.state, activity.errorKind)}</span>
          </div>
        ) : null}
        <div ref={end} />
      </div>

      {canReply ? (
        <div className="thread-composer">
          <MentionInput value={reply} onChange={setReply} members={members} placeholder="回复，输入 @ 可以请成员或 Agent 处理" ariaLabel="回复讨论" onSubmit={() => void send()} rows={2} disabled={busy} menuPlacement="above" />
          <div className="row-actions">
            <span className="hint">Ctrl + Enter 发送</span>
            <button type="button" className="button primary small" onClick={() => void send()} disabled={!reply.trim() || busy}>回复</button>
          </div>
        </div>
      ) : thread.status === 'resolved' ? <p className="thread-closed">这条讨论已解决。</p> : null}
    </div>
  );
}
