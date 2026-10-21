import type { Principal, Role } from '@collab/kernel';

export type AgentStrategy = 'selection' | 'window' | 'full';

export type AdapterConfig =
  | { type: 'mock' }
  /**
   * `apiKeyEnv` names the environment variable holding the key. Without it the
   * key was supplied for the running process only and is never persisted.
   */
  | { type: 'openai-compatible'; baseUrl: string; model: string; apiKeyEnv?: string }
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

export interface LocatedEdit extends AgentEdit {
  /** Offsets in the text the agent saw: the allowed region or the whole document. */
  start: number;
  end: number;
  scope: 'allowed' | 'document';
}

export type AgentStatusState = 'working' | 'idle' | 'failed';

/** Stable categories used to explain an agent failure without exposing raw provider errors in the UI. */
export type AgentFailureKind = 'permission' | 'timeout' | 'authentication' | 'rate-limit' | 'network' | 'invalid-output' | 'provider' | 'unknown';

export interface AgentStatusEvent {
  type: 'agent.status';
  agentId: string;
  threadId: string;
  state: AgentStatusState;
  error?: string;
  errorKind?: AgentFailureKind;
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
  /** The selected range in `documentText`, when the thread is anchored to one. */
  range?: { start: number; end: number };
  /** Text the agent saw, persisted after this run for human-edit awareness. */
  textSnapshot?: string;
  /** The region `edits` must quote from (the selection, or the whole text). */
  allowedText: string;
  /** Full document text used only for consistency checks outside a selected range. */
  documentText?: string;
}

export interface AgentRunResult {
  run: AgentRun;
  reply?: string;
  edits: LocatedEdit[];
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

export interface AgentEventSink {
  publish(event: AgentStatusEvent): void;
}
