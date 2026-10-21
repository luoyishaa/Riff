import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { parseMarkdown } from '../src/editor/markdown.js';
import { sourceText } from '../src/editor/previewInline.js';

type SpanProps = { 'data-source-start': number; 'data-source-end': number; className?: string; children: string };
const spans = (nodes: unknown[]): SpanProps[] => nodes.map((node) => (node as ReactElement<SpanProps>).props);
const context = (marks: Array<{ start: number; end: number; className: string }>) => ({ references: new Map(), footnoteNumbers: new Map(), marks });

describe('markdown preview source mapping', () => {
  it('keeps a comment mark inside its own paragraph and splits runs only at mark boundaries', () => {
    const rendered = spans(sourceText('第一段内容。', 0, 'p', context([{ start: 2, end: 4, className: 'md-thread' }, { start: 8, end: 12, className: 'md-thread' }])));
    expect(rendered.map((span) => [span['data-source-start'], span['data-source-end'], span.className ?? ''])).toEqual([[0, 2, ''], [2, 4, 'md-thread'], [4, 6, '']]);
    expect(rendered.map((span) => span.children).join('')).toBe('第一段内容。');
  });

  it('parses nested lists without merging child text into the parent item', () => {
    const [list] = parseMarkdown('- parent\n  - child\n    1. grandchild\n- sibling').blocks;
    expect(list?.type).toBe('list');
    if (list?.type !== 'list') return;
    expect(list.items).toHaveLength(2);
    expect(list.items[0]?.lines.map((line) => line.text)).toEqual(['parent']);
    expect(list.items[0]?.children[0]?.items[0]?.lines[0]?.text).toBe('child');
    expect(list.items[0]?.children[0]?.items[0]?.children[0]?.ordered).toBe(true);
  });

  it('supports reference links and footnotes and keeps exact offsets across CRLF and indented lines', () => {
    const value = 'See [guide][docs] and note[^one].\r\n  second line\r\n\r\n[docs]: https://example.com "Guide"\r\n[^one]: A source note.';
    const parsed = parseMarkdown(value);
    expect(parsed.references.get('docs')?.href).toBe('https://example.com');
    expect(parsed.footnotes[0]?.id).toBe('one');
    const [paragraph] = parsed.blocks;
    expect(paragraph?.type).toBe('paragraph');
    if (paragraph?.type !== 'paragraph') return;
    for (const line of paragraph.lines) expect(value.slice(line.start, line.start + line.text.length)).toBe(line.text);
    expect(paragraph.lines[1]?.text).toBe('second line');
  });
});
