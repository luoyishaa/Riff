import { useState } from 'react';
import type { DocumentVersionDto, Role, SuggestionDto } from '@collab/protocol';
import { can } from '../lib/permissions.js';
import { relativeTime } from '../lib/format.js';
import { Icon } from './Icon.js';

export type SuggestionAction = 'accept' | 'reject' | 'withdraw' | 'regenerate';

export interface SuggestionCardProps {
  suggestion: SuggestionDto;
  authorName: string;
  viewerId: string;
  role: Role;
  versions: DocumentVersionDto[];
  onAction: (suggestion: SuggestionDto, action: SuggestionAction) => Promise<void>;
  onRevise: (suggestion: SuggestionDto, newText: string) => Promise<boolean>;
  onRestore: (version: DocumentVersionDto) => void;
  onLocate?: (suggestion: SuggestionDto) => void;
}

const STATUS: Record<SuggestionDto['status'] | 'withdrawn', string> = { pending: '待审批', accepted: '已接受', rejected: '已拒绝', stale: '已过期', withdrawn: '已撤回' };

export function SuggestionCard({ suggestion, authorName, viewerId, role, versions, onAction, onRevise, onRestore, onLocate }: SuggestionCardProps): React.ReactElement {
  const [editing, setEditing] = useState<string>();
  const [busy, setBusy] = useState(false);
  const status = suggestion.withdrawnAt !== undefined ? 'withdrawn' : suggestion.status;
  const pending = status === 'pending';
  const before = versions.find((version) => version.suggestionId === suggestion.id && version.phase !== 'after');
  const act = async (action: SuggestionAction): Promise<void> => {
    setBusy(true);
    try { await onAction(suggestion, action); } finally { setBusy(false); }
  };
  const save = async (): Promise<void> => {
    if (editing === undefined) return;
    setBusy(true);
    try { if (await onRevise(suggestion, editing)) setEditing(undefined); } finally { setBusy(false); }
  };

  return (
    <article className={`suggestion-card is-${status}`}>
      <header className="suggestion-head">
        <span className={`status-chip is-${status}`}>{STATUS[status]}</span>
        <span className="suggestion-author">{authorName} 的修改建议</span>
        <time className="muted" dateTime={new Date(suggestion.createdAt).toISOString()}>{relativeTime(suggestion.createdAt)}</time>
      </header>
      {editing === undefined ? (
        <button type="button" className="diff" onClick={() => onLocate?.(suggestion)} disabled={!onLocate || suggestion.resolved.status === 'detached'} title="在正文中定位">
          {suggestion.quote ? <del>{suggestion.quote}</del> : null}
          {suggestion.newText ? <ins>{suggestion.newText}</ins> : <span className="muted">（删除这段文字）</span>}
        </button>
      ) : (
        <div className="suggestion-edit">
          <textarea value={editing} onChange={(event) => setEditing(event.target.value)} aria-label="接受前修改建议文本" rows={3} autoFocus />
          <div className="row-actions">
            <button type="button" className="button ghost small" onClick={() => setEditing(undefined)} disabled={busy}>取消</button>
            <button type="button" className="button primary small" onClick={() => void save()} disabled={busy}>保存</button>
          </div>
        </div>
      )}
      {suggestion.rationale ? <p className="suggestion-rationale">{suggestion.rationale}</p> : null}
      {status === 'stale' ? <p className="suggestion-note">这段文字在建议提出后被改动，建议已不能直接应用。</p> : null}
      <div className="row-actions">
        {pending && can(role, 'approve') && editing === undefined ? <>
          <button type="button" className="button primary small" onClick={() => void act('accept')} disabled={busy}><Icon name="check" size={14} />接受</button>
          <button type="button" className="button ghost small" onClick={() => void act('reject')} disabled={busy}>拒绝</button>
          <button type="button" className="button ghost small" onClick={() => setEditing(suggestion.newText)} disabled={busy}><Icon name="edit" size={14} />编辑</button>
        </> : null}
        {pending && suggestion.authorId === viewerId && editing === undefined ? <button type="button" className="button ghost small" onClick={() => void act('withdraw')} disabled={busy}>撤回</button> : null}
        {status === 'stale' && suggestion.authorKind === 'agent' && can(role, 'suggest') ? <button type="button" className="button secondary small" onClick={() => void act('regenerate')} disabled={busy}><Icon name="sync" size={14} />重新生成</button> : null}
        {status === 'accepted' && before && can(role, 'edit') ? <button type="button" className="button ghost small" onClick={() => onRestore(before)}><Icon name="undo" size={14} />恢复到这次修改前</button> : null}
      </div>
    </article>
  );
}
