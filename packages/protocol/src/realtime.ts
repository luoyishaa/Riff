import { z } from 'zod';
import type { AgentFailureKind, AgentState, MemberDto } from './responses.js';

/**
 * WebSocket frames for one document. Binary Yjs updates and y-protocols
 * awareness updates travel base64-encoded inside JSON envelopes.
 */
export const clientSocketMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('sync'), update: z.string().min(1) }),
  /** `clientId` lets the server announce the peer's departure when the socket closes. */
  z.object({ type: z.literal('awareness'), clientId: z.number().int().nonnegative(), update: z.string().min(1) }),
]);
export type ClientSocketMessage = z.infer<typeof clientSocketMessageSchema>;

export type ServerSocketMessage =
  | { type: 'sync'; update: string }
  | { type: 'awareness'; update: string }
  | { type: 'awareness-leave'; clientIds: number[] }
  /** Online members the receiving viewer is allowed to see. */
  | { type: 'members'; members: MemberDto[] };

export type DocumentEventType =
  | 'thread.created'
  | 'thread.resolved'
  | 'message.created'
  | 'message.updated'
  | 'suggestion.created'
  | 'suggestion.updated'
  | 'batch.created'
  | 'document.changed'
  | 'agent.status'
  /** Members of the document's project, their roles or its agents changed. */
  | 'members.changed';

/** Server-sent event envelope; `data` depends on `type`. */
export interface DocumentEvent<T = unknown> { id: string; type: DocumentEventType; docId: string; occurredAt: number; data: T }

export interface AgentStatusEventDto {
  agentId: string;
  threadId: string;
  state: AgentState;
  error?: string;
  errorKind?: AgentFailureKind;
  range?: { start: number; end: number };
}
