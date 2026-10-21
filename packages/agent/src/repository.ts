import type { AgentRun, AgentRunRepository } from './types.js';

export class MemoryAgentRunRepository implements AgentRunRepository {
  readonly runs: AgentRun[] = [];
  save(run: AgentRun): void { this.runs.push(run); }
}
