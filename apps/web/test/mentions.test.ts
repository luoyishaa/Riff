import { describe, expect, it } from 'vitest';
import { findMentionQuery, insertMention, rankMentionCandidates } from '../src/lib/mentions.js';

describe('mention input', () => {
  it('finds the @query before the caret only at the start of a word', () => {
    expect(findMentionQuery('请 @Pol', 6)).toEqual({ start: 2, query: 'Pol' });
    expect(findMentionQuery('mail a@b', 8)).toBeUndefined();
    expect(findMentionQuery('@ 空格', 6)).toBeUndefined();
  });

  it('ranks prefix matches first and agents before people when equally good', () => {
    const ranked = rankMentionCandidates([
      { id: 'a', displayName: 'Apolline', kind: 'human' },
      { id: 'p', displayName: 'Polisher', kind: 'agent' },
      { id: 'q', displayName: 'Pola', kind: 'human' },
    ], 'pol');
    expect(ranked.map((candidate) => candidate.id)).toEqual(['p', 'q', 'a']);
  });

  it('replaces the typed query with the display name the server resolves', () => {
    expect(insertMention('请 @Pol 看看', 2, 6, 'Polisher')).toEqual({ value: '请 @Polisher  看看', caret: 12 });
  });
});
