import { useEffect, useRef, useState, type ReactNode } from 'react';
import { InlineSelectionComposer, type InlineComposerMode, type InlineMember } from './InlineSelectionComposer.js';

export type MarkdownPreviewSelection = { start: number; end: number };
export type MarkdownPreviewAction = 'comment' | 'suggestion';

export interface MarkdownPreviewProps {
  value: string;
  className?: string;
  onSelectionChange?: (selection: MarkdownPreviewSelection | null) => void;
  onAction?: (action: MarkdownPreviewAction) => void;
  onInlineActionSubmit?: (action: MarkdownPreviewAction, body: string) => void | Promise<void>;
  members?: InlineMember[];
  /** Source offsets used by the document outline to bring a block into view. */
  scrollTo?: MarkdownPreviewSelection | null;
  /** Whether the preview pane is currently visible to the user. */
  active?: boolean;
}

type MarkdownBlock =
  | { type: 'heading'; level: number; text: string; sourceStart: number }
  | { type: 'paragraph'; text: string; sourceStart: number }
  | { type: 'quote'; lines: string[]; lineStarts: number[] }
  | { type: 'unordered-list' | 'ordered-list'; items: string[]; itemStarts: number[] }
  | { type: 'table'; headers: MarkdownTableCell[]; alignments: MarkdownTableAlignment[]; rows: MarkdownTableCell[][] }
  | { type: 'code'; language: string; text: string; sourceStart: number }
  | { type: 'rule' };

type MarkdownTableAlignment = 'left' | 'center' | 'right';
type MarkdownTableCell = { text: string; sourceStart: number };

function isSafeHref(value: string): boolean {
  return /^(?:https?:|mailto:)/i.test(value.trim());
}

function sourceSpan(value: string, start: number, key: string, className?: string): ReactNode {
  if (!value) return null;
  return <span key={key} className={className} data-source-start={start} data-source-end={start + value.length}>{value}</span>;
}

