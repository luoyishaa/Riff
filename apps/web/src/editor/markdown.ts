/**
 * A small Markdown parser for the preview. It never produces HTML: blocks keep
 * the source offset of every line, so a selection in the preview maps back to
 * the exact characters of the source text (comments anchor to the source).
 */
export interface SourceLine { text: string; start: number }
export type TableAlignment = 'left' | 'center' | 'right';
export interface ListItem { lines: SourceLine[]; task?: boolean; done?: boolean; children: ListBlock[] }
export interface ListBlock { type: 'list'; ordered: boolean; startNumber: number; items: ListItem[] }
export interface Footnote { id: string; lines: SourceLine[] }
export interface Reference { href: string; title?: string }

export type Block =
  | { type: 'heading'; level: number; line: SourceLine }
  | { type: 'paragraph'; lines: SourceLine[] }
  | { type: 'quote'; lines: SourceLine[] }
  | ListBlock
  | { type: 'table'; header: SourceLine[]; alignments: TableAlignment[]; rows: SourceLine[][] }
  | { type: 'code'; language: string; lines: SourceLine[] }
  | { type: 'math'; lines: SourceLine[] }
  | { type: 'html'; lines: SourceLine[] }
  | { type: 'rule' };

export interface MarkdownDocument { blocks: Block[]; references: ReadonlyMap<string, Reference>; footnotes: Footnote[] }

export function normalizeReferenceKey(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

/** Lines without their terminator; CRLF and CR count as one break, offsets stay exact. */
export function splitLines(value: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '\n' && character !== '\r') continue;
    lines.push({ text: value.slice(start, index), start });
    if (character === '\r' && value[index + 1] === '\n') index += 1;
    start = index + 1;
  }
  lines.push({ text: value.slice(start), start });
  return lines;
}

/** A line with leading/trailing whitespace removed, its start moved accordingly. */
function trimmed(line: SourceLine): SourceLine {
  const lead = line.text.length - line.text.trimStart().length;
  return { text: line.text.trim(), start: line.start + lead };
}

function sliceLine(line: SourceLine, from: number, to = line.text.length): SourceLine {
  return { text: line.text.slice(from, to), start: line.start + from };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`]*)$/u;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+|$)/u;
const RULE = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u;
const QUOTE = /^ {0,3}> ?/u;
const LIST = /^(\s*)(?:(\d+)[.)]|[-+*])\s+/u;
const BLOCK_START = /^ {0,3}(?:`{3}|~{3}|#{1,6}\s|>|[-+*]\s+|\d+[.)]\s+|\$\$)/u;

function tableCells(line: SourceLine): SourceLine[] {
  const cells: SourceLine[] = [];
  let from = 0;
  let escaped = false;
  for (let index = 0; index <= line.text.length; index += 1) {
    const character = line.text[index];
    if (index === line.text.length || (character === '|' && !escaped)) {
      cells.push(trimmed(sliceLine(line, from, index)));
      from = index + 1;
    }
    escaped = character === '\\' && !escaped;
  }
  if (line.text.trimStart().startsWith('|')) cells.shift();
  if (line.text.trimEnd().endsWith('|')) cells.pop();
  return cells;
}

function alignment(cell: SourceLine): TableAlignment | undefined {
  if (!/^:?-+:?$/u.test(cell.text)) return undefined;
  if (cell.text.startsWith(':') && cell.text.endsWith(':')) return 'center';
  return cell.text.endsWith(':') && !cell.text.startsWith(':') ? 'right' : 'left';
}

function collectDefinitions(lines: SourceLine[]): { references: Map<string, Reference>; footnotes: Footnote[]; skip: Set<number> } {
  const references = new Map<string, Reference>();
  const footnotes: Footnote[] = [];
  const skip = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const footnote = /^ {0,3}\[\^([^\]]+)\]:\s*/u.exec(line.text);
    if (footnote) {
      const body = [sliceLine(line, footnote[0].length)];
      skip.add(index);
      while (index + 1 < lines.length && /^ {2,}\S/u.test(lines[index + 1]?.text ?? '')) {
        index += 1;
        body.push(trimmed(lines[index] as SourceLine));
        skip.add(index);
      }
      footnotes.push({ id: normalizeReferenceKey(footnote[1] ?? ''), lines: body });
      continue;
    }
    const reference = /^ {0,3}\[([^\]^]+)\]:\s*(\S+)(?:\s+(?:["']([^"']*)["']|\(([^)]*)\)))?\s*$/u.exec(line.text);
    if (reference) {
      const title = reference[3] ?? reference[4];
      references.set(normalizeReferenceKey(reference[1] ?? ''), { href: reference[2] ?? '', ...(title ? { title } : {}) });
      skip.add(index);
    }
  }
  return { references, footnotes, skip };
}

