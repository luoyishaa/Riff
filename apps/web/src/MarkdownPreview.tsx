import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { InlineSelectionComposer, type InlineMember } from './InlineSelectionComposer.js';

export type MarkdownPreviewSelection = { start: number; end: number };
export type MarkdownPreviewAction = 'comment';
export type MarkdownReviewMarker = { id: string; start: number; end: number; kind: 'thread' | 'suggestion'; status: string; unread?: boolean };

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
  reviewMarkers?: MarkdownReviewMarker[];
  onReviewMarkerClick?: (markerId: string) => void;
  /** Opens a discussion for a block even when it has no existing thread. */
  onBlockClick?: (range: MarkdownPreviewSelection) => void;
}

type MarkdownBlock =
  | { type: 'heading'; level: number; text: string; sourceStart: number }
  | { type: 'paragraph'; text: string; sourceStart: number }
  | { type: 'quote'; lines: string[]; lineStarts: number[]; sourceStart: number }
  | { type: 'unordered-list' | 'ordered-list'; items: MarkdownListItem[]; start: number; sourceStart: number }
  | { type: 'table'; headers: MarkdownTableCell[]; alignments: MarkdownTableAlignment[]; rows: MarkdownTableCell[][]; sourceStart: number }
  | { type: 'code'; language: string; text: string; sourceStart: number }
  | { type: 'math'; text: string; sourceStart: number }
  | { type: 'html'; lines: string[]; lineStarts: number[]; sourceStart: number }
  | { type: 'footnotes'; items: MarkdownFootnote[]; sourceStart: number }
  | { type: 'rule'; sourceStart: number };

type MarkdownTableAlignment = 'left' | 'center' | 'right';
type MarkdownTableCell = { text: string; sourceStart: number };
type MarkdownListItem = { text: string; sourceStart: number; children: MarkdownBlock[] };
type MarkdownFootnote = { id: string; label: string; text: string; sourceStart: number };
type MarkdownReference = { href: string; title?: string };
type MarkdownLine = { text: string; start: number; newlineLength: number };
type MarkdownRenderContext = {
  references: ReadonlyMap<string, MarkdownReference>;
  footnotes: ReadonlyMap<string, MarkdownFootnote>;
  footnoteNumbers: ReadonlyMap<string, number>;
};
export type MarkdownDocument = { blocks: MarkdownBlock[]; references: ReadonlyMap<string, MarkdownReference>; footnotes: MarkdownFootnote[] };

function isSafeHref(value: string): boolean {
  return /^(?:https?:|mailto:)/i.test(value.trim());
}

export type MarkdownSourceSegment = { text: string; start: number; end: number };

export function splitSourceSegments(value: string, start: number): MarkdownSourceSegment[] {
  const segments: MarkdownSourceSegment[] = [];
  let index = 0;
  let offset = 0;
  while (index < value.length) {
    const codePoint = value.codePointAt(index);
    const width = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    segments.push({ text: value.slice(index, index + width), start: start + offset, end: start + offset + width });
    index += width;
    offset += width;
  }
  return segments;
}

