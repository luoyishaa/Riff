import type { AgentRun, AgentRunRepository, AgentView, AgentViewRepository } from './types.js';

export class MemoryAgentRunRepository implements AgentRunRepository {
  readonly runs: AgentRun[] = [];
  save(run: AgentRun): void { this.runs.push(run); }
}

export class MemoryAgentViewRepository implements AgentViewRepository {
  private readonly views = new Map<string, AgentView>();
  get(agentId: string, docId: string): AgentView | undefined { return this.views.get(`${agentId}:${docId}`); }
  save(view: AgentView): void { this.views.set(`${view.agentId}:${view.docId}`, view); }
}
