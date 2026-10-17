import type { ReactNode } from 'react';

export interface MarkdownPreviewProps {
  value: string;
  className?: string;
}

type MarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'quote'; lines: string[] }
  | { type: 'unordered-list' | 'ordered-list'; items: string[] }
  | { type: 'code'; language: string; text: string }
  | { type: 'rule' };

function isSafeHref(value: string): boolean {
  return /^(?:https?:|mailto:)/i.test(value.trim());
}

function renderInline(value: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let remaining = value;
  let key = 0;

  // This is intentionally a small renderer rather than an HTML converter. Raw
  // HTML is always rendered as text, and links only accept explicit safe schemes.
  const tokenPattern = /(`[^`]+`|!?(?:\[[^\]]+\])\([^\s)]+(?:\s+["'][^"']*["'])?\)|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/;
  while (remaining.length > 0) {
    const match = tokenPattern.exec(remaining);
    if (!match || match.index === undefined) {
      nodes.push(remaining);
      break;
    }
    if (match.index > 0) nodes.push(remaining.slice(0, match.index));
    const token = match[0];
    const tokenKey = `inline-${key}`;
    key += 1;

    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(<code key={tokenKey}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('![')) {
      // Images are deliberately not fetched in the preview. Display their alt
      // text so a local document cannot cause an unexpected network request.
      const altEnd = token.indexOf('](');
      nodes.push(<span key={tokenKey} className="markdown-image-alt">[{token.slice(2, altEnd)}]</span>);
    } else if (token.startsWith('[')) {
      const labelEnd = token.indexOf('](');
      const urlEnd = token.lastIndexOf(')');
      const label = token.slice(1, labelEnd);
      const href = token.slice(labelEnd + 2, urlEnd).trim().replace(/^(["'])(.*)\1$/, '$2');
      nodes.push(isSafeHref(href) ? <a key={tokenKey} href={href} target="_blank" rel="noreferrer">{renderInline(label)}</a> : <span key={tokenKey}>{label}</span>);
    } else if ((token.startsWith('**') && token.endsWith('**')) || (token.startsWith('__') && token.endsWith('__'))) {
      nodes.push(<strong key={tokenKey}>{renderInline(token.slice(2, -2))}</strong>);
    } else if ((token.startsWith('*') && token.endsWith('*')) || (token.startsWith('_') && token.endsWith('_'))) {
      nodes.push(<em key={tokenKey}>{renderInline(token.slice(1, -1))}</em>);
    } else {
      nodes.push(token);
    }
    remaining = remaining.slice(match.index + token.length);
  }
  return nodes;
}

function isRule(line: string): boolean {
  return /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
}

function parseBlocks(value: string): MarkdownBlock[] {
  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const fence = /^ {0,3}```\s*([^`]*)$/.exec(line);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^ {0,3}```\s*$/.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', language: fence[1]?.trim() ?? '', text: codeLines.join('\n') });
      continue;
    }

    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' });
      index += 1;
      continue;
    }
    if (isRule(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index] ?? '')) {
        quoteLines.push((lines[index] ?? '').replace(/^ {0,3}> ?/, ''));
        index += 1;
      }
      blocks.push({ type: 'quote', lines: quoteLines });
      continue;
    }

    const listMatch = /^ {0,3}([-+*])\s+(.+)$/.exec(line) ?? /^ {0,3}\d+[.)]\s+(.+)$/.exec(line);
    if (listMatch) {
      const ordered = /^ {0,3}\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const item = ordered ? /^ {0,3}\d+[.)]\s+(.+)$/.exec(current) : /^ {0,3}[-+*]\s+(.+)$/.exec(current);
        if (!item) break;
        items.push(item[1] ?? '');
        index += 1;
      }
      blocks.push({ type: ordered ? 'ordered-list' : 'unordered-list', items });
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
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
  }
  return blocks;
}

export function MarkdownPreview({ value, className }: MarkdownPreviewProps): React.ReactElement {
  const blocks = parseBlocks(value);
  return (
    <article className={`markdown-preview${className ? ` ${className}` : ''}`} aria-label="Markdown 预览">
      {blocks.length === 0 ? <p className="markdown-preview-empty">暂无内容</p> : blocks.map((block, index) => {
        const key = `block-${index}`;
        switch (block.type) {
          case 'heading': {
            const Heading = `h${block.level}` as keyof JSX.IntrinsicElements;
            return <Heading key={key}>{renderInline(block.text)}</Heading>;
          }
          case 'paragraph':
            return <p key={key}>{renderInline(block.text)}</p>;
          case 'quote':
            return <blockquote key={key}>{renderInline(block.lines.join('\n'))}</blockquote>;
          case 'unordered-list':
          case 'ordered-list': {
            const List = block.type === 'ordered-list' ? 'ol' : 'ul';
            return <List key={key}>{block.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{renderInline(item)}</li>)}</List>;
          }
          case 'code':
            return <pre key={key} data-language={block.language || undefined}><code>{block.text}</code></pre>;
          case 'rule':
            return <hr key={key} />;
          default:
            return null;
        }
      })}
    </article>
  );
}
