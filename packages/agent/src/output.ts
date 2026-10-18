import { err, type Result } from '@collab/kernel';
import { preservesMarkdownStructure } from '@collab/review';
import { z } from 'zod';
import type { AgentEdit } from './types.js';

const editSchema = z.object({
  op: z.enum(['replace', 'delete', 'insert']),
  quote: z.string(),
  newText: z.string().optional().default(''),
  contextBefore: z.string().optional(),
  contextAfter: z.string().optional(),
  rationale: z.string().optional(),
}).strict();
const outputSchema = z.object({ reply: z.string(), edits: z.array(editSchema).default([]), relatedEdits: z.array(editSchema).default([]) }).strict();

export interface AgentOutput {
  reply: string;
  edits: AgentEdit[];
  relatedEdits: AgentEdit[];
}

export type OutputError = 'no-json-object' | 'invalid-json' | 'invalid-output';

function firstJsonObject(text: string): string | undefined {
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start < 0) {
      if (char === '{') { start = index; depth = 1; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

export function parseAgentOutput(raw: string): Result<AgentOutput, OutputError> {
  const source = firstJsonObject(raw);
  if (source === undefined) return err('no-json-object');
  let value: unknown;
  try { value = JSON.parse(source) as unknown; } catch { return err('invalid-json'); }
  const parsed = outputSchema.safeParse(value);
  if (!parsed.success) return err('invalid-output');
  const edits: AgentEdit[] = parsed.data.edits.map((edit) => ({
    op: edit.op,
    quote: edit.quote,
    newText: edit.newText,
    ...(edit.contextBefore === undefined ? {} : { contextBefore: edit.contextBefore }),
    ...(edit.contextAfter === undefined ? {} : { contextAfter: edit.contextAfter }),
    ...(edit.rationale === undefined ? {} : { rationale: edit.rationale }),
  }));
  const relatedEdits: AgentEdit[] = parsed.data.relatedEdits.map((edit) => ({
    op: edit.op,
    quote: edit.quote,
    newText: edit.newText,
    ...(edit.contextBefore === undefined ? {} : { contextBefore: edit.contextBefore }),
    ...(edit.contextAfter === undefined ? {} : { contextAfter: edit.contextAfter }),
    ...(edit.rationale === undefined ? {} : { rationale: edit.rationale }),
  }));
  return { ok: true, value: { reply: parsed.data.reply, edits, relatedEdits } };
}

export interface LocatedEdit extends AgentEdit {
  start: number;
  end: number;
  scope: 'allowed' | 'document';
}

export interface ValidatedEdits {
  edits: LocatedEdit[];
  rejected: Array<{ index: number; reason: 'not-found' | 'ambiguous' | 'overlap' | 'structure' }>;
  truncated: number;
}

function occurrences(text: string, quote: string): number[] {
  if (!quote) return [];
  const result: number[] = [];
  let from = 0;
  while (from <= text.length) {
    const index = text.indexOf(quote, from);
    if (index < 0) return result;
    result.push(index);
    from = index + 1;
  }
  return result;
}

function validateEditList(source: AgentEdit[], allowedText: string, maxEdits: number, scope: LocatedEdit['scope']): ValidatedEdits {
  const edits: LocatedEdit[] = [];
  const rejected: ValidatedEdits['rejected'] = [];
  const limit = Math.max(0, maxEdits);
  for (const [index, edit] of source.entries()) {
    if (index >= limit) continue;
    const candidates = occurrences(allowedText, edit.quote).filter((start) => {
      const before = edit.contextBefore === undefined || allowedText.slice(Math.max(0, start - edit.contextBefore.length), start) === edit.contextBefore;
      const afterStart = start + edit.quote.length;
      const after = edit.contextAfter === undefined || allowedText.slice(afterStart, afterStart + edit.contextAfter.length) === edit.contextAfter;
      return before && after;
    });
    if (candidates.length === 0) { rejected.push({ index, reason: 'not-found' }); continue; }
    if (candidates.length !== 1) { rejected.push({ index, reason: 'ambiguous' }); continue; }
    if ((edit.op === 'replace' || edit.op === 'delete') && !preservesMarkdownStructure(edit.quote, edit.op === 'delete' ? '' : edit.newText)) {
      rejected.push({ index, reason: 'structure' });
      continue;
    }
    const start = candidates[0] as number;
    const end = start + edit.quote.length;
    const overlaps = edits.some((existing) => start < existing.end && existing.start < end);
    if (overlaps) { rejected.push({ index, reason: 'overlap' }); continue; }
    edits.push({ ...edit, start, end, scope });
  }
  return { edits, rejected, truncated: Math.max(0, source.length - limit) };
}

export function validateEdits(output: AgentOutput, allowedText: string, maxEdits = 50): ValidatedEdits {
  return validateEditList(output.edits, allowedText, maxEdits, 'allowed');
}

export function validateRelatedEdits(output: AgentOutput, documentText: string, maxEdits = 50): ValidatedEdits {
  return validateEditList(output.relatedEdits, documentText, maxEdits, 'document');
}
