type MarkdownStructureKind = 'heading' | 'setext' | 'list' | 'fence' | 'quote' | 'table' | 'thematic-break' | 'indented-code';

interface MarkdownStructureLine {
  kind: MarkdownStructureKind;
  signature: string;
}

function unescapedPipeCount(line: string): number {
  let count = 0;
  let escaped = false;
  for (const character of line) {
    if (character === '|' && !escaped) count += 1;
    escaped = character === '\\' && !escaped;
    if (character !== '\\') escaped = false;
  }
  return count;
}

function isTableDelimiter(line: string): boolean {
  const cells = line.split('|').map((cell) => cell.trim()).filter((cell, index, values) => !(index === 0 && cell === '') && !(index === values.length - 1 && cell === ''));
  return cells.length >= 2 && cells.every((cell) => /^:?-{1,}:?$/u.test(cell));
}

function markdownStructureLines(text: string): MarkdownStructureLine[] {
  const lines = text.split('\n');
  return lines.flatMap((line, index): MarkdownStructureLine[] => {
    const trimmed = line.trim();
    const leadingWhitespace = line.match(/^\s*/u)?.[0] ?? '';
    const heading = /^( {0,3})(#{1,6})(?:\s+|$)/u.exec(line);
    if (heading) return [{ kind: 'heading', signature: `${heading[1]?.length ?? 0}:${heading[2]?.length ?? 0}` }];
    if (/^ {0,3}(?:=+|-+)\s*$/u.test(line) && index > 0 && (lines[index - 1] ?? '').trim() !== '') {
      return [{ kind: 'setext', signature: line.trimStart()[0] ?? '' }];
    }
    const list = /^( {0,3})([-+*]|\d+[.)])\s+/u.exec(line);
    if (list) return [{ kind: 'list', signature: `${list[1]?.length ?? 0}:${/^\d/u.test(list[2] ?? '') ? 'ordered' : list[2]}` }];
    const fence = /^( {0,3})(`{3,}|~{3,})/u.exec(line);
    if (fence) return [{ kind: 'fence', signature: `${fence[1]?.length ?? 0}:${fence[2]?.[0] ?? ''}:${fence[2]?.length ?? 0}` }];
    const quote = /^( {0,3})>/u.exec(line);
    if (quote) return [{ kind: 'quote', signature: `${quote[1]?.length ?? 0}` }];
    const thematicBreak = /^( {0,3})(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u.exec(line);
    if (thematicBreak) return [{ kind: 'thematic-break', signature: `${thematicBreak[1]?.length ?? 0}:${trimmed[0] ?? ''}` }];
    if (leadingWhitespace.length >= 4 || line.startsWith('\t')) return [{ kind: 'indented-code', signature: line.startsWith('\t') ? 'tab' : 'spaces' }];
    const pipes = unescapedPipeCount(line);
    const neighboringTableDelimiter = isTableDelimiter(lines[index - 1] ?? '') || isTableDelimiter(lines[index + 1] ?? '');
    if (pipes > 0 && (neighboringTableDelimiter || line.trimStart().startsWith('|') || line.trimEnd().endsWith('|') || pipes >= 2)) {
      return [{ kind: 'table', signature: `${pipes}:${line.trimStart().startsWith('|') ? 'left' : ''}:${line.trimEnd().endsWith('|') ? 'right' : ''}` }];
    }
    return [];
  });
}

/** Protect Markdown block syntax while allowing content edits inside a block. */
export function preservesMarkdownStructure(quote: string, newText: string): boolean {
  const expected = markdownStructureLines(quote);
  if (expected.length === 0) return true;
  const actual = markdownStructureLines(newText);
  let actualIndex = 0;
  for (const expectedLine of expected) {
    const match = actual.slice(actualIndex).findIndex((line) => line.kind === expectedLine.kind && line.signature === expectedLine.signature);
    if (match < 0) return false;
    actualIndex += match + 1;
  }
  return true;
}
