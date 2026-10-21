import { describe, expect, it } from 'vitest';
import { locateSelection } from '../src/routes/review-routes.js';

describe('comment selection', () => {
  const text = 'Intro. Hello world. Second sentence.';

  it('keeps offsets that still point at the quoted text', () => {
    expect(locateSelection(text, { start: 13, end: 18, quote: 'world' })).toEqual({ start: 13, end: 18 });
  });

  it('finds a quote again after edits shifted the offsets', () => {
    expect(locateSelection(text, { start: 6, end: 11, quote: 'world' })).toEqual({ start: 13, end: 18 });
  });

  it('reports a changed selection when the quote is gone or ambiguous', () => {
    expect(locateSelection(text, { start: 6, end: 11, quote: 'earth' })).toBeUndefined();
    expect(locateSelection('ab ab', { start: 1, end: 3, quote: 'ab' })).toBeUndefined();
  });
});
