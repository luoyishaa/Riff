import type { Clock, IdGenerator, Principal, Role } from '@collab/kernel';

export type AgentStrategy = 'selection' | 'window' | 'full';

export interface AgentConfig {
  principalId: string;
  adapter: AdapterConfig;
  grantedRole: Role;
  contextStrategy: AgentStrategy;
  /** Whether every document member may mention this agent. Defaults to public. */
  accessPolicy?: 'public' | 'private';
}

export type AdapterConfig =
  | { type: 'mock' }
  | { type: 'openai-compatible'; baseUrl: string; apiKeyEnv: string; model: string }
  /** Responses API transport for an OAuth access token authorized for ChatGPT plan usage. */
  | { type: 'openai-responses'; baseUrl: string; accessTokenEnv: string; model: string; profileId?: string; ownerPrincipalId?: string }
  | { type: 'cli'; command: string; args?: string[]; timeoutMs?: number; includeSystemInPrompt?: boolean };

export interface AgentRun {
  id: string;
  agentId: string;
  docId: string;
  threadId: string;
  requesterId: string;
  strategy: AgentStrategy;
  startedAt: number;
  durationMs: number;
  inputChars: number;
  outputValid: boolean;
  retries: number;
  error?: string;
  suggestionIds: string[];
}

export interface AgentView {
  agentId: string;
  docId: string;
  textSnapshot: string;
  takenAt: number;
}

export interface AgentAdapter {
  readonly id: string;
  run(req: { system: string; user: string }, opts: { signal: AbortSignal }): Promise<{ text: string }>;
}

export interface AgentRunRepository {
  save(run: AgentRun): void;
}

export interface AgentViewRepository {
  get(agentId: string, docId: string): AgentView | undefined;
  save(view: AgentView): void;
}

export interface AgentMessagePort {
  postFailure(threadId: string, agentId: string, body: string): Promise<void> | void;
}

export type AgentStatusState = 'working' | 'idle' | 'failed';

export interface AgentStatusEvent {
  type: 'agent.status';
  agentId: string;
  threadId: string;
  state: AgentStatusState;
  range?: { start: number; end: number };
}

export interface AgentRunRequest {
  agentId: string;
  docId: string;
  threadId: string;
  requester: Principal;
  requesterRole: Role;
  grantedRole: Role;
  strategy: AgentStrategy;
  adapter: AgentAdapter;
  prompt: { system: string; user: string };
  inputChars: number;
  timeoutMs?: number;
  range?: { start: number; end: number };
  /** Text the agent saw, persisted after this run for human-edit awareness. */
  textSnapshot?: string;
  /** Optional allowed context used to validate returned edits. */
  allowedText?: string;
}

export interface AgentRunResult {
  run: AgentRun;
  reply?: string;
  edits: AgentEdit[];
  effectiveRole: Role;
}

export interface AgentEdit {
  op: 'replace' | 'delete' | 'insert';
  quote: string;
  newText: string;
  contextBefore?: string;
  contextAfter?: string;
  rationale?: string;
}

export interface AgentClockIds {
  clock: Clock;
  ids: IdGenerator;
}

export interface AgentEventSink {
  publish(event: AgentStatusEvent): void;
}
