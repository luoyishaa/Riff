import { useState } from 'react';
import { MentionInput } from '../components/MentionInput.js';
import { Icon } from '../components/Icon.js';
import { excerpt } from '../lib/format.js';
import type { MentionCandidate } from '../lib/mentions.js';

export interface OverlayPosition { top: number; left: number }
export const COMPOSER_WIDTH = 340;

/** Floating action next to a finished selection. */
export function SelectionBubble({ position, onComment }: { position: OverlayPosition; onComment: () => void }): React.ReactElement {
  return (
    <div className="selection-bubble" style={{ top: position.top, left: position.left }} role="toolbar" aria-label="选区操作">
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onComment}>
        <Icon name="comment" size={14} />评论
      </button>
    </div>
  );
}

export interface InlineComposerProps {
  position: OverlayPosition;
  quote: string;
  members: MentionCandidate[];
  /** Resolves true when the comment was posted; the composer then closes. */
  onSubmit: (body: string) => Promise<boolean>;
  onCancel: () => void;
}

/** Comment box anchored to the selection; it stays open while others edit the document. */
export function InlineComposer({ position, quote, members, onSubmit, onCancel }: InlineComposerProps): React.ReactElement {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    if (!body.trim() || busy) return;
    setBusy(true);
    const posted = await onSubmit(body.trim());
    setBusy(false);
    if (posted) setBody('');
  };
  return (
    <div className="inline-composer" style={{ top: position.top, left: position.left, width: COMPOSER_WIDTH }} onMouseDown={(event) => event.stopPropagation()}>
      <blockquote className="inline-composer-quote">{excerpt(quote, 60)}</blockquote>
      <MentionInput
        value={body}
        onChange={setBody}
        members={members}
        placeholder="写下评论，输入 @ 可以请成员或 Agent 处理"
        ariaLabel="评论所选文字"
        onSubmit={() => void submit()}
        onCancel={onCancel}
        autoFocus
        rows={3}
        disabled={busy}
      />
      <div className="inline-composer-actions">
        <span className="hint">Ctrl + Enter 发布</span>
        <button type="button" className="button ghost small" onClick={onCancel}>取消</button>
        <button type="button" className="button primary small" disabled={!body.trim() || busy} onClick={() => void submit()}>{busy ? '发布中…' : '评论'}</button>
      </div>
    </div>
  );
}
