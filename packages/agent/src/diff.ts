/**
 * Word-level diff used to tell an agent what humans changed since its last
 * run (SPEC §7.6). Latin words are kept whole, every Han character is its own
 * token, so the granularity matches how both languages are edited.
 */
export interface TextChange {
  removed: string;
  added: string;
  /** Unchanged text immediately before the change, for orientation. */
  before: string;
  /** Unchanged text immediately after the change. */
  after: string;
}

const TOKEN_PATTERN = /\p{Script=Han}|(?:(?!\p{Script=Han})[\p{L}\p{N}_])+|\s+|[\s\S]/gu;
const CONTEXT_CHARS = 16;
/** Above this edit distance the middle region is reported as one replacement. */
const MAX_EDIT_DISTANCE = 800;

type Op = { kind: 'equal' | 'delete' | 'insert'; token: string };

function tokenize(text: string): string[] {
  return text.match(TOKEN_PATTERN) ?? [];
}

/** Myers O(ND) shortest edit script; undefined when the distance exceeds the bound. */
function editScript(a: string[], b: string[], maxDistance: number): Op[] | undefined {
  const offset = maxDistance + 1;
  const v = new Int32Array(2 * offset + 1);
  const at = (k: number): number => v[offset + k] ?? 0;
  // trace[d] is the frontier as it was before step d; backtracking needs it.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= maxDistance; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
      let x = down ? at(k + 1) : at(k - 1) + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= a.length && y >= b.length) return backtrack(trace, a, b, offset);
    }
  }
  return undefined;
}

function backtrack(trace: Int32Array[], a: string[], b: string[], offset: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const frontier = trace[d];
    const at = (k: number): number => frontier?.[offset + k] ?? 0;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) { x -= 1; y -= 1; ops.push({ kind: 'equal', token: a[x] ?? '' }); }
    if (d === 0) break;
    if (down) { y -= 1; ops.push({ kind: 'insert', token: b[y] ?? '' }); } else { x -= 1; ops.push({ kind: 'delete', token: a[x] ?? '' }); }
  }
  return ops.reverse();
}

function commonPrefix(a: string[], b: string[]): number {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return index;
}

function commonSuffix(a: string[], b: string[], prefix: number): number {
  let index = 0;
  while (index < a.length - prefix && index < b.length - prefix && a[a.length - 1 - index] === b[b.length - 1 - index]) index += 1;
  return index;
}

/** Context is taken only from the unchanged run next to a change, never from another change. */
function groupChanges(ops: Op[]): TextChange[] {
  const changes: TextChange[] = [];
  let equalRun = '';
  let index = 0;
  while (index < ops.length) {
    const op = ops[index];
    if (op?.kind === 'equal') {
      equalRun = `${equalRun}${op.token}`.slice(-CONTEXT_CHARS);
      index += 1;
      continue;
    }
    let removed = '';
    let added = '';
    while (index < ops.length && ops[index]?.kind !== 'equal') {
      const change = ops[index];
      if (change?.kind === 'delete') removed += change.token;
      if (change?.kind === 'insert') added += change.token;
      index += 1;
    }
    let after = '';
    for (let next = index; next < ops.length && ops[next]?.kind === 'equal' && after.length < CONTEXT_CHARS; next += 1) after += ops[next]?.token ?? '';
    changes.push({ removed, added, before: equalRun.slice(-CONTEXT_CHARS), after: after.slice(0, CONTEXT_CHARS) });
    equalRun = '';
  }
  return changes;
}

export function wordDiff(previous: string, current: string): TextChange[] {
  if (previous === current) return [];
  const a = tokenize(previous);
  const b = tokenize(current);
  const prefix = commonPrefix(a, b);
  const suffix = commonSuffix(a, b, prefix);
  const middleA = a.slice(prefix, a.length - suffix);
  const middleB = b.slice(prefix, b.length - suffix);
  const script = editScript(middleA, middleB, MAX_EDIT_DISTANCE)
    ?? [...middleA.map((token): Op => ({ kind: 'delete', token })), ...middleB.map((token): Op => ({ kind: 'insert', token }))];
  // Only the context next to the changed middle is ever rendered.
  const head = a.slice(Math.max(0, prefix - CONTEXT_CHARS), prefix).map((token): Op => ({ kind: 'equal', token }));
  const tail = a.slice(a.length - suffix, a.length - suffix + CONTEXT_CHARS).map((token): Op => ({ kind: 'equal', token }));
  return groupChanges([...head, ...script, ...tail]);
}

function describeChange(change: TextChange, index: number): string {
  const lead = change.before ? `…${change.before}` : '';
  const trail = change.after ? `${change.after}…` : '';
  if (!change.removed) return `${index}. 在「${lead}」之后插入「${change.added}」`;
  if (!change.added) return `${index}. 删除「${change.removed}」（位于「${lead}${trail}」之间）`;
  return `${index}. 「${lead}${change.removed}${trail}」改为「${lead}${change.added}${trail}」`;
}

/** Render the diff for the prompt, bounded to `limit` characters with an explicit note. */
export function describeHumanEdits(previous: string, current: string, limit = 2000): string {
  const changes = wordDiff(previous, current);
  const lines: string[] = [];
  let used = 0;
  for (const [index, change] of changes.entries()) {
    const line = describeChange(change, index + 1);
    if (used + line.length > limit) {
      lines.push(`（另有 ${changes.length - index} 处修改因长度限制未列出）`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}
