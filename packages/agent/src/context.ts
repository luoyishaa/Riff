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

export function buildContext(input: ContextInput): AgentContext {
  const selection = input.selection && input.documentText.slice(input.selection.start, input.selection.end);
  const parts: string[] = [];
  if (input.strategy === 'full' || input.selection === undefined) parts.push(`全文：\n${input.documentText}`);
  else if (input.strategy === 'selection') parts.push(`选区：\n${selection ?? ''}`);
  else {
    const all = paragraphs(input.documentText);
    const center = input.documentText.slice(0, input.selection.start).split(/\n\s*\n/).length - 1;
    const radius = input.windowParagraphs ?? 2;
    parts.push(`选区：\n${selection ?? ''}`);
    parts.push(`上下文：\n${all.slice(Math.max(0, center - radius), center + radius + 1).join('\n\n')}`);
    parts.push(`大纲：\n${all.map((paragraph) => paragraph.split('\n')[0]?.slice(0, 60) ?? '').join('\n')}`);
  }
  if (input.messages.length > 0) parts.push(`线程：\n${input.messages.map((message) => `${message.author}: ${message.body}`).join('\n')}`);
  const changes = diffNote(input.previousText, input.documentText);
  if (changes) parts.push(changes);
  let text = parts.join('\n\n');
  if (text.length > input.maxChars) text = `${text.slice(0, Math.max(0, input.maxChars - 20))}\n[上下文已截断]`;
  return { text, allowedText: selection ?? input.documentText, allowedOffset: input.selection?.start ?? 0, inputChars: text.length };
}
