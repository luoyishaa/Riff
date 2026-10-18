export interface OutlineEntry {
  index: number;
  title: string;
  start: number;
  end: number;
  level?: number;
}

function lineStarts(lines: string[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
}

function textOutline(text: string): OutlineEntry[] {
  const lines = text.split('\n');
  const starts = lineStarts(lines);
  const result: OutlineEntry[] = [];
  let lineIndex = 0;
  while (lineIndex < lines.length) {
    if (lines[lineIndex]?.trim() === '') {
      lineIndex += 1;
      continue;
    }
    const firstLine = lineIndex;
    while (lineIndex + 1 < lines.length && lines[lineIndex + 1]?.trim() !== '') lineIndex += 1;
    const lastLine = lineIndex;
    const title = lines[firstLine]?.trim().slice(0, 80) ?? '';
    if (title) {
      result.push({
        index: result.length,
        title,
        start: starts[firstLine] ?? 0,
        end: (starts[lastLine] ?? 0) + (lines[lastLine]?.length ?? 0),
      });
    }
    lineIndex += 1;
  }
  return result;
}

function markdownOutline(text: string): OutlineEntry[] {
  const lines = text.split('\n');
  const starts = lineStarts(lines);
  const result: OutlineEntry[] = [];
  for (const [lineIndex, rawLine] of lines.entries()) {
    const line = rawLine?.replace(/\r$/u, '') ?? '';
    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)[ \t]*|[ \t]*)$/u.exec(line);
    if (!heading) continue;
    const title = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/u, '').trim();
    if (!title) continue;
    result.push({
      index: result.length,
      title,
      level: heading[1]?.length ?? 1,
      start: starts[lineIndex] ?? 0,
      end: (starts[lineIndex] ?? 0) + rawLine.length,
    });
  }
  return result;
}

export function buildOutline(text: string, sourcePath?: string): OutlineEntry[] {
  return sourcePath?.toLowerCase().endsWith('.md') ? markdownOutline(text) : textOutline(text);
}
