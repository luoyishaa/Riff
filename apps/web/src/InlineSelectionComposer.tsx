import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';

export type InlineComposerMode = 'comment' | 'suggestion';

export type InlineMember = {
  id: string;
  displayName: string;
  kind: 'human' | 'agent';
  handle?: string;
};

type MentionRange = { start: number; end: number; index: number };

export interface InlineSelectionComposerProps {
  mode: InlineComposerMode;
  top: number;
  left: number;
  members: InlineMember[];
  onSubmit: (body: string) => void | Promise<void>;
  onCancel: () => void;
}

function findMentionRange(value: string, caret: number): Omit<MentionRange, 'index'> | null {
  const beforeCaret = value.slice(0, caret);
  const match = /(?:^|[^\p{L}\p{N}_])@([^\n\s]*)$/u.exec(beforeCaret);
  if (!match || match.index === undefined) return null;
  const query = match[1] ?? '';
  return { start: caret - query.length - 1, end: caret };
}

export function InlineSelectionComposer({ mode, top, left, members, onSubmit, onCancel }: InlineSelectionComposerProps): React.ReactElement {
  const [value, setValue] = useState('');
  const [mention, setMention] = useState<MentionRange | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const candidates = useMemo(() => {
    if (!mention || mode !== 'comment') return [];
    const query = value.slice(mention.start + 1, mention.end).trim().toLocaleLowerCase();
    return members.filter((member) => {
      if (!query) return true;
      return member.displayName.toLocaleLowerCase().includes(query)
        || (member.handle?.toLocaleLowerCase().includes(query) ?? false);
    });
  }, [members, mention, mode, value]);

  const updateMention = (next: string, caret: number) => {
    const range = findMentionRange(next, caret);
    setMention(range ? { ...range, index: 0 } : null);
  };
  const insertMention = (member: InlineMember) => {
    if (!mention) return;
    const inserted = `@${member.displayName} `;
    const next = `${value.slice(0, mention.start)}${inserted}${value.slice(mention.end)}`;
    const caret = mention.start + inserted.length;
    setValue(next);
    setMention(null);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(caret, caret);
    });
  };
  const submit = () => {
    const body = value.trim();
    if (!body) return;
    onSubmit(body);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (mention && candidates.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const offset = event.key === 'ArrowDown' ? 1 : -1;
        setMention((current) => current ? { ...current, index: (current.index + offset + candidates.length) % candidates.length } : current);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        insertMention(candidates[mention.index] ?? candidates[0]!);
        return;
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  };
  const style: CSSProperties = { top, left };
  return (
    <div className="selection-inline-composer" style={style}>
      <textarea
        ref={inputRef}
        autoFocus
        aria-label={mode === 'comment' ? '添加选区评论' : '填写修改建议'}
        placeholder={mode === 'comment' ? '添加评论，可 @成员…' : '输入替换后的文本…'}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          updateMention(event.target.value, event.target.selectionStart ?? event.target.value.length);
        }}
        onClick={(event) => updateMention(event.currentTarget.value, event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
      />
      {mention && candidates.length > 0 ? (
        <div className="inline-mention-menu" role="listbox" aria-label="选择要提及的成员">
          {candidates.map((member, index) => (
            <button
              key={member.id}
              type="button"
              className={`inline-mention-option${index === mention.index ? ' selected' : ''}`}
              role="option"
              aria-selected={index === mention.index}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insertMention(member)}
            >
              <span className={`avatar${member.kind === 'agent' ? ' agent' : ''}`}>{member.kind === 'agent' ? 'AI' : member.displayName.slice(0, 1)}</span>
              <span><strong>{member.displayName}</strong><small>{member.handle ? `@${member.handle}` : member.kind === 'agent' ? 'Agent' : '成员'}</small></span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="selection-inline-composer-actions">
        <button type="button" onClick={onCancel}>取消</button>
        <button type="button" className="primary" disabled={!value.trim()} onClick={submit}>{mode === 'comment' ? '评论' : '提交建议'}</button>
      </div>
    </div>
  );
}
