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

function paragraphs(text: string): string[] { return text.split(/\n\s*\n/); }
function diffNote(previous: string | undefined, current: string): string {
  if (previous === undefined || previous === current) return '';
  const limit = 2000;
  const before = previous.slice(0, limit);
  const after = current.slice(0, limit);
  return `\n自上次查看以来，人类修改了文档；请不要撤销这些修改。\n${before}\n→\n${after}`;
}

type ContextPart = { text: string; priority: 'required' | 'supporting' | 'consistency' };

/**
 * Keep the pieces that explain the current request when the context budget is
 * smaller than the document. Consistency material is useful for discovery,
 * but must not crowd out the selected text or the review thread.
 */
function fitContext(parts: ContextPart[], maxChars: number): string {
  const limit = Math.max(0, maxChars);
  const marker = '\n[上下文已截断]';
  const ordered = [
    ...parts.filter((part) => part.priority === 'required'),
    ...parts.filter((part) => part.priority === 'supporting'),
    ...parts.filter((part) => part.priority === 'consistency'),
  ];
  if (ordered.length === 0 || ordered.every((part) => part.text.length === 0)) return '';
  const budget = Math.max(0, limit - marker.length);
  let remaining = budget;
  const kept: string[] = [];
  let truncated = false;
  for (const part of ordered) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const separator = kept.length > 0 ? '\n\n' : '';
    const available = Math.max(0, remaining - separator.length);
    if (available >= part.text.length) {
      kept.push(`${separator}${part.text}`);
      remaining -= separator.length + part.text.length;
      continue;
    }
    kept.push(`${separator}${part.text.slice(0, available)}`);
    truncated = true;
    break;
  }
  const text = kept.join('');
  return truncated ? `${text}${marker}` : text;
}

export function buildContext(input: ContextInput): AgentContext {
  const selection = input.selection && input.documentText.slice(input.selection.start, input.selection.end);
  const parts: ContextPart[] = [];
  if (input.strategy === 'full' || input.selection === undefined) parts.push({ text: `全文：\n${input.documentText}`, priority: 'consistency' });
  else if (input.strategy === 'selection') {
    parts.push({ text: `选区：\n${selection ?? ''}`, priority: 'required' });
    parts.push({ text: `全文一致性检查素材（只读）：\n${input.documentText}`, priority: 'consistency' });
  }
  else {
    const all = paragraphs(input.documentText);
    const center = input.documentText.slice(0, input.selection.start).split(/\n\s*\n/).length - 1;
    const radius = input.windowParagraphs ?? 2;
    parts.push({ text: `选区：\n${selection ?? ''}`, priority: 'required' });
    parts.push({ text: `上下文：\n${all.slice(Math.max(0, center - radius), center + radius + 1).join('\n\n')}`, priority: 'supporting' });
    parts.push({ text: `大纲：\n${all.map((paragraph) => paragraph.split('\n')[0]?.slice(0, 60) ?? '').join('\n')}`, priority: 'supporting' });
    parts.push({ text: `全文一致性检查素材（只读）：\n${input.documentText}`, priority: 'consistency' });
  }
  if (input.messages.length > 0) parts.push({ text: `线程：\n${input.messages.map((message) => `${message.author}: ${message.body}`).join('\n')}`, priority: 'required' });
  const changes = diffNote(input.previousText, input.documentText);
  if (changes) parts.push({ text: changes, priority: 'required' });
  const text = fitContext(parts, input.maxChars);
  return { text, allowedText: selection ?? input.documentText, allowedOffset: input.selection?.start ?? 0, inputChars: text.length };
}