function parseList(lines: SourceLine[], from: number, indent: number, ordered: boolean): { block: ListBlock; next: number } {
  const items: ListItem[] = [];
  let startNumber = 1;
  let index = from;
  while (index < lines.length) {
    const line = lines[index] as SourceLine;
    const marker = LIST.exec(line.text);
    const markerIndent = marker?.[1]?.replace(/\t/gu, '    ').length ?? -1;
    if (!marker || markerIndent !== indent || (marker[2] !== undefined) !== ordered) break;
    if (items.length === 0 && marker[2] !== undefined) startNumber = Number(marker[2]);
    let first = sliceLine(line, marker[0].length);
    const task = /^\[([ xX])\]\s+/u.exec(first.text);
    if (task) first = sliceLine(first, task[0].length);
    const item: ListItem = { lines: [first], children: [], ...(task ? { task: true, done: task[1]?.toLowerCase() === 'x' } : {}) };
    index += 1;
    while (index < lines.length) {
      const next = lines[index] as SourceLine;
      if (!next.text.trim()) break;
      const nested = LIST.exec(next.text);
      if (nested) {
        const nestedIndent = nested[1]?.replace(/\t/gu, '    ').length ?? 0;
        if (nestedIndent <= indent) break;
        const parsed = parseList(lines, index, nestedIndent, nested[2] !== undefined);
        item.children.push(parsed.block);
        index = parsed.next;
        continue;
      }
      if (next.text.search(/\S/u) <= indent) break;
      item.lines.push(trimmed(next));
      index += 1;
    }
    items.push(item);
  }
  return { block: { type: 'list', ordered, startNumber, items }, next: index };
}

export function parseMarkdown(value: string): MarkdownDocument {
  const lines = splitLines(value);
  const { references, footnotes, skip } = collectDefinitions(lines);
  const blocks: Block[] = [];
  let index = 0;
  const lineAt = (at: number): SourceLine | undefined => lines[at];
  while (index < lines.length) {
    const line = lineAt(index) as SourceLine;
    if (skip.has(index) || !line.text.trim()) { index += 1; continue; }
    const fence = FENCE.exec(line.text);
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1]?.[0] === '`' ? '`' : '~'}{${fence[1]?.length ?? 3},}\\s*$`, 'u');
      const body: SourceLine[] = [];
      index += 1;
      while (index < lines.length && !close.test(lineAt(index)?.text ?? '')) body.push(lineAt(index++) as SourceLine);
      index += 1;
      blocks.push({ type: 'code', language: fence[2]?.trim() ?? '', lines: body });
      continue;
    }
    if (/^ {0,3}\$\$/u.test(line.text)) {
      const body: SourceLine[] = [line];
      const closedOnSameLine = /\$\$.*\$\$\s*$/u.test(line.text.trim());
      index += 1;
      if (!closedOnSameLine) {
        while (index < lines.length && !/^ {0,3}\$\$\s*$/u.test(lineAt(index)?.text ?? '')) body.push(lineAt(index++) as SourceLine);
        if (index < lines.length) body.push(lineAt(index++) as SourceLine);
      }
      blocks.push({ type: 'math', lines: body });
      continue;
    }
    if (/^ {0,3}(?:<!--|<\/?[A-Za-z][^>]*>)/u.test(line.text) && !/^ {0,3}<https?:/u.test(line.text)) {
      const body: SourceLine[] = [];
      while (index < lines.length && lineAt(index)?.text.trim()) body.push(lineAt(index++) as SourceLine);
      blocks.push({ type: 'html', lines: body });
      continue;
    }
    const setext = /^ {0,3}(=+|-+)\s*$/u.exec(lineAt(index + 1)?.text ?? '');
    if (setext && !QUOTE.test(line.text) && !LIST.test(line.text)) {
      blocks.push({ type: 'heading', level: setext[1]?.startsWith('=') ? 1 : 2, line: trimmed(line) });
      index += 2;
      continue;
    }
    const heading = HEADING.exec(line.text);
    if (heading) {
      const content = sliceLine(line, heading[0].length);
      const closing = /\s+#+\s*$/u.exec(content.text);
      blocks.push({ type: 'heading', level: heading[1]?.length ?? 1, line: trimmed(closing ? sliceLine(content, 0, closing.index) : content) });
      index += 1;
      continue;
    }
    if (RULE.test(line.text)) { blocks.push({ type: 'rule' }); index += 1; continue; }
    const divider = lineAt(index + 1);
    const header = tableCells(line);
    const alignments = divider ? tableCells(divider).map(alignment) : [];
    if (line.text.includes('|') && divider?.text.includes('|') && header.length > 0 && alignments.length === header.length && alignments.every((item) => item !== undefined)) {
      const rows: SourceLine[][] = [];
      index += 2;
      while (index < lines.length && lineAt(index)?.text.includes('|') && lineAt(index)?.text.trim()) {
        const cells = tableCells(lineAt(index++) as SourceLine).slice(0, header.length);
        rows.push(cells);
      }
      blocks.push({ type: 'table', header, alignments: alignments as TableAlignment[], rows });
      continue;
    }
    if (QUOTE.test(line.text)) {
      const body: SourceLine[] = [];
      while (index < lines.length && QUOTE.test(lineAt(index)?.text ?? '')) {
        const quoted = lineAt(index++) as SourceLine;
        body.push(sliceLine(quoted, QUOTE.exec(quoted.text)?.[0].length ?? 0));
      }
      blocks.push({ type: 'quote', lines: body });
      continue;
    }
    const list = LIST.exec(line.text);
    const listIndent = list?.[1]?.replace(/\t/gu, '    ').length ?? 0;
    if (list && listIndent <= 3) {
      const parsed = parseList(lines, index, listIndent, list[2] !== undefined);
      blocks.push(parsed.block);
      index = parsed.next;
      continue;
    }
    const body: SourceLine[] = [trimmed(line)];
    index += 1;
    while (index < lines.length) {
      const next = lineAt(index) as SourceLine;
      if (skip.has(index) || !next.text.trim() || BLOCK_START.test(next.text) || RULE.test(next.text)) break;
      body.push(trimmed(next));
      index += 1;
    }
    blocks.push({ type: 'paragraph', lines: body });
  }
  return { blocks, references, footnotes };
}
