import { describeHumanEdits } from './diff.js';
import { PROMPT_SECTIONS } from './prompts.js';
import type { AgentStrategy } from './types.js';

export interface ContextMessage { author: string; body: string }
export interface ContextInput {
  strategy: AgentStrategy;
  documentText: string;
  selection?: { start: number; end: number };
  messages: ContextMessage[];
  previousText?: string;
  maxChars: number;
  windowParagraphs?: number;
}

export interface AgentContext {
  text: string;
  allowedText: string;
  allowedOffset: number;
  inputChars: number;
}

type ContextPart = { text: string; priority: 'required' | 'supporting' | 'consistency' };

const PARAGRAPH_BREAK = /\n\s*\n/;
const TRUNCATION_MARKER = '\n[上下文已截断]';

function humanEditsPart(previous: string | undefined, current: string): ContextPart | undefined {
  if (previous === undefined || previous === current) return undefined;
  const changes = describeHumanEdits(previous, current);
  return changes ? { text: `${PROMPT_SECTIONS.humanEdits}\n${changes}`, priority: 'required' } : undefined;
}

/**
 * Keep the pieces that explain the current request when the context budget is
 * smaller than the document. Consistency material is useful for discovery,
 * but must not crowd out the selected text or the review thread.
 */
function fitContext(parts: ContextPart[], maxChars: number): string {
  const ordered = [
    ...parts.filter((part) => part.priority === 'required'),
    ...parts.filter((part) => part.priority === 'supporting'),
    ...parts.filter((part) => part.priority === 'consistency'),
  ].filter((part) => part.text.length > 0);
  if (ordered.length === 0) return '';
  let remaining = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  const kept: string[] = [];
  for (const part of ordered) {
    const separator = kept.length > 0 ? '\n\n' : '';
    const available = remaining - separator.length;
    if (available >= part.text.length) {
      kept.push(`${separator}${part.text}`);
      remaining -= separator.length + part.text.length;
      continue;
    }
    if (available > 0) kept.push(`${separator}${part.text.slice(0, available)}`);
    return `${kept.join('')}${TRUNCATION_MARKER}`;
  }
  return kept.join('');
}

function windowParts(documentText: string, selection: { start: number; end: number }, radius: number): ContextPart[] {
  const paragraphs = documentText.split(PARAGRAPH_BREAK);
  const center = documentText.slice(0, selection.start).split(PARAGRAPH_BREAK).length - 1;
  const nearby = paragraphs.slice(Math.max(0, center - radius), center + radius + 1).join('\n\n');
  const outline = paragraphs.map((paragraph) => paragraph.split('\n')[0]?.slice(0, 60) ?? '').join('\n');
  return [
    { text: `${PROMPT_SECTIONS.window}\n${nearby}`, priority: 'supporting' },
    { text: `${PROMPT_SECTIONS.outline}\n${outline}`, priority: 'supporting' },
  ];
}

export function buildContext(input: ContextInput): AgentContext {
  const { documentText, selection } = input;
  const selectedText = selection === undefined ? undefined : documentText.slice(selection.start, selection.end);
  const parts: ContextPart[] = [];
  // A document-scope thread has no selection, so every strategy degrades to the full text.
  if (selection === undefined || input.strategy === 'full') {
    parts.push({ text: `${PROMPT_SECTIONS.fullText}\n${documentText}`, priority: 'consistency' });
  } else {
    parts.push({ text: `${PROMPT_SECTIONS.selection}\n${selectedText ?? ''}`, priority: 'required' });
    if (input.strategy === 'window') parts.push(...windowParts(documentText, selection, input.windowParagraphs ?? 2));
    parts.push({ text: `${PROMPT_SECTIONS.consistency}\n${documentText}`, priority: 'consistency' });
  }
  if (input.messages.length > 0) {
    parts.push({ text: `${PROMPT_SECTIONS.thread}\n${input.messages.map((message) => `${message.author}: ${message.body}`).join('\n')}`, priority: 'required' });
  }
  const edits = humanEditsPart(input.previousText, documentText);
  if (edits) parts.push(edits);
  const text = fitContext(parts, input.maxChars);
  return { text, allowedText: selectedText ?? documentText, allowedOffset: selection?.start ?? 0, inputChars: text.length };
}
