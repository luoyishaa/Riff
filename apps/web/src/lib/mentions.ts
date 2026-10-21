export interface MentionCandidate { id: string; displayName: string; kind: 'human' | 'agent'; handle?: string }

/** The `@query` being typed before the caret, if any. Mentions start a word, so `a@b` is not one. */
export function findMentionQuery(value: string, caret: number): { start: number; query: string } | undefined {
  const match = /(?:^|[^\p{L}\p{N}_])@([^\s@]*)$/u.exec(value.slice(0, caret));
  if (!match) return undefined;
  const query = match[1] ?? '';
  return { start: caret - query.length - 1, query };
}

/** Prefix matches first, then substring matches; agents before people when equally good. */
export function rankMentionCandidates(candidates: MentionCandidate[], query: string, limit = 6): MentionCandidate[] {
  const needle = query.toLocaleLowerCase();
  const score = (candidate: MentionCandidate): number => {
    const names = [candidate.displayName, candidate.handle ?? ''].map((name) => name.toLocaleLowerCase());
    if (!needle) return 1;
    if (names.some((name) => name.startsWith(needle))) return 2;
    return names.some((name) => name.includes(needle)) ? 1 : 0;
  };
  return candidates
    .map((candidate) => ({ candidate, score: score(candidate) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || Number(right.candidate.kind === 'agent') - Number(left.candidate.kind === 'agent') || left.candidate.displayName.localeCompare(right.candidate.displayName, 'zh-CN'))
    .slice(0, limit)
    .map((item) => item.candidate);
}

/** Replace the typed `@query` with the full mention the server resolves by display name. */
export function insertMention(value: string, start: number, caret: number, displayName: string): { value: string; caret: number } {
  const inserted = `@${displayName} `;
  return { value: `${value.slice(0, start)}${inserted}${value.slice(caret)}`, caret: start + inserted.length };
}
