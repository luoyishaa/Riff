import { describe, expect, it } from 'vitest';
import { buildOutline } from '../src/outline.js';

describe('buildOutline', () => {
  it('uses Markdown heading levels for Markdown documents', () => {
    const text = '# Overview\n\nIntro\n\n## Details\n### Nested\n';
    expect(buildOutline(text, 'guide.md')).toEqual([
      { index: 0, title: 'Overview', level: 1, start: 0, end: 10 },
      { index: 1, title: 'Details', level: 2, start: 19, end: 29 },
      { index: 2, title: 'Nested', level: 3, start: 30, end: 40 },
    ]);
  });

  it('keeps plain text outlines paragraph based', () => {
    const text = 'First paragraph\ncontinues.\n\nSecond paragraph';
    expect(buildOutline(text, 'notes.txt')).toEqual([
      { index: 0, title: 'First paragraph', start: 0, end: 26 },
      { index: 1, title: 'Second paragraph', start: 28, end: 44 },
    ]);
  });
});
