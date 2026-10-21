import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DocumentConnection } from '../collab/connection.js';
import { resolveRange, trackRange, type TrackedRange } from '../collab/trackedRange.js';
import type { MentionCandidate } from '../lib/mentions.js';
import type { CommentRange, FocusRequest } from './Editor.js';
import { parseMarkdown, type Block, type ListBlock } from './markdown.js';
import { renderInline, renderLines, sourceText, type InlineContext, type PreviewMark } from './previewInline.js';
import { COMPOSER_WIDTH, InlineComposer, SelectionBubble, type OverlayPosition } from './SelectionTools.js';

export interface MarkdownPreviewProps {
  text: string;
  connection: DocumentConnection;
  marks: PreviewMark[];
  focus: FocusRequest | undefined;
  canComment: boolean;
  members: MentionCandidate[];
  onOpenThread: (threadId: string) => void;
  onComment: (range: CommentRange, body: string) => Promise<boolean>;
}

const FLASH_MS = 1400;

/** Source offset of a DOM boundary inside a span that carries `data-source-start`. */
function sourceOffset(root: HTMLElement, node: Node, offset: number): number | undefined {
  const element = node instanceof Element ? node : node.parentElement;
  const span = element?.closest<HTMLElement>('[data-source-start]');
  if (!span || !root.contains(span)) return undefined;
  const range = document.createRange();
  range.selectNodeContents(span);
  try { range.setEnd(node, offset); } catch { return undefined; }
  return Number(span.dataset.sourceStart) + range.toString().length;
}

function renderList(block: ListBlock, key: string, context: InlineContext): ReactNode {
  const items = block.items.map((item, index) => (
    <li key={`${key}-${index}`} className={item.task ? 'md-task' : undefined}>
      {item.task ? <input type="checkbox" checked={item.done === true} readOnly aria-label={item.done ? '已完成' : '未完成'} /> : null}
      <span>{renderLines(item.lines, `${key}-${index}`, context)}</span>
      {item.children.map((child, childIndex) => renderList(child, `${key}-${index}-${childIndex}`, context))}
    </li>
  ));
  return block.ordered
    ? <ol key={key} {...(block.startNumber > 1 ? { start: block.startNumber } : {})}>{items}</ol>
    : <ul key={key}>{items}</ul>;
}

