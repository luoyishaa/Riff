import type { AgentRunRequest, AgentRunResult } from './types.js';

export interface AgentRunExecutor {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

interface Waiter {
  resolve: (result: AgentRunResult) => void;
  reject: (error: unknown) => void;
}

interface QueuedRun {
  request: AgentRunRequest;
  waiters: Waiter[];
}

/** Serializes each agent/thread pair while keeping only the latest queued trigger. */
export class AgentDispatcher {
  private readonly active = new Map<string, Promise<AgentRunResult>>();
  private readonly queued = new Map<string, QueuedRun>();

  constructor(private readonly executor: AgentRunExecutor) {}

  dispatch(request: AgentRunRequest): Promise<AgentRunResult> {
    const key = `${request.agentId}:${request.threadId}`;
    if (this.active.has(key)) {
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
    return this.start(key, request);
  }

  isWorking(agentId: string, threadId: string): boolean {
    return this.active.has(`${agentId}:${threadId}`);
  }

  private start(key: string, request: AgentRunRequest): Promise<AgentRunResult> {
    const running = this.executor.run(request);
    this.active.set(key, running);
    running.then(
      (result) => this.finish(key, result),
      (error: unknown) => this.finishError(key, error),
    );
    return running;
  }

  private finish(key: string, _result: AgentRunResult): void {
    this.active.delete(key);
    const next = this.queued.get(key);
    if (!next) return;
    this.queued.delete(key);
    const running = this.start(key, next.request);
    running.then(
      (result) => next.waiters.forEach((waiter) => waiter.resolve(result)),
      (error: unknown) => next.waiters.forEach((waiter) => waiter.reject(error)),
    );
  }

  private finishError(key: string, error: unknown): void {
    this.active.delete(key);
    const next = this.queued.get(key);
    if (!next) return;
    this.queued.delete(key);
    const running = this.start(key, next.request);
    running.then(
      (result) => next.waiters.forEach((waiter) => waiter.resolve(result)),
      (nextError: unknown) => next.waiters.forEach((waiter) => waiter.reject(nextError)),
    );
    void error;
  }
}
