import type { Principal } from '@collab/kernel';

function escape(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
export function resolveMentions(body: string, members: Principal[]): string[] {
  const counts = new Map<string, number>();
  for (const member of members) counts.set(member.displayName, (counts.get(member.displayName) ?? 0) + 1);
  const candidates = members.filter((member) => counts.get(member.displayName) === 1).sort((a, b) => b.displayName.length - a.displayName.length);
  const matches: Array<{ id: string; start: number; end: number }> = [];
  for (const member of candidates) {
    const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}_])@${escape(member.displayName)}(?![\\p{L}\\p{N}_])`, 'gu');
    for (const match of body.matchAll(pattern)) {
      const index = match.index ?? 0;
      const prefixLength = match[0].length - member.displayName.length - 1;
      matches.push({ id: member.id, start: index + prefixLength, end: index + match[0].length });
    }
  }
  matches.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const selected: Array<{ id: string; start: number; end: number }> = [];
  for (const match of matches) {
    if (selected.some((item) => match.start < item.end && item.start < match.end)) continue;
    selected.push(match);
  }
  return selected.sort((a, b) => a.start - b.start).map((match) => match.id);
}
