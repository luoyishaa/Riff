import type { AgentStatusEvent } from '@collab/agent';
import type { AgentFailureKind, AgentState } from '@collab/protocol';

interface ThreadStatus { state: AgentState; error?: string; errorKind?: AgentFailureKind; sequence: number }

export interface AgentStatusSummary {
  state: AgentState;
  workingThreadIds: string[];
  error?: string;
  errorKind?: AgentFailureKind;
}

/**
 * Process-local view of what each agent is doing per document. An agent can
 * work on several threads at once; it is "working" while any of them runs,
 * otherwise it reports the outcome of its most recent run.
 */
export class AgentStatusBoard {
  private readonly threads = new Map<string, Map<string, ThreadStatus>>();
  private sequence = 0;

  record(docId: string, event: AgentStatusEvent): void {
    const key = `${docId}:${event.agentId}`;
    const byThread = this.threads.get(key) ?? new Map<string, ThreadStatus>();
    byThread.set(event.threadId, {
      state: event.state,
      sequence: ++this.sequence,
      ...(event.error === undefined ? {} : { error: event.error }),
      ...(event.errorKind === undefined ? {} : { errorKind: event.errorKind }),
    });
    this.threads.set(key, byThread);
  }

  summary(docId: string, agentId: string): AgentStatusSummary {
    const byThread = [...(this.threads.get(`${docId}:${agentId}`)?.entries() ?? [])];
    const workingThreadIds = byThread.filter(([, status]) => status.state === 'working').map(([threadId]) => threadId);
    if (workingThreadIds.length > 0) return { state: 'working', workingThreadIds };
    const latest = byThread.map(([, status]) => status).sort((left, right) => right.sequence - left.sequence)[0];
    if (!latest) return { state: 'idle', workingThreadIds: [] };
    return {
      state: latest.state,
      workingThreadIds: [],
      ...(latest.error === undefined ? {} : { error: latest.error }),
      ...(latest.errorKind === undefined ? {} : { errorKind: latest.errorKind }),
    };
  }

  removeDocument(docId: string): void {
    for (const key of this.threads.keys()) if (key.startsWith(`${docId}:`)) this.threads.delete(key);
  }
}
