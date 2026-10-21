import type { AgentStatusEventDto, AgentSummaryDto, SuggestionDto, ThreadDto } from '@collab/protocol';
import type { ReviewMarks } from '../editor/reviewDecorations.js';
import type { PreviewMark } from '../editor/previewInline.js';

export interface MarkInput {
  threads: ThreadDto[];
  suggestions: SuggestionDto[];
  activity: Record<string, AgentStatusEventDto>;
  agents: AgentSummaryDto[];
  activeThreadId: string | undefined;
  canDecide: boolean;
  nameOf: (principalId: string) => string;
}

type Located = { start: number; end: number };
type RangeThread = ThreadDto & { scope: { type: 'range'; quote: string; resolved: Located & { status: 'exact' | 'relocated' } } };
type LocatedSuggestion = SuggestionDto & { resolved: Located & { status: 'exact' } };

/** Open discussions with something left to read; a thread whose messages were all withdrawn disappears. */
function visibleRangeThreads(threads: ThreadDto[]): RangeThread[] {
  return threads.filter((thread): thread is RangeThread =>
    thread.status === 'open'
    && thread.scope.type === 'range'
    && thread.scope.resolved.status !== 'detached'
    && thread.messages.some((message) => message.status === 'visible'));
}

function pendingSuggestions(suggestions: SuggestionDto[]): LocatedSuggestion[] {
  return suggestions.filter((suggestion): suggestion is LocatedSuggestion =>
    suggestion.status === 'pending' && suggestion.withdrawnAt === undefined && suggestion.resolved.status === 'exact');
}

/** Threads an agent is working on, from live events or (after a reload) from the agent list. */
function workingThreads(activity: Record<string, AgentStatusEventDto>, agents: AgentSummaryDto[]): Map<string, string> {
  const working = new Map<string, string>();
  for (const agent of agents) for (const threadId of agent.workingThreadIds) working.set(threadId, agent.id);
  for (const status of Object.values(activity)) {
    if (status.state === 'working') working.set(status.threadId, status.agentId);
    else working.delete(status.threadId);
  }
  return working;
}

export function editorMarks(input: MarkInput): ReviewMarks {
  const threads = visibleRangeThreads(input.threads);
  const working = workingThreads(input.activity, input.agents);
  return {
    threads: threads.map((thread) => ({ threadId: thread.id, start: thread.scope.resolved.start, end: thread.scope.resolved.end, unread: thread.unread, active: thread.id === input.activeThreadId })),
    suggestions: pendingSuggestions(input.suggestions).map((suggestion) => ({
      id: suggestion.id,
      ...(suggestion.threadId === undefined ? {} : { threadId: suggestion.threadId }),
      start: suggestion.resolved.start,
      end: suggestion.resolved.end,
      newText: suggestion.newText,
      decidable: input.canDecide,
    })),
    working: threads.flatMap((thread) => {
      const agentId = working.get(thread.id);
      return agentId === undefined ? [] : [{ threadId: thread.id, at: thread.scope.resolved.end, label: `${input.nameOf(agentId)} 正在处理…` }];
    }),
  };
}

export function previewMarks(input: MarkInput): PreviewMark[] {
  return [
    ...visibleRangeThreads(input.threads).map((thread) => ({
      start: thread.scope.resolved.start,
      end: thread.scope.resolved.end,
      threadId: thread.id,
      className: `md-thread${thread.unread ? ' is-unread' : ''}${thread.id === input.activeThreadId ? ' is-active' : ''}`,
    })),
    ...pendingSuggestions(input.suggestions).filter((suggestion) => suggestion.resolved.end > suggestion.resolved.start).map((suggestion) => ({
      start: suggestion.resolved.start,
      end: suggestion.resolved.end,
      className: 'md-suggestion',
      ...(suggestion.threadId === undefined ? {} : { threadId: suggestion.threadId }),
    })),
  ];
}