function renderBlock(block: Block, key: string, context: InlineContext): ReactNode {
  switch (block.type) {
    case 'heading': {
      const Heading = `h${Math.min(6, block.level)}` as 'h1';
      return <Heading key={key}>{renderInline(block.line.text, block.line.start, key, context)}</Heading>;
    }
    case 'paragraph': return <p key={key}>{renderLines(block.lines, key, context)}</p>;
    case 'quote': return <blockquote key={key}>{renderLines(block.lines, key, context)}</blockquote>;
    case 'list': return renderList(block, key, context);
    case 'code': return <pre key={key} data-language={block.language || undefined}><code>{block.lines.flatMap((line, index) => [index > 0 ? '\n' : '', ...sourceText(line.text, line.start, `${key}-${index}`, context)])}</code></pre>;
    case 'math': return <div key={key} className="md-math">{block.lines.flatMap((line, index) => [index > 0 ? '\n' : '', ...sourceText(line.text, line.start, `${key}-${index}`, context)])}</div>;
    case 'html': return <div key={key} className="md-html">{block.lines.flatMap((line, index) => [index > 0 ? '\n' : '', ...sourceText(line.text, line.start, `${key}-${index}`, context)])}</div>;
    case 'rule': return <hr key={key} />;
    case 'table': return (
      <div key={key} className="md-table-wrap">
        <table>
          <thead><tr>{block.header.map((cell, index) => <th key={index} style={{ textAlign: block.alignments[index] }}>{renderInline(cell.text, cell.start, `${key}-h${index}`, context)}</th>)}</tr></thead>
          <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, index) => <td key={index} style={{ textAlign: block.alignments[index] }}>{renderInline(cell.text, cell.start, `${key}-${rowIndex}-${index}`, context)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
}

/** Rendered Markdown that keeps every character traceable to the source for comments. */
export function MarkdownPreview({ text, connection, marks, focus, canComment, members, onOpenThread, onComment }: MarkdownPreviewProps): React.ReactElement {
  const article = useRef<HTMLElement>(null);
  const selecting = useRef(false);
  const [bubble, setBubble] = useState<{ start: number; end: number; position: OverlayPosition }>();
  const [composer, setComposer] = useState<{ range: TrackedRange; quote: string; position: OverlayPosition }>();
  const [flash, setFlash] = useState<PreviewMark>();
  const parsed = useMemo(() => parseMarkdown(text), [text]);
  const content = useMemo(() => {
    const footnoteNumbers = new Map(parsed.footnotes.map((footnote, index) => [footnote.id, index + 1] as const));
    const context: InlineContext = { references: parsed.references, footnoteNumbers, marks: flash ? [...marks, flash] : marks };
    const blocks = parsed.blocks.map((block, index) => renderBlock(block, `b${index}`, context));
    if (parsed.footnotes.length > 0) {
      blocks.push(<section key="footnotes" className="md-footnotes"><ol>{parsed.footnotes.map((footnote) => <li key={footnote.id}>{renderLines(footnote.lines, `fn-${footnote.id}`, context)}</li>)}</ol></section>);
    }
    return blocks;
  }, [parsed, marks, flash]);

  const readSelection = (): { start: number; end: number; position: OverlayPosition } | undefined => {
    const root = article.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return undefined;
    if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return undefined;
    const anchor = sourceOffset(root, selection.anchorNode, selection.anchorOffset);
    const focusAt = sourceOffset(root, selection.focusNode, selection.focusOffset);
    if (anchor === undefined || focusAt === undefined || anchor === focusAt) return undefined;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const box = root.getBoundingClientRect();
    const left = Math.max(12, Math.min(box.width - COMPOSER_WIDTH - 12, rect.left - box.left - 24));
    return { start: Math.min(anchor, focusAt), end: Math.max(anchor, focusAt), position: { top: rect.bottom - box.top + 8, left } };
  };

  useEffect(() => {
    let timer: number | undefined;
    const onSelectionChange = (): void => {
      if (selecting.current) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setBubble(readSelection()), 120);
    };
    const onPointerUp = (): void => {
      if (!selecting.current) return;
      selecting.current = false;
      window.requestAnimationFrame(() => setBubble(readSelection()));
    };
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('pointerup', onPointerUp);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('pointerup', onPointerUp);
    };
  }, []);

  useEffect(() => {
    const root = article.current;
    if (!root || !focus) return undefined;
    const target = Array.from(root.querySelectorAll<HTMLElement>('[data-source-start]')).find((span) => Number(span.dataset.sourceStart) < focus.end && Number(span.dataset.sourceEnd) > focus.start);
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlash({ start: focus.start, end: Math.max(focus.end, focus.start + 1), className: 'md-flash' });
    const timer = window.setTimeout(() => setFlash(undefined), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [focus]);

  const openComposer = (): void => {
    if (!bubble) return;
    const quote = connection.ytext.toString().slice(bubble.start, bubble.end);
    setComposer({ range: trackRange(connection.ytext, bubble.start, bubble.end), quote, position: bubble.position });
    setBubble(undefined);
  };

  const submit = async (body: string): Promise<boolean> => {
    const range = composer ? resolveRange(connection.ytext, composer.range) : undefined;
    if (!range) { setComposer(undefined); return false; }
    const posted = await onComment({ ...range, quote: connection.ytext.toString().slice(range.start, range.end) }, body);
    if (posted) {
      setComposer(undefined);
      window.getSelection()?.removeAllRanges();
    }
    return posted;
  };

  return (
    <article
      ref={article}
      className="markdown-preview"
      aria-label="Markdown 预览"
      onPointerDown={(event) => { if (!(event.target as Element).closest('.inline-composer, .selection-bubble')) { selecting.current = true; setBubble(undefined); } }}
      onClick={(event) => {
        if (!window.getSelection()?.isCollapsed) return;
        const threadId = (event.target as Element).closest<HTMLElement>('[data-thread-id]')?.dataset.threadId;
        if (threadId) onOpenThread(threadId);
      }}
    >
      {parsed.blocks.length === 0 ? <p className="md-empty">这份文档还是空的。</p> : content}
      {bubble && canComment && !composer ? <SelectionBubble position={bubble.position} onComment={openComposer} /> : null}
      {composer ? <InlineComposer position={composer.position} quote={composer.quote} members={members} onSubmit={submit} onCancel={() => setComposer(undefined)} /> : null}
    </article>
  );
}
