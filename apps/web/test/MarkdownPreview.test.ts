import { describe, expect, it } from 'vitest';
import { parseMarkdown, splitSourceSegments } from '../src/MarkdownPreview.js';

describe('markdown preview source mapping', () => {
  it('keeps adjacent paragraph markers bounded to their exact source range', () => {
    const value = '第一段内容。\n\n第二段内容。';
    const segments = splitSourceSegments(value.slice(0, 6), 0);
    const markerStart = 0;
    const markerEnd = 6;
    expect(segments.every((segment) => segment.start < markerEnd && segment.end > markerStart)).toBe(true);
    const secondStart = value.indexOf('第二');
    expect(segments.some((segment) => segment.start >= secondStart)).toBe(false);
  });

  it('parses nested lists without merging child text into the parent item', () => {
    const parsed = parseMarkdown('- parent\n  - child\n    1. grandchild\n- sibling');
    const list = parsed.blocks[0];
    expect(list?.type).toBe('unordered-list');
    if (list?.type !== 'unordered-list') return;
    expect(list.items).toHaveLength(2);
    expect(list.items[0]?.text).toBe('parent');
    expect(list.items[0]?.children[0]?.type).toBe('unordered-list');
  });

  it('supports reference links, footnotes, and preserves CRLF offsets', () => {
    const value = 'See [guide][docs] and note[^one].\r\n\r\n[docs]: https://example.com \"Guide\"\r\n[^one]: A source note.';
    const parsed = parseMarkdown(value);
    expect(parsed.references.get('docs')?.href).toBe('https://example.com');
    expect(parsed.footnotes[0]?.id).toBe('one');
    const paragraph = parsed.blocks[0];
    expect(paragraph?.type).toBe('paragraph');
    if (paragraph?.type === 'paragraph') expect(paragraph.sourceStart).toBe(0);
  });
});