function renderInline(value: string, sourceStart = 0, keyPrefix = 'inline'): ReactNode[] {
  const nodes: ReactNode[] = [];
  let remaining = value;
  let key = 0;
  let consumed = 0;

  // This is intentionally a small renderer rather than an HTML converter. Raw
  // HTML is always rendered as text, and links only accept explicit safe schemes.
  const tokenPattern = /(`[^`]+`|<https?:\/\/[^>]+>|!?(?:\[[^\]]+\])\([^\s)]+(?:\s+["'][^"']*["'])?\)|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*]+\*|_[^_]+_)/;
  while (remaining.length > 0) {
    const match = tokenPattern.exec(remaining);
    if (!match || match.index === undefined) {
      nodes.push(sourceSpan(remaining, sourceStart + consumed, `${keyPrefix}-plain-${key}`));
      break;
    }
    if (match.index > 0) nodes.push(sourceSpan(remaining.slice(0, match.index), sourceStart + consumed, `${keyPrefix}-plain-${key}`));
    const token = match[0];
    const tokenKey = `${keyPrefix}-token-${key}`;
    const tokenStart = sourceStart + consumed + match.index;
    key += 1;

    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(<code key={tokenKey}>{sourceSpan(token.slice(1, -1), tokenStart + 1, `${tokenKey}-content`)}</code>);
    } else if (token.startsWith('<http')) {
      const href = token.slice(1, -1);
      nodes.push(<a key={tokenKey} href={href} target="_blank" rel="noreferrer">{sourceSpan(href, tokenStart + 1, `${tokenKey}-content`)}</a>);
    } else if (token.startsWith('![')) {
      // Images are deliberately not fetched in the preview. Display their alt
      // text so a local document cannot cause an unexpected network request.
      const altEnd = token.indexOf('](');
      nodes.push(<span key={tokenKey} className="markdown-image-alt">{sourceSpan(`[${token.slice(2, altEnd)}]`, tokenStart + 1, `${tokenKey}-content`)}</span>);
    } else if (token.startsWith('[')) {
      const labelEnd = token.indexOf('](');
      const urlEnd = token.lastIndexOf(')');
      const label = token.slice(1, labelEnd);
      const href = token.slice(labelEnd + 2, urlEnd).trim().replace(/^(["'])(.*)\1$/, '$2');
      const content = renderInline(label, tokenStart + 1, `${tokenKey}-label`);
      nodes.push(isSafeHref(href) ? <a key={tokenKey} href={href} target="_blank" rel="noreferrer">{content}</a> : <span key={tokenKey}>{content}</span>);
    } else if ((token.startsWith('**') && token.endsWith('**')) || (token.startsWith('__') && token.endsWith('__'))) {
      nodes.push(<strong key={tokenKey}>{renderInline(token.slice(2, -2), tokenStart + 2, `${tokenKey}-content`)}</strong>);
    } else if (token.startsWith('~~') && token.endsWith('~~')) {
      nodes.push(<del key={tokenKey}>{renderInline(token.slice(2, -2), tokenStart + 2, `${tokenKey}-content`)}</del>);
    } else if ((token.startsWith('*') && token.endsWith('*')) || (token.startsWith('_') && token.endsWith('_'))) {
      nodes.push(<em key={tokenKey}>{renderInline(token.slice(1, -1), tokenStart + 1, `${tokenKey}-content`)}</em>);
    } else {
      nodes.push(sourceSpan(token, tokenStart, `${tokenKey}-content`));
    }
    remaining = remaining.slice(match.index + token.length);
    consumed += match.index + token.length;
  }
  return nodes;
}

function isRule(line: string): boolean {
  return /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
}

function splitTableCells(line: string, lineStart: number): MarkdownTableCell[] {
  const cells: MarkdownTableCell[] = [];
  let segmentStart = 0;
  let escaped = false;
  const pushCell = (end: number) => {
    const raw = line.slice(segmentStart, end);
    const leading = raw.search(/\S|$/);
    cells.push({ text: raw.trim(), sourceStart: lineStart + segmentStart + leading });
  };
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '\\' && !escaped) {
      escaped = true;
      continue;
    }
    if (character === '|' && !escaped) {
      pushCell(index);
      segmentStart = index + 1;
    }
    escaped = false;
  }
  pushCell(line.length);
  if (line.trimStart().startsWith('|')) cells.shift();
  if (line.trimEnd().endsWith('|')) cells.pop();
  return cells;
}

function tableAlignment(cell: MarkdownTableCell): MarkdownTableAlignment | null {
  const value = cell.text;
  if (!/^:?-{1,}:?$/.test(value)) return null;
  if (value.startsWith(':') && value.endsWith(':')) return 'center';
  if (value.startsWith(':')) return 'left';
  if (value.endsWith(':')) return 'right';
  return 'left';
}

function parseBlocks(value: string): MarkdownBlock[] {
  const normalized = value.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const lineStarts: number[] = [];
  let offset = 0;
  lines.forEach((line) => {
    lineStarts.push(offset);
    offset += line.length + 1;
  });
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const fence = /^ {0,3}(?:```|~~~)\s*([^`]*)$/.exec(line);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      const codeStartIndex = index;
      while (index < lines.length && !/^ {0,3}(?:```|~~~)\s*$/.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', language: fence[1]?.trim() ?? '', text: codeLines.join('\n'), sourceStart: lineStarts[Math.min(codeStartIndex, lines.length - 1)] ?? 0 });
      continue;
    }

    const setext = index + 1 < lines.length ? /^ {0,3}(=+|-+)\s*$/.exec(lines[index + 1] ?? '') : null;
    if (setext && line.trim()) {
      const visible = line.trim();
      blocks.push({ level: setext[1]?.startsWith('=') ? 1 : 2, type: 'heading', text: visible, sourceStart: (lineStarts[index] ?? 0) + line.indexOf(visible) });
      index += 2;
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '', sourceStart: (lineStarts[index] ?? 0) + line.indexOf(heading[2] ?? '') });
      index += 1;
      continue;
    }
    if (isRule(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    const tableHeader = splitTableCells(line, lineStarts[index] ?? 0);
    const tableDivider = index + 1 < lines.length ? splitTableCells(lines[index + 1] ?? '', lineStarts[index + 1] ?? 0) : [];
    const alignments = tableDivider.map(tableAlignment);
    if (line.includes('|') && (lines[index + 1] ?? '').includes('|') && tableHeader.length > 0 && tableHeader.length === tableDivider.length && alignments.every((alignment): alignment is MarkdownTableAlignment => alignment !== null)) {
      const rows: MarkdownTableCell[][] = [];
      index += 2;
      while (index < lines.length && lines[index]?.trim() !== '') {
        const row = splitTableCells(lines[index] ?? '', lineStarts[index] ?? 0);
        if (row.length === 0 || !lines[index]?.includes('|')) break;
        const normalized = row.slice(0, tableHeader.length);
        while (normalized.length < tableHeader.length) normalized.push({ text: '', sourceStart: lineStarts[index] ?? 0 });
        rows.push(normalized);
        index += 1;
      }
      blocks.push({ type: 'table', headers: tableHeader, alignments, rows });
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const quoteLines: string[] = [];
      const quoteLineStarts: number[] = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index] ?? '')) {
        const current = lines[index] ?? '';
        quoteLines.push(current.replace(/^ {0,3}> ?/, ''));
        const visible = quoteLines[quoteLines.length - 1] ?? '';
        quoteLineStarts.push((lineStarts[index] ?? 0) + (visible ? current.indexOf(visible) : current.length));
        index += 1;
      }
      blocks.push({ type: 'quote', lines: quoteLines, lineStarts: quoteLineStarts });
      continue;
    }

    const listMatch = /^ {0,3}([-+*])\s+(.+)$/.exec(line) ?? /^ {0,3}\d+[.)]\s+(.+)$/.exec(line);
    if (listMatch) {
      const ordered = /^ {0,3}\d+[.)]\s+/.test(line);
      const items: string[] = [];
      const itemStarts: number[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const item = ordered ? /^ {0,3}\d+[.)]\s+(.+)$/.exec(current) : /^ {0,3}[-+*]\s+(.+)$/.exec(current);
        if (!item) break;
        const itemText = item[1] ?? '';
        items.push(itemText);
        itemStarts.push((lineStarts[index] ?? 0) + current.indexOf(itemText));
        index += 1;
      }
      blocks.push({ type: ordered ? 'ordered-list' : 'unordered-list', items, itemStarts });
      continue;
    }

    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length) {
      const next = lines[index] ?? '';
      if (next.trim() === '' || /^ {0,3}(?:```|#{1,6}\s|>|[-+*]\s+|\d+[.)]\s+)/.test(next) || isRule(next)) break;
      paragraph.push(next.trim());
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraph.join('\n'), sourceStart: (lineStarts[index - paragraph.length] ?? 0) + (lines[index - paragraph.length]?.indexOf((lines[index - paragraph.length] ?? '').trim()) ?? 0) });
  }
  return blocks;
}

function boundarySourceOffset(root: HTMLElement, node: Node, offset: number): number | null {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  const span = element?.closest<HTMLElement>('[data-source-start]');
  if (!span || !root.contains(span)) return null;
  const start = Number(span.dataset.sourceStart);
  if (!Number.isFinite(start)) return null;
  const range = document.createRange();
  try {
    range.selectNodeContents(span);
    range.setEnd(node, offset);
    return start + range.toString().length;
  } catch {
    return start;
  }
}

export function MarkdownPreview({ value, className, onSelectionChange, onAction, onInlineActionSubmit, members = [], scrollTo, active = true }: MarkdownPreviewProps): React.ReactElement {
  const blocks = parseBlocks(value);
  const rootRef = useRef<HTMLElement | null>(null);
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);
  const [inlineComposer, setInlineComposer] = useState<{ top: number; left: number; mode: InlineComposerMode } | null>(null);
  const handleAction = (action: MarkdownPreviewAction) => {
    // Keep the browser selection so the review panel can still associate the
    // next comment or suggestion with the same source range. The menu itself
    // is transient and should disappear as soon as an action is chosen.
    if (menu) setInlineComposer({ top: menu.top + 42, left: menu.left, mode: action });
    setMenu(null);
    onAction?.(action);
  };

  useEffect(() => {
    const handleSelectionChange = () => {
      const root = rootRef.current;
      const selection = window.getSelection();
      if (document.activeElement instanceof Element && document.activeElement.closest('.selection-inline-composer')) return;
      if (!root || !selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) {
        setMenu(null);
        onSelectionChange?.(null);
        return;
      }
      const anchor = boundarySourceOffset(root, selection.anchorNode, selection.anchorOffset);
      const focus = boundarySourceOffset(root, selection.focusNode, selection.focusOffset);
      const quote = selection.toString();
      if (anchor === null || focus === null || anchor === focus || !quote.trim()) {
        setMenu(null);
        onSelectionChange?.(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      const width = 164;
      const belowTop = rect.bottom - rootRect.top + 8;
      const aboveTop = rect.top - rootRect.top - 42;
      setMenu({
        top: belowTop + 42 <= root.clientHeight ? belowTop : Math.max(8, aboveTop),
        left: Math.max(8, Math.min(rootRect.width - width - 8, rect.left - rootRect.left)),
      });
      onSelectionChange?.({ start: Math.min(anchor, focus), end: Math.max(anchor, focus) });
    };
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
  }, [onSelectionChange]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !active || !scrollTo || scrollTo.start >= scrollTo.end) return;
    const target = Array.from(root.querySelectorAll<HTMLElement>('[data-source-start][data-source-end]')).find((element) => {
      const start = Number(element.dataset.sourceStart);
      const end = Number(element.dataset.sourceEnd);
      return Number.isFinite(start) && Number.isFinite(end) && start < scrollTo.end && end > scrollTo.start;
    });
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [active, scrollTo, value]);

  useEffect(() => {
    setMenu(null);
    setInlineComposer(null);
  }, [value]);

  return (
    <article ref={rootRef} className={`markdown-preview${className ? ` ${className}` : ''}`} aria-label="Markdown 预览">
      {menu ? (
        <div className="markdown-selection-menu" role="toolbar" aria-label="选区操作" style={{ top: menu.top, left: menu.left }}>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => handleAction('comment')}>评论</button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => handleAction('suggestion')}>建议修改</button>
        </div>
      ) : null}
      {inlineComposer && onInlineActionSubmit ? (
        <InlineSelectionComposer
          mode={inlineComposer.mode}
          top={inlineComposer.top}
          left={inlineComposer.left}
          members={members}
          onCancel={() => setInlineComposer(null)}
          onSubmit={(body) => {
            const mode = inlineComposer.mode;
            setInlineComposer(null);
            void onInlineActionSubmit(mode, body);
          }}
        />
      ) : null}
      {blocks.length === 0 ? <p className="markdown-preview-empty">暂无内容</p> : blocks.map((block, index) => {
        const key = `block-${index}`;
        switch (block.type) {
          case 'heading': {
            const Heading = `h${block.level}` as keyof JSX.IntrinsicElements;
            return <Heading key={key}>{renderInline(block.text, block.sourceStart, key)}</Heading>;
          }
          case 'paragraph':
            return <p key={key}>{renderInline(block.text, block.sourceStart, key)}</p>;
          case 'quote':
            return <blockquote key={key}>{block.lines.map((line, lineIndex) => <span className="markdown-preview-line" key={`${key}-${lineIndex}`}>{renderInline(line, block.lineStarts[lineIndex] ?? 0, `${key}-${lineIndex}`)}{lineIndex < block.lines.length - 1 ? <br /> : null}</span>)}</blockquote>;
          case 'unordered-list':
          case 'ordered-list': {
            const List = block.type === 'ordered-list' ? 'ol' : 'ul';
            return <List key={key}>{block.items.map((item, itemIndex) => {
              const start = block.itemStarts[itemIndex] ?? 0;
              const task = /^\[([ xX])\]\s+(.+)$/.exec(item);
              return <li key={`${key}-${itemIndex}`} className={task ? 'markdown-task-item' : undefined}>
                {task ? <><input type="checkbox" checked={task[1]?.toLowerCase() === 'x'} readOnly aria-label={task[1]?.toLowerCase() === 'x' ? '已完成' : '未完成'} /><span>{renderInline(task[2] ?? '', start + item.indexOf(task[2] ?? ''), `${key}-${itemIndex}`)}</span></> : renderInline(item, start, `${key}-${itemIndex}`)}
              </li>;
            })}</List>;
          }
          case 'table':
            return (
              <div key={key} className="markdown-table-wrap">
                <table className="markdown-table">
                  <thead>
                    <tr>
                      {block.headers.map((cell, cellIndex) => <th key={`${key}-head-${cellIndex}`} style={{ textAlign: block.alignments[cellIndex] }}>{renderInline(cell.text, cell.sourceStart, `${key}-head-${cellIndex}`)}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={`${key}-row-${rowIndex}`}>
                        {row.map((cell, cellIndex) => <td key={`${key}-row-${rowIndex}-${cellIndex}`} style={{ textAlign: block.alignments[cellIndex] }}>{renderInline(cell.text, cell.sourceStart, `${key}-row-${rowIndex}-${cellIndex}`)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'code':
            return <pre key={key} data-language={block.language || undefined}><code>{sourceSpan(block.text, block.sourceStart, `${key}-code`)}</code></pre>;
          case 'rule':
            return <hr key={key} />;
          default:
            return null;
        }
      })}
    </article>
  );
}