function sourceSpan(value: string, start: number, key: string, className?: string): ReactNode {
  if (!value) return null;
  return splitSourceSegments(value, start).map((segment) => <span key={key + '-' + segment.start} className={className} data-source-start={segment.start} data-source-end={segment.end}>{segment.text}</span>);
}
function normalizeReferenceKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function renderInline(value: string, sourceStart = 0, keyPrefix = 'inline', context?: MarkdownRenderContext): ReactNode[] {
  const nodes: ReactNode[] = [];
  let remaining = value;
  let key = 0;
  let consumed = 0;

  // This is intentionally a small renderer rather than an HTML converter. Raw
  // HTML is always rendered as text, and links only accept explicit safe schemes.
  const tokenPattern = /(\\[\\`*_[\]{}()#+.!-]|`[^`]+`|\$\$[^$]+\$\$|\$(?:\\.|[^$\n])+\$|<https?:\/\/[^>]+>|\[\^[^\]]+\]|!?(?:\[[^\]]+\])\([^\s)]+(?:\s+["'][^"']*["'])?\)|\[[^\]]+\]\[[^\]]*\]|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*]+\*|_[^_]+_)/;
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
    } else if (token.startsWith('[') && token.includes('](')) {
      const labelEnd = token.indexOf('](');
      const urlEnd = token.lastIndexOf(')');
      const label = token.slice(1, labelEnd);
      const href = token.slice(labelEnd + 2, urlEnd).trim().replace(/^(["'])(.*)\1$/, '$2');
      const content = renderInline(label, tokenStart + 1, `${tokenKey}-label`, context);
      nodes.push(isSafeHref(href) ? <a key={tokenKey} href={href} target="_blank" rel="noreferrer">{content}</a> : <span key={tokenKey}>{content}</span>);
    } else if (token.startsWith('[^') && token.endsWith(']')) {
      const id = normalizeReferenceKey(token.slice(2, -1));
      const footnote = context?.footnotes.get(id);
      const number = context?.footnoteNumbers.get(id);
      if (footnote && number !== undefined) {
        nodes.push(<sup key={tokenKey}><a href={`#markdown-footnote-${id}`} aria-label={`脚注 ${number}`}>{sourceSpan(`[${number}]`, tokenStart, `${tokenKey}-content`)}</a></sup>);
      } else {
        nodes.push(sourceSpan(token, tokenStart, `${tokenKey}-content`));
      }
    } else if (token.startsWith('[') && token.includes('][') && token.endsWith(']')) {
      const split = token.indexOf('][');
      const label = token.slice(1, split);
      const id = normalizeReferenceKey(token.slice(split + 2, -1) || label);
      const reference = context?.references.get(id);
      const content = renderInline(label, tokenStart + 1, `${tokenKey}-label`, context);
      nodes.push(reference && isSafeHref(reference.href)
        ? <a key={tokenKey} href={reference.href} {...(reference.title ? { title: reference.title } : {})} target="_blank" rel="noreferrer">{content}</a>
        : <span key={tokenKey}>{content}</span>);
    } else if (token.startsWith('$') && token.endsWith('$')) {
      nodes.push(<span key={tokenKey} className="markdown-math-inline">{sourceSpan(token, tokenStart, `${tokenKey}-content`)}</span>);
    } else if (token.startsWith('\\')) {
      nodes.push(sourceSpan(token.slice(1), tokenStart + 1, `${tokenKey}-content`));
    } else if ((token.startsWith('**') && token.endsWith('**')) || (token.startsWith('__') && token.endsWith('__'))) {
      nodes.push(<strong key={tokenKey}>{renderInline(token.slice(2, -2), tokenStart + 2, `${tokenKey}-content`, context)}</strong>);
    } else if (token.startsWith('~~') && token.endsWith('~~')) {
      nodes.push(<del key={tokenKey}>{renderInline(token.slice(2, -2), tokenStart + 2, `${tokenKey}-content`, context)}</del>);
    } else if ((token.startsWith('*') && token.endsWith('*')) || (token.startsWith('_') && token.endsWith('_'))) {
      nodes.push(<em key={tokenKey}>{renderInline(token.slice(1, -1), tokenStart + 1, `${tokenKey}-content`, context)}</em>);
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

function splitMarkdownLines(value: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '\n' && character !== '\r') continue;
    const newlineLength = character === '\r' && value[index + 1] === '\n' ? 2 : 1;
    lines.push({ text: value.slice(start, index), start, newlineLength });
    index += newlineLength - 1;
    start = index + 1;
  }
  lines.push({ text: value.slice(start), start, newlineLength: 0 });
  return lines;
}

function listMarker(line: MarkdownLine): { indent: number; ordered: boolean; number: number; text: string; textOffset: number } | null {
  const match = /^(\s*)(?:(\d+)[.)]|[-+*])\s+(.+)$/.exec(line.text);
  if (!match) return null;
  const indent = match[1]?.replace(/\t/g, '    ').length ?? 0;
  const text = match[3] ?? '';
  return { indent, ordered: match[2] !== undefined, number: Number(match[2] ?? 1), text, textOffset: line.text.indexOf(text) };
}

function parseNestedList(lines: MarkdownLine[], startIndex: number, indent: number, ordered: boolean): { block: MarkdownBlock; nextIndex: number } {
  const items: MarkdownListItem[] = [];
  let index = startIndex;
  let firstNumber = 1;
  while (index < lines.length) {
    const line = lines[index];
    const marker = line ? listMarker(line) : null;
    if (!line || !marker || marker.indent !== indent || marker.ordered !== ordered) break;
    if (items.length === 0) firstNumber = marker.number;
    const item: MarkdownListItem = { text: marker.text, sourceStart: line.start + marker.textOffset, children: [] };
    index += 1;
    while (index < lines.length) {
      const continuation = lines[index];
      if (!continuation || continuation.text.trim() === '') break;
      const nested = listMarker(continuation);
      if (nested && nested.indent > indent) break;
      if (nested || continuation.text.search(/\S|$/) <= indent) break;
      item.text += '\n' + continuation.text.trim();
      index += 1;
    }
    while (index < lines.length) {
      const nestedLine = lines[index];
      const nested = nestedLine ? listMarker(nestedLine) : null;
      if (!nested || nested.indent <= indent) break;
      const parsed = parseNestedList(lines, index, nested.indent, nested.ordered);
      item.children.push(parsed.block);
      index = parsed.nextIndex;
    }
    items.push(item);
  }
  return {
    block: { type: ordered ? 'ordered-list' : 'unordered-list', items, start: firstNumber, sourceStart: lines[startIndex]?.start ?? 0 },
    nextIndex: index,
  };
}

function collectDefinitions(lines: MarkdownLine[]): { references: Map<string, MarkdownReference>; footnotes: MarkdownFootnote[]; ignored: Set<number> } {
  const references = new Map<string, MarkdownReference>();
  const footnotes: MarkdownFootnote[] = [];
  const ignored = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const footnote = /^ {0,3}\[\^([^\]]+)\]:\s*(.*)$/.exec(line.text);
    if (footnote) {
      const id = normalizeReferenceKey(footnote[1] ?? '');
      const firstText = footnote[2] ?? '';
      const parts = [firstText];
      ignored.add(index);
      let next = index + 1;
      while (next < lines.length && /^ {2,}\S/.test(lines[next]?.text ?? '')) {
        parts.push((lines[next]?.text ?? '').trim());
        ignored.add(next);
        next += 1;
      }
      footnotes.push({ id, label: footnote[1] ?? id, text: parts.join('\n'), sourceStart: line.start + line.text.indexOf(firstText) });
      index = next - 1;
      continue;
    }
    const reference = /^ {0,3}\[([^\]^]+)\]:\s*(\S+)(?:\s+(?:["']([^"']*)["']|\(([^)]*)\)))?\s*$/.exec(line.text);
    if (reference) {
      const id = normalizeReferenceKey(reference[1] ?? '');
      const title = reference[3] ?? reference[4];
      references.set(id, { href: reference[2] ?? '', ...(title ? { title } : {}) });
      ignored.add(index);
    }
  }
  return { references, footnotes, ignored };
}

