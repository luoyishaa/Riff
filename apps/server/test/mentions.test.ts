import { describe, expect, it } from 'vitest';
import { resolveMentions } from '../src/mentions.js';

describe('resolveMentions', () => {
  it('matches unique members with Unicode boundaries and longest names', () => {
    const members = [
      { id: 'alice', kind: 'human' as const, displayName: 'Alice' },
      { id: 'alice-bot', kind: 'agent' as const, displayName: 'Alice Bot' },
      { id: 'bob', kind: 'human' as const, displayName: 'Bob' },
    ];
    expect(resolveMentions('@Alice Bot and @Bob', members)).toEqual(['alice-bot', 'bob']);
    expect(resolveMentions('@Bobby', members)).toEqual([]);
  });
  it('does not resolve ambiguous display names', () => {
    const members = [
      { id: 'one', kind: 'human' as const, displayName: 'Sam' },
      { id: 'two', kind: 'agent' as const, displayName: 'Sam' },
    ];
    expect(resolveMentions('@Sam', members)).toEqual([]);
  });
});
