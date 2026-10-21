import { useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { findMentionQuery, insertMention, rankMentionCandidates, type MentionCandidate } from '../lib/mentions.js';
import { Avatar } from './Avatar.js';

export interface MentionInputProps {
  value: string;
  onChange: (value: string) => void;
  members: MentionCandidate[];
  placeholder: string;
  ariaLabel: string;
  onSubmit: () => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  rows?: number;
  disabled?: boolean;
  menuPlacement?: 'above' | 'below';
  inputRef?: RefObject<HTMLTextAreaElement>;
}

/** A textarea that completes `@name`; Ctrl/⌘+Enter submits and Esc cancels. */
export function MentionInput({ value, onChange, members, placeholder, ariaLabel, onSubmit, onCancel, autoFocus = false, rows = 3, disabled = false, menuPlacement = 'below', inputRef }: MentionInputProps): React.ReactElement {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const textarea = inputRef ?? ownRef;
  const [mention, setMention] = useState<{ start: number; caret: number; query: string; index: number }>();
  const candidates = mention ? rankMentionCandidates(members, mention.query) : [];

  const track = (next: string, caret: number): void => {
    const found = findMentionQuery(next, caret);
    setMention(found ? { start: found.start, caret, query: found.query, index: 0 } : undefined);
  };

  const choose = (candidate: MentionCandidate): void => {
    if (!mention) return;
    const next = insertMention(value, mention.start, mention.caret, candidate.displayName);
    onChange(next.value);
    setMention(undefined);
    window.requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (mention && candidates.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setMention({ ...mention, index: (mention.index + step + candidates.length) % candidates.length });
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const candidate = candidates[mention.index] ?? candidates[0];
        if (candidate) choose(candidate);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMention(undefined);
        return;
      }
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onSubmit();
    } else if (event.key === 'Escape' && onCancel) {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="mention-input">
      <textarea
        ref={textarea}
        className="mention-textarea"
        value={value}
        rows={rows}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={(event) => { onChange(event.target.value); track(event.target.value, event.target.selectionStart); }}
        onClick={(event) => track(event.currentTarget.value, event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        onBlur={() => window.setTimeout(() => setMention(undefined), 120)}
      />
      {mention && candidates.length > 0 ? (
        <div className={`mention-menu ${menuPlacement}`} role="listbox" aria-label="提及成员或 Agent">
          {candidates.map((candidate, index) => (
            <button
              key={candidate.id}
              type="button"
              role="option"
              aria-selected={index === mention.index}
              className={`mention-option${index === mention.index ? ' is-selected' : ''}`}
              onMouseDown={(event) => { event.preventDefault(); choose(candidate); }}
            >
              <Avatar id={candidate.id} name={candidate.displayName} kind={candidate.kind} size="sm" />
              <span className="mention-option-name">{candidate.displayName}</span>
              <span className="mention-option-meta">{candidate.kind === 'agent' ? 'Agent' : candidate.handle ? `@${candidate.handle}` : '成员'}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