function parseBlocks(value: string): MarkdownBlock[] {
  const lines = splitMarkdownLines(value);
  const definitions = collectDefinitions(lines);
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const current = lines[index];
    if (!current || definitions.ignored.has(index) || current.text.trim() === '') { index += 1; continue; }
    const line = current.text;
    const fence = /^ {0,3}(?:\x60\x60\x60|~~~)\s*([^\x60]*)$/.exec(line);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      const start = lines[index]?.start ?? current.start;
      while (index < lines.length && !/^ {0,3}(?:\x60\x60\x60|~~~)\s*$/.test(lines[index]?.text ?? '')) {
        codeLines.push(lines[index]?.text ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', language: fence[1]?.trim() ?? '', text: codeLines.join('\n'), sourceStart: start });
      continue;
    }
    if (/^ {0,3}\$\$(.*)\$\$\s*$/.test(line)) {
      blocks.push({ type: 'math', text: line.trim(), sourceStart: current.start + line.indexOf('$$') });
      index += 1;
      continue;
    }
    if (/^ {0,3}\$\$\s*$/.test(line)) {
      const mathLines = [line];
      const start = current.start + line.indexOf('$$');
      index += 1;
      while (index < lines.length && !/^ {0,3}\$\$\s*$/.test(lines[index]?.text ?? '')) {
        mathLines.push(lines[index]?.text ?? '');
        index += 1;
      }
      if (index < lines.length) mathLines.push(lines[index]?.text ?? '');
      if (index < lines.length) index += 1;
      blocks.push({ type: 'math', text: mathLines.join('\n'), sourceStart: start });
      continue;
    }
    if (/^ {0,3}(?:<!--|<\/?[A-Za-z][^>]*>)/.test(line)) {
      const htmlLines = [line];
      const htmlStarts = [current.start];
      index += 1;
      while (index < lines.length && lines[index]?.text.trim() !== '') {
        htmlLines.push(lines[index]?.text ?? '');
        htmlStarts.push(lines[index]?.start ?? 0);
        index += 1;
      }
      blocks.push({ type: 'html', lines: htmlLines, lineStarts: htmlStarts, sourceStart: current.start });
      continue;
    }
    const setext = index + 1 < lines.length ? /^ {0,3}(=+|-+)\s*$/.exec(lines[index + 1]?.text ?? '') : null;
    if (setext && line.trim()) {
      const visible = line.trim();
      blocks.push({ level: setext[1]?.startsWith('=') ? 1 : 2, type: 'heading', text: visible, sourceStart: current.start + line.indexOf(visible) });
      index += 2;
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '', sourceStart: current.start + line.indexOf(heading[2] ?? '') });
      index += 1;
      continue;
    }
    if (isRule(line)) { blocks.push({ type: 'rule', sourceStart: current.start }); index += 1; continue; }
    const tableHeader = splitTableCells(line, current.start);
    const tableDivider = index + 1 < lines.length ? splitTableCells(lines[index + 1]?.text ?? '', lines[index + 1]?.start ?? 0) : [];
    const alignments = tableDivider.map(tableAlignment);
    if (line.includes('|') && (lines[index + 1]?.text ?? '').includes('|') && tableHeader.length > 0 && tableHeader.length === tableDivider.length && alignments.every((alignment): alignment is MarkdownTableAlignment => alignment !== null)) {
      const rows: MarkdownTableCell[][] = [];
      const tableStart = current.start;
      index += 2;
      while (index < lines.length && lines[index]?.text.trim() !== '') {
        const row = splitTableCells(lines[index]?.text ?? '', lines[index]?.start ?? 0);
        if (row.length === 0 || !lines[index]?.text.includes('|')) break;
        const normalized = row.slice(0, tableHeader.length);
        while (normalized.length < tableHeader.length) normalized.push({ text: '', sourceStart: lines[index]?.start ?? 0 });
        rows.push(normalized);
        index += 1;
      }
      blocks.push({ type: 'table', headers: tableHeader, alignments, rows, sourceStart: tableStart });
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const quoteLines: string[] = [];
      const quoteLineStarts: number[] = [];
      const quoteStart = current.start;
      while (index < lines.length && /^ {0,3}>/.test(lines[index]?.text ?? '')) {
        const quoteLine = lines[index]?.text ?? '';
        quoteLines.push(quoteLine.replace(/^ {0,3}> ?/, ''));
        const visible = quoteLines[quoteLines.length - 1] ?? '';
        quoteLineStarts.push((lines[index]?.start ?? 0) + (visible ? quoteLine.indexOf(visible) : quoteLine.length));
        index += 1;
      }
      blocks.push({ type: 'quote', lines: quoteLines, lineStarts: quoteLineStarts, sourceStart: quoteStart });
      continue;
    }
    const marker = listMarker(current);
    if (marker && marker.indent <= 3) {
      const parsed = parseNestedList(lines, index, marker.indent, marker.ordered);
      blocks.push(parsed.block);
      index = parsed.nextIndex;
      continue;
    }
    const paragraph: string[] = [line.trim()];
    const paragraphStart = current.start + line.indexOf(line.trim());
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (!next || definitions.ignored.has(index) || next.text.trim() === '' || /^ {0,3}(?:\x60\x60\x60|~~~|#{1,6}\s|>|[-+*]\s+|\d+[.)]\s+|\$\$)/.test(next.text) || isRule(next.text)) break;
      paragraph.push(next.text.trim());
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraph.join('\n'), sourceStart: paragraphStart });
  }
  if (definitions.footnotes.length) blocks.push({ type: 'footnotes', items: definitions.footnotes, sourceStart: definitions.footnotes[0]?.sourceStart ?? value.length });
  return blocks;
}

