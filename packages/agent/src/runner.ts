import { err } from '@collab/kernel';
import { effectiveRole } from './permissions.js';
import { parseAgentOutput, validateEdits, validateRelatedEdits } from './output.js';
import type {
  AgentEventSink,
  AgentMessagePort,
  AgentRun,
  AgentRunRepository,
  AgentRunRequest,
  AgentRunResult,
  AgentFailureKind,
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

export function classifyAgentFailure(error: string): AgentFailureKind {
  const normalized = error.toLowerCase();
  if (/(permission|forbidden|insufficient|not allowed|unauthorized)/u.test(normalized)) return 'permission';
  if (/(timeout|timed out|aborted|deadline)/u.test(normalized)) return 'timeout';
  if (/(401|403|auth|token|login|credential|api key)/u.test(normalized)) return 'authentication';
  if (/(429|rate.?limit|quota|too many requests)/u.test(normalized)) return 'rate-limit';
  if (/(enoent|econn|network|fetch failed|socket|dns|unreachable|http 5\d\d)/u.test(normalized)) return 'network';
  if (/(invalid output|no-json|malformed|protocol)/u.test(normalized)) return 'invalid-output';
  if (/(agent http|responses api|provider|model)/u.test(normalized)) return 'provider';
  return 'unknown';
}

function failureText(error: string): string {
  const kind = classifyAgentFailure(error);
  const message: Record<AgentFailureKind, string> = {
    permission: '当前权限不足，请检查 Agent 的项目权限。',
    timeout: '处理超时，请稍后重试或缩小任务范围。',
    authentication: '提供商授权或登录状态不可用，请重新连接。',
    'rate-limit': '提供商暂时限流或额度不足，请稍后再试。',
    network: '无法连接到提供商，请检查网络或本机 CLI 状态。',
    'invalid-output': '提供商返回的内容无法解析，请重试一次。',
    provider: '提供商没有完成这次请求，请检查模型配置。',
    unknown: '服务暂时没有完成这次请求，请稍后重试。',
  };
  return `Agent 暂时无法完成这次任务：${message[kind]}`;
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
        result = await this.fail(request, run, role, control.timedOut() ? 'timeout' : toError(error), control);
      } finally {
        control.cancel();
      }
    }
    this.options.runs.save(result.run);
    this.options.statuses?.publish({
      type: 'agent.status',
      agentId: request.agentId,
      threadId: request.threadId,
      state: result.run.error === undefined ? 'idle' : 'failed',
      ...(result.run.error === undefined ? {} : { error: result.run.error, errorKind: classifyAgentFailure(result.run.error) }),
      ...(request.range === undefined ? {} : { range: request.range }),
    });
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
    const validated = request.allowedText === undefined
      ? { edits: parsed.value.edits.map((edit) => ({ ...edit, start: -1, end: -1, scope: 'document' as const })), rejected: [], truncated: 0 }
      : validateEdits(parsed.value, request.allowedText);
    const rawRelated = request.documentText === undefined
      ? { edits: [], rejected: [], truncated: 0 }
      : validateRelatedEdits(parsed.value, request.documentText, Math.max(0, 50 - validated.edits.length));
    const related = request.range === undefined ? rawRelated : (() => {
      const edits = rawRelated.edits.filter((edit) => edit.start >= request.range!.end || edit.end <= request.range!.start);
      const overlapCount = rawRelated.edits.length - edits.length;
      return {
        edits,
        rejected: [...rawRelated.rejected, ...Array.from({ length: overlapCount }, (_, index) => ({ index: rawRelated.rejected.length + index, reason: 'overlap' as const }))],
        truncated: rawRelated.truncated,
      };
    })();
    let reply = parsed.value.reply;
    const discardedEdits = validated.rejected.length + validated.truncated + related.rejected.length + related.truncated;
    if (discardedEdits > 0) {
      const structureRejected = [...validated.rejected, ...related.rejected].filter((rejection) => rejection.reason === 'structure').length;
      const otherDiscarded = discardedEdits - structureRejected;
      if (structureRejected > 0) reply += `\n${structureRejected} 条修改因会破坏 Markdown 结构（标题、列表、代码围栏、引用或表格）未提交；请保留对应结构标记后重试。`;
      if (otherDiscarded > 0) reply += `\n${otherDiscarded} 条修改无法定位或已被丢弃。`;
      if (validated.edits.length === 0) reply += '\n未生成可审批修改建议；请检查引用是否完整位于选区内，然后重试。';
    }
    const edits = role === 'commenter' ? [] : [...validated.edits, ...related.edits];
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
