import type { ReactNode } from 'react';
import { normalizeReferenceKey, type Reference, type SourceLine } from './markdown.js';

/** A highlighted source range in the preview: comment underline, pending suggestion, flash. */
export interface PreviewMark { start: number; end: number; className: string; threadId?: string }

export interface InlineContext {
  references: ReadonlyMap<string, Reference>;
  footnoteNumbers: ReadonlyMap<string, number>;
  marks: PreviewMark[];
}

const TOKEN = /(\\[\\`*_[\]{}()#+.!-]|`[^`]+`|\$\$[^$]+\$\$|\$(?:\\.|[^$\n])+\$|<https?:\/\/[^>]+>|\[\^[^\]]+\]|!?\[[^\]]+\]\([^\s)]+(?:\s+["'][^"']*["'])?\)|\[[^\]]+\]\[[^\]]*\]|\[[^\]\n]+\]|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*]+\*|_[^_]+_)/u;

function isSafeHref(value: string): boolean {
  return /^(?:https?:|mailto:)/iu.test(value.trim());
}

/**
 * Source characters rendered as-is. Each span records its source offsets so a
 * selection maps back to the text; spans split only where a mark starts or ends.
 */
export function sourceText(text: string, start: number, key: string, context: InlineContext): ReactNode[] {
  if (!text) return [];
  const end = start + text.length;
  const cuts = new Set([start, end]);
  for (const mark of context.marks) {
    if (mark.start > start && mark.start < end) cuts.add(mark.start);
    if (mark.end > start && mark.end < end) cuts.add(mark.end);
  }
  const points = [...cuts].sort((left, right) => left - right);
  return points.slice(0, -1).map((from, index) => {
    const to = points[index + 1] ?? end;
    const covering = context.marks.filter((mark) => mark.start <= from && mark.end >= to);
    const threadId = covering.find((mark) => mark.threadId !== undefined)?.threadId;
    return (
      <span key={`${key}-${from}`} data-source-start={from} data-source-end={to} className={covering.map((mark) => mark.className).join(' ') || undefined} {...(threadId ? { 'data-thread-id': threadId } : {})}>
        {text.slice(from - start, to - start)}
      </span>
    );
  });
}

/** Inline Markdown without any HTML injection; links only accept explicit safe schemes. */
export function renderInline(value: string, start: number, key: string, context: InlineContext): ReactNode[] {
  const nodes: ReactNode[] = [];
  let consumed = 0;
  let index = 0;
  while (consumed < value.length) {
    const rest = value.slice(consumed);
    const match = TOKEN.exec(rest);
    if (!match) { nodes.push(...sourceText(rest, start + consumed, `${key}-t${index}`, context)); break; }
    if (match.index > 0) nodes.push(...sourceText(rest.slice(0, match.index), start + consumed, `${key}-t${index}`, context));
    const token = match[0];
    const at = start + consumed + match.index;
    const tokenKey = `${key}-k${index}`;
    nodes.push(renderToken(token, at, tokenKey, context));
    consumed += match.index + token.length;
    index += 1;
  }
  return nodes;
}

function renderToken(token: string, at: number, key: string, context: InlineContext): ReactNode {
  const inner = (from: number, to: number): ReactNode[] => renderInline(token.slice(from, token.length - to), at + from, key, context);
  if (token.startsWith('\\')) return <span key={key}>{sourceText(token.slice(1), at + 1, key, context)}</span>;
  if (token.startsWith('`')) return <code key={key}>{sourceText(token.slice(1, -1), at + 1, key, context)}</code>;
  if (token.startsWith('$')) return <span key={key} className="md-math-inline">{sourceText(token, at, key, context)}</span>;
  if (token.startsWith('<http')) {
    const href = token.slice(1, -1);
    return <a key={key} href={href} target="_blank" rel="noreferrer">{sourceText(href, at + 1, key, context)}</a>;
  }
  if (token.startsWith('![')) {
    // Images are not fetched; the alt text keeps a local document from loading remote content.
    const altEnd = token.indexOf('](');
    return <span key={key} className="md-image-alt">{sourceText(`[${token.slice(2, altEnd)}]`, at + 1, key, context)}</span>;
  }
  if (token.startsWith('[^')) {
    const number = context.footnoteNumbers.get(normalizeReferenceKey(token.slice(2, -1)));
    return number === undefined
      ? <span key={key}>{sourceText(token, at, key, context)}</span>
      : <sup key={key} className="md-footnote-ref">{sourceText(`[${number}]`, at, key, context)}</sup>;
  }
  if (token.startsWith('[')) {
    const inline = /^\[([^\]]+)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)$/u.exec(token);
    const reference = /^\[([^\]]+)\](?:\[([^\]]*)\])?$/u.exec(token);
    const label = inline?.[1] ?? reference?.[1] ?? '';
    const href = inline?.[2] ?? context.references.get(normalizeReferenceKey(reference?.[2] || label))?.href;
    const content = renderInline(label, at + 1, key, context);
    if (href !== undefined && isSafeHref(href)) return <a key={key} href={href} target="_blank" rel="noreferrer">{content}</a>;
    return <span key={key}>{inline || reference?.[2] !== undefined ? content : sourceText(token, at, key, context)}</span>;
  }
  if (token.startsWith('**') || token.startsWith('__')) return <strong key={key}>{inner(2, 2)}</strong>;
  if (token.startsWith('~~')) return <del key={key}>{inner(2, 2)}</del>;
  return <em key={key}>{inner(1, 1)}</em>;
}

/** Lines of one block, rendered with a line break between them as in the source. */
export function renderLines(lines: SourceLine[], key: string, context: InlineContext): ReactNode[] {
  return lines.flatMap((line, index) => [
    ...(index > 0 ? [<br key={`${key}-br${index}`} />] : []),
    ...renderInline(line.text, line.start, `${key}-l${index}`, context),
  ]);
}