export function parseMarkdown(value: string): MarkdownDocument {
  const definitions = collectDefinitions(splitMarkdownLines(value));
  return {
    blocks: parseBlocks(value),
    references: definitions.references,
    footnotes: definitions.footnotes,
  };
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

type MarkdownListBlock = Extract<MarkdownBlock, { type: 'unordered-list' | 'ordered-list' }>;

function renderListBlock(block: MarkdownListBlock, key: string, context?: MarkdownRenderContext): ReactNode {
  const List = block.type === 'ordered-list' ? 'ol' : 'ul';
  return <List {...(block.type === 'ordered-list' && block.start > 1 ? { start: block.start } : {})}>
    {block.items.map((item, itemIndex) => {
      const task = /^\[([ xX])\]\s+(.+)$/.exec(item.text);
      return <li key={`${key}-${itemIndex}`} className={task ? 'markdown-task-item' : undefined}>
        {task ? <><input type="checkbox" checked={task[1]?.toLowerCase() === 'x'} readOnly aria-label={task[1]?.toLowerCase() === 'x' ? '已完成' : '未完成'} /><span>{renderInline(task[2] ?? '', item.sourceStart + item.text.indexOf(task[2] ?? ''), `${key}-${itemIndex}`, context)}</span></> : renderInline(item.text, item.sourceStart, `${key}-${itemIndex}`, context)}
        {item.children.map((child, childIndex) => child.type === 'unordered-list' || child.type === 'ordered-list' ? <div key={`${key}-${itemIndex}-child-${childIndex}`}>{renderListBlock(child, `${key}-${itemIndex}-${childIndex}`, context)}</div> : null)}
      </li>;
    })}
  </List>;
}

export function MarkdownPreview({ value, className, onSelectionChange, onAction, onInlineActionSubmit, members = [], scrollTo, active = true, reviewMarkers = [], onReviewMarkerClick, onBlockClick }: MarkdownPreviewProps): React.ReactElement {
  const parsed = parseMarkdown(value);
  const blocks = parsed.blocks;
  const definitions = { references: parsed.references, footnotes: parsed.footnotes };
  const footnoteNumbers = new Map(definitions.footnotes.map((footnote, index) => [footnote.id, index + 1] as const));
  const renderContext: MarkdownRenderContext = { references: definitions.references, footnotes: new Map(definitions.footnotes.map((footnote) => [footnote.id, footnote])), footnoteNumbers };
  const rootRef = useRef<HTMLElement | null>(null);
  const pointerSelectingRef = useRef(false);
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);
  const [inlineComposer, setInlineComposer] = useState<{ top: number; left: number } | null>(null);
  const handleAction = (action: MarkdownPreviewAction) => {
    // Keep the browser selection so the review panel can still associate the
    // next comment or suggestion with the same source range. The menu itself
    // is transient and should disappear as soon as an action is chosen.
    if (menu) setInlineComposer({ top: menu.top + 42, left: menu.left });
    setMenu(null);
    onAction?.(action);
  };

  useEffect(() => {
    const readSelection = () => {
      const root = rootRef.current;
      const selection = window.getSelection();
      if (document.activeElement instanceof Element && document.activeElement.closest('.selection-inline-composer')) return;
      if (!root || !selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) {
        setMenu(null);
        onSelectionChange?.(null);
        return false;
      }
      const anchor = boundarySourceOffset(root, selection.anchorNode, selection.anchorOffset);
      const focus = boundarySourceOffset(root, selection.focusNode, selection.focusOffset);
      const quote = selection.toString();
      if (anchor === null || focus === null || anchor === focus || !quote.trim()) {
        setMenu(null);
        onSelectionChange?.(null);
        return false;
      }
      return { root, selection, anchor, focus };
    };
    const showSelectionMenu = () => {
      const selected = readSelection();
      if (!selected) return;
      const { root, selection, anchor, focus } = selected;
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
    const handleSelectionChange = () => {
      const selected = readSelection();
      if (!selected) return;
      onSelectionChange?.({ start: Math.min(selected.anchor, selected.focus), end: Math.max(selected.anchor, selected.focus) });
      // During a pointer drag the browser emits selectionchange repeatedly.
      // Keep the range available to the parent, but wait for pointerup before
      // showing the action menu so it never follows the text being selected.
      if (pointerSelectingRef.current) {
        setMenu(null);
        return;
      }
      window.requestAnimationFrame(showSelectionMenu);
    };
    const beginPointerSelection = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest('.markdown-selection-menu, .selection-inline-composer')) return;
      pointerSelectingRef.current = true;
      setMenu(null);
    };
    const finishPointerSelection = () => {
      if (!pointerSelectingRef.current) return;
      pointerSelectingRef.current = false;
      window.requestAnimationFrame(showSelectionMenu);
    };
    document.addEventListener('selectionchange', handleSelectionChange);
    rootRef.current?.addEventListener('pointerdown', beginPointerSelection);
    document.addEventListener('pointerup', finishPointerSelection);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      rootRef.current?.removeEventListener('pointerdown', beginPointerSelection);
      document.removeEventListener('pointerup', finishPointerSelection);
    };
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

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const sourceSpans = Array.from(root.querySelectorAll<HTMLElement>('[data-source-start][data-source-end]'));
    sourceSpans.forEach((span) => {
      span.classList.remove('markdown-review-range', 'markdown-review-thread', 'markdown-review-suggestion', 'markdown-review-unread');
      delete span.dataset.reviewId;
      delete span.dataset.reviewIds;
    });
    for (const marker of reviewMarkers) {
      const matching = sourceSpans.filter((span) => {
        const start = Number(span.dataset.sourceStart);
        const end = Number(span.dataset.sourceEnd);
        return Number.isFinite(start) && Number.isFinite(end) && start < marker.end && end > marker.start;
      });
      for (const span of matching) {
        span.classList.add('markdown-review-range', marker.kind === 'suggestion' ? 'markdown-review-suggestion' : 'markdown-review-thread');
        if (marker.unread) span.classList.add('markdown-review-unread');
        const ids = new Set((span.dataset.reviewIds ?? '').split(',').filter(Boolean));
        ids.add(marker.id);
        span.dataset.reviewIds = Array.from(ids).join(',');
        span.dataset.reviewId = marker.id;
      }
    }
  }, [reviewMarkers, value]);

  const handleReviewClick = (event: MouseEvent<HTMLElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const marker = target.closest<HTMLElement>('[data-review-id]');
    const markerId = marker?.dataset.reviewId;
    if (markerId) {
      onReviewMarkerClick?.(markerId);
      event.stopPropagation();
      return;
    }
    if (!onBlockClick) return;
    const block = target.closest<HTMLElement>('[data-block-start][data-block-end]');
    if (!block) return;
    const start = Number(block.dataset.blockStart);
    const end = Number(block.dataset.blockEnd);
    if (Number.isFinite(start) && Number.isFinite(end) && start < end) onBlockClick({ start, end });
  };

  return (
    <article ref={rootRef} onClick={handleReviewClick} className={`markdown-preview${className ? ` ${className}` : ''}`} aria-label="Markdown 预览">
      {menu ? (
        <div className="markdown-selection-menu" role="toolbar" aria-label="选区操作" style={{ top: menu.top, left: menu.left }}>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => handleAction('comment')}>评论</button>
        </div>
      ) : null}
      {inlineComposer && onInlineActionSubmit ? (
        <InlineSelectionComposer
          top={inlineComposer.top}
          left={inlineComposer.left}
          members={members}
          onCancel={() => setInlineComposer(null)}
          onSubmit={(body) => {
            setInlineComposer(null);
            void onInlineActionSubmit('comment', body);
          }}
        />
      ) : null}
      {blocks.length === 0 ? <p className="markdown-preview-empty">暂无内容</p> : blocks.map((block, index) => {
        const key = `block-${index}`;
        const blockEnd = blocks[index + 1]?.sourceStart ?? value.length;
        const blockData = { 'data-block-start': block.sourceStart, 'data-block-end': blockEnd };
        switch (block.type) {
          case 'heading': {
            const Heading = `h${block.level}` as keyof JSX.IntrinsicElements;
            return <Heading key={key} {...blockData}>{renderInline(block.text, block.sourceStart, key, renderContext)}</Heading>;
          }
          case 'paragraph':
            return <p key={key} {...blockData}>{renderInline(block.text, block.sourceStart, key, renderContext)}</p>;
          case 'quote':
            return <blockquote key={key} {...blockData}>{block.lines.map((line, lineIndex) => <span className="markdown-preview-line" key={`${key}-${lineIndex}`}>{renderInline(line, block.lineStarts[lineIndex] ?? 0, `${key}-${lineIndex}`, renderContext)}{lineIndex < block.lines.length - 1 ? <br /> : null}</span>)}</blockquote>;
          case 'unordered-list':
          case 'ordered-list': {
            const List = block.type === 'ordered-list' ? 'ol' : 'ul';
            return <List key={key} {...blockData} {...(block.type === 'ordered-list' && block.start > 1 ? { start: block.start } : {})}>{block.items.map((item, itemIndex) => {
              const start = item.sourceStart;
              const task = /^\[([ xX])\]\s+(.+)$/.exec(item.text);
              return <li key={`${key}-${itemIndex}`} className={task ? 'markdown-task-item' : undefined}>
                {task ? <><input type="checkbox" checked={task[1]?.toLowerCase() === 'x'} readOnly aria-label={task[1]?.toLowerCase() === 'x' ? '已完成' : '未完成'} /><span>{renderInline(task[2] ?? '', start + item.text.indexOf(task[2] ?? ''), `${key}-${itemIndex}`, renderContext)}</span></> : renderInline(item.text, start, `${key}-${itemIndex}`, renderContext)}
                {item.children.map((child, childIndex) => child.type === 'unordered-list' || child.type === 'ordered-list' ? <div key={`${key}-${itemIndex}-child-${childIndex}`}>{renderListBlock(child, `${key}-${itemIndex}-${childIndex}`, renderContext)}</div> : null)}
              </li>;
            })}</List>;
          }
          case 'table':
            return (
              <div key={key} className="markdown-table-wrap" {...blockData}>
                <table className="markdown-table">
                  <thead>
                    <tr>
                      {block.headers.map((cell, cellIndex) => <th key={`${key}-head-${cellIndex}`} style={{ textAlign: block.alignments[cellIndex] }}>{renderInline(cell.text, cell.sourceStart, `${key}-head-${cellIndex}`, renderContext)}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={`${key}-row-${rowIndex}`}>
                        {row.map((cell, cellIndex) => <td key={`${key}-row-${rowIndex}-${cellIndex}`} style={{ textAlign: block.alignments[cellIndex] }}>{renderInline(cell.text, cell.sourceStart, `${key}-row-${rowIndex}-${cellIndex}`, renderContext)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'code':
            return <pre key={key} data-language={block.language || undefined} {...blockData}><code>{sourceSpan(block.text, block.sourceStart, `${key}-code`)}</code></pre>;
          case 'math':
            return <div key={key} className="markdown-math-block" {...blockData}>{sourceSpan(block.text, block.sourceStart, `${key}-math`)}</div>;
          case 'html':
            return <div key={key} className="markdown-html-block" {...blockData}>{block.lines.map((line, lineIndex) => <span className="markdown-preview-line" key={`${key}-${lineIndex}`}>{sourceSpan(line, block.lineStarts[lineIndex] ?? block.sourceStart, `${key}-${lineIndex}`)}{lineIndex < block.lines.length - 1 ? <br /> : null}</span>)}</div>;
          case 'footnotes':
            return <section key={key} className="markdown-footnotes" {...blockData}><ol>{block.items.map((footnote, footnoteIndex) => <li id={`markdown-footnote-${footnote.id}`} key={`${key}-${footnoteIndex}`}>{renderInline(footnote.text, footnote.sourceStart, `${key}-${footnoteIndex}`, renderContext)}</li>)}</ol></section>;
          case 'rule':
            return <hr key={key} {...blockData} />;
          default:
            return null;
        }
      })}
    </article>
  );
}
