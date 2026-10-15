import { err } from '@collab/kernel';
import { effectiveRole } from './permissions.js';
import { parseAgentOutput, validateEdits } from './output.js';
import type {
  AgentEventSink,
  AgentMessagePort,
  AgentRun,
  AgentRunRepository,
  AgentRunRequest,
  AgentRunResult,
  AgentViewRepository,
} from './types.js';

export interface RunControl {
  readonly signal: AbortSignal;
  timedOut(): boolean;
  cancel(): void;
}

export interface RunControlFactory {
  start(timeoutMs: number): RunControl;
}

export interface AgentRunnerOptions {
  clock: { now(): number };
  ids: { next(): string };
  runs: AgentRunRepository;
  views?: AgentViewRepository;
  controls: RunControlFactory;
  statuses?: AgentEventSink;
  messages?: AgentMessagePort;
  maxRetries?: number;
}

function failureText(error: string): string {
  return `Agent run failed: ${error}`;
}

function toError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AgentRunner {
  constructor(private readonly options: AgentRunnerOptions) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const startedAt = this.options.clock.now();
    const role = effectiveRole(request.grantedRole, request.requesterRole);
    const run: AgentRun = {
      id: this.options.ids.next(), agentId: request.agentId, docId: request.docId, threadId: request.threadId,
      requesterId: request.requester.id, strategy: request.strategy, startedAt, durationMs: 0,
      inputChars: request.inputChars, outputValid: false, retries: 0, suggestionIds: [],
    };
    this.options.statuses?.publish({ type: 'agent.status', agentId: request.agentId, threadId: request.threadId, state: 'working', ...(request.range === undefined ? {} : { range: request.range }) });
    let result: AgentRunResult;
    if (role === 'viewer') {
      result = await this.fail(request, run, role, 'insufficient permission');
    } else {
      const control = this.options.controls.start(request.timeoutMs ?? 120_000);
      try {
        result = await this.execute(request, run, role, control);
      } catch (error) {
        result = await this.fail(request, run, role, toError(error), control);
      } finally {
        control.cancel();
      }
    }
    this.options.runs.save(result.run);
    this.options.statuses?.publish({ type: 'agent.status', agentId: request.agentId, threadId: request.threadId, state: result.run.error === undefined ? 'idle' : 'failed', ...(request.range === undefined ? {} : { range: request.range }) });
    if (request.textSnapshot !== undefined && this.options.views !== undefined) {
      this.options.views.save({ agentId: request.agentId, docId: request.docId, textSnapshot: request.textSnapshot, takenAt: this.options.clock.now() });
    }
    return result;
  }

  private async execute(request: AgentRunRequest, run: AgentRun, role: AgentRunResult['effectiveRole'], control: RunControl): Promise<AgentRunResult> {
    let parsed: ReturnType<typeof parseAgentOutput> = err('no-json-object');
    const maxRetries = this.options.maxRetries ?? 1;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const prompt = attempt === 0 ? request.prompt : {
        ...request.prompt,
        user: `${request.prompt.user}\nPrevious output was invalid. Return one JSON object matching the required protocol.`,
      };
      const response = await request.adapter.run(prompt, { signal: control.signal });
      parsed = parseAgentOutput(response.text);
      run.retries = attempt;
      if (parsed.ok) break;
      if (control.timedOut()) return this.fail(request, run, role, 'timeout', control);
    }
    if (!parsed.ok) return this.fail(request, run, role, `invalid output: ${parsed.error}`, control);
    run.outputValid = true;
    const validated = request.allowedText === undefined ? { edits: parsed.value.edits, rejected: [], truncated: 0 } : validateEdits(parsed.value, request.allowedText);
    let reply = parsed.value.reply;
    if (validated.rejected.length > 0 || validated.truncated > 0) reply += `\n${validated.rejected.length + validated.truncated} edit(s) could not be located or were discarded.`;
    const edits = role === 'commenter' ? [] : validated.edits;
    if (role === 'commenter' && parsed.value.edits.length > 0) reply += '\nYour current permission only allows a reply; proposed edits were not submitted.';
    run.durationMs = Math.max(0, this.options.clock.now() - run.startedAt);
    return { run, reply, edits, effectiveRole: role };
  }

  private async fail(request: AgentRunRequest, run: AgentRun, role: AgentRunResult['effectiveRole'], error: string, control?: RunControl): Promise<AgentRunResult> {
    run.error = error;
    run.durationMs = Math.max(0, this.options.clock.now() - run.startedAt);
    try {
      await this.options.messages?.postFailure(request.threadId, request.agentId, failureText(error));
    } catch {
      // Preserve the failed run record even if the feedback port is unavailable.
    }
    control?.cancel();
    return { run, edits: [], effectiveRole: role };
  }
}
