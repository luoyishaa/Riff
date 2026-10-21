import type { AgentRunRequest, AgentRunResult } from './types.js';

export interface AgentRunExecutor<Request extends AgentRunRequest = AgentRunRequest> {
  run(request: Request): Promise<AgentRunResult>;
}

interface Waiter {
  resolve: (result: AgentRunResult) => void;
  reject: (error: unknown) => void;
}

interface QueuedRun<Request> {
  request: Request;
  waiters: Waiter[];
}

/**
 * Serializes each agent/thread pair while keeping only the latest queued
 * trigger. Waiters of a replaced trigger receive the result of the run that
 * replaced it, so any side effect belongs in the executor, which runs once.
 */
export class AgentDispatcher<Request extends AgentRunRequest = AgentRunRequest> {
  private readonly active = new Map<string, Promise<AgentRunResult>>();
  private readonly queued = new Map<string, QueuedRun<Request>>();

  constructor(private readonly executor: AgentRunExecutor<Request>) {}

  dispatch(request: Request): Promise<AgentRunResult> {
    const key = `${request.agentId}:${request.threadId}`;
    if (!this.active.has(key)) return this.start(key, request);
    return new Promise<AgentRunResult>((resolve, reject) => {
      const current = this.queued.get(key);
      if (current) {
        current.request = request;
        current.waiters.push({ resolve, reject });
      } else {
        this.queued.set(key, { request, waiters: [{ resolve, reject }] });
      }
    });
  }

  isWorking(agentId: string, threadId: string): boolean {
    return this.active.has(`${agentId}:${threadId}`);
  }

  private start(key: string, request: Request): Promise<AgentRunResult> {
    const running = this.executor.run(request);
    this.active.set(key, running);
    const startNext = (): void => this.startQueued(key);
    running.then(startNext, startNext);
    return running;
  }

  private startQueued(key: string): void {
    this.active.delete(key);
    const next = this.queued.get(key);
    if (!next) return;
    this.queued.delete(key);
    this.start(key, next.request).then(
      (result) => next.waiters.forEach((waiter) => waiter.resolve(result)),
      (error: unknown) => next.waiters.forEach((waiter) => waiter.reject(error)),
    );
  }
}
