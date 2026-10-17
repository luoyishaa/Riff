import type { Thread } from '@collab/review';

export interface AgentTriggerTargetsInput {
  thread: Pick<Thread, 'kind' | 'agentId'>;
  mentioned: string[];
  participated: string[];
  isAgent: (principalId: string) => boolean;
}

/** Resolve all agents that should receive one human message. */
export function agentTriggerTargets(input: AgentTriggerTargetsInput): string[] {
  const candidates = [
    ...input.mentioned,
    ...input.participated,
    ...(input.thread.kind === 'task' && input.thread.agentId !== undefined ? [input.thread.agentId] : []),
  ];
  return [...new Set(candidates.filter((id): id is string => id !== undefined && input.isAgent(id)))];
}
