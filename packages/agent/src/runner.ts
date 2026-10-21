import { err } from '@collab/kernel';
import { effectiveRole } from './permissions.js';
import { parseAgentOutput, validateEdits, validateRelatedEdits, type ValidatedEdits } from './output.js';
import { RETRY_INSTRUCTION } from './prompts.js';
import type {
  AgentEventSink,
  AgentFailureKind,
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

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_EDITS = 50;

export function classifyAgentFailure(error: string): AgentFailureKind {
  const normalized = error.toLowerCase();
  if (/(permission|forbidden|insufficient|not allowed|unauthorized)/u.test(normalized)) return 'permission';
  if (/(timeout|timed out|aborted|deadline)/u.test(normalized)) return 'timeout';
  if (/(401|403|auth|token|login|credential|api key)/u.test(normalized)) return 'authentication';
  if (/(429|rate.?limit|quota|too many requests)/u.test(normalized)) return 'rate-limit';
  if (/(enoent|econn|network|fetch failed|socket|dns|unreachable|http 5\d\d)/u.test(normalized)) return 'network';
  if (/(invalid output|no-json|malformed|protocol)/u.test(normalized)) return 'invalid-output';
  if (/(agent http|provider|model)/u.test(normalized)) return 'provider';
  return 'unknown';
}

const FAILURE_TEXT: Record<AgentFailureKind, string> = {
  permission: '当前权限不足，请检查 Agent 的项目权限。',
  timeout: '处理超时，请稍后重试或缩小任务范围。',
  authentication: '提供商授权或登录状态不可用，请重新连接。',
  'rate-limit': '提供商暂时限流或额度不足，请稍后再试。',
  network: '无法连接到提供商，请检查网络或本机 CLI 状态。',
  'invalid-output': '提供商返回的内容无法解析，请重试一次。',
  provider: '提供商没有完成这次请求，请检查模型配置。',
  unknown: '服务暂时没有完成这次请求，请稍后重试。',
};

function toError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Related edits may not touch the selection; the selected edits own that region. */
function outsideRange(related: ValidatedEdits, range: AgentRunRequest['range']): ValidatedEdits {
  if (range === undefined) return related;
  const edits = related.edits.filter((edit) => edit.start >= range.end || edit.end <= range.start);
  const overlapping = related.edits.length - edits.length;
  const rejected = [...related.rejected, ...Array.from({ length: overlapping }, (_, offset) => ({ index: related.rejected.length + offset, reason: 'overlap' as const }))];
  return { edits, rejected, truncated: related.truncated };
}

function explainDiscarded(validated: ValidatedEdits, related: ValidatedEdits): string {
  const discarded = validated.rejected.length + validated.truncated + related.rejected.length + related.truncated;
  if (discarded === 0) return '';
  const structure = [...validated.rejected, ...related.rejected].filter((rejection) => rejection.reason === 'structure').length;
  const notes: string[] = [];
  if (structure > 0) notes.push(`${structure} 条修改因会破坏 Markdown 结构（标题、列表、代码围栏、引用或表格）未提交；请保留对应结构标记后重试。`);
  if (discarded > structure) notes.push(`${discarded - structure} 条修改无法定位或已被丢弃。`);
  if (validated.edits.length === 0) notes.push('未生成可审批修改建议；请检查引用是否完整位于选区内，然后重试。');
  return notes.map((note) => `\n${note}`).join('');
}

export class AgentRunner {
  constructor(private readonly options: AgentRunnerOptions) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const role = effectiveRole(request.grantedRole, request.requesterRole);
    const run: AgentRun = {
      id: this.options.ids.next(), agentId: request.agentId, docId: request.docId, threadId: request.threadId,
      requesterId: request.requester.id, strategy: request.strategy, startedAt: this.options.clock.now(), durationMs: 0,
      inputChars: request.inputChars, outputValid: false, retries: 0, suggestionIds: [],
    };
    const range = request.range === undefined ? {} : { range: request.range };
    this.options.statuses?.publish({ type: 'agent.status', agentId: request.agentId, threadId: request.threadId, state: 'working', ...range });
    let result: AgentRunResult;
    if (role === 'viewer') {
      result = await this.fail(request, run, role, 'insufficient permission');
    } else {
      const control = this.options.controls.start(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        result = await this.execute(request, run, role, control);
      } catch (error) {
        result = await this.fail(request, run, role, control.timedOut() ? 'timeout' : toError(error));
      } finally {
        control.cancel();
      }
    }
    this.options.runs.save(result.run);
    const error = result.run.error;
    this.options.statuses?.publish({
      type: 'agent.status',
      agentId: request.agentId,
      threadId: request.threadId,
      state: error === undefined ? 'idle' : 'failed',
      ...(error === undefined ? {} : { error, errorKind: classifyAgentFailure(error) }),
      ...range,
    });
    if (request.textSnapshot !== undefined) {
      this.options.views?.save({ agentId: request.agentId, docId: request.docId, textSnapshot: request.textSnapshot, takenAt: this.options.clock.now() });
    }
    return result;
  }

  private async execute(request: AgentRunRequest, run: AgentRun, role: AgentRunResult['effectiveRole'], control: RunControl): Promise<AgentRunResult> {
    let parsed: ReturnType<typeof parseAgentOutput> = err('no-json-object');
    const maxRetries = this.options.maxRetries ?? 1;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const prompt = attempt === 0 ? request.prompt : { ...request.prompt, user: `${request.prompt.user}\n${RETRY_INSTRUCTION}` };
      const response = await request.adapter.run(prompt, { signal: control.signal });
      parsed = parseAgentOutput(response.text);
      run.retries = attempt;
      if (parsed.ok) break;
      if (control.timedOut()) return this.fail(request, run, role, 'timeout');
    }
    if (!parsed.ok) return this.fail(request, run, role, `invalid output: ${parsed.error}`);
    run.outputValid = true;
    const validated = validateEdits(parsed.value, request.allowedText, MAX_EDITS);
    const related = request.documentText === undefined
      ? { edits: [], rejected: [], truncated: 0 }
      : outsideRange(validateRelatedEdits(parsed.value, request.documentText, Math.max(0, MAX_EDITS - validated.edits.length)), request.range);
    let reply = parsed.value.reply + explainDiscarded(validated, related);
    const proposed = parsed.value.edits.length + parsed.value.relatedEdits.length;
    if (role === 'commenter' && proposed > 0) reply += '\n当前有效权限只允许回复，修改建议未提交。';
    run.durationMs = Math.max(0, this.options.clock.now() - run.startedAt);
    return { run, reply, edits: role === 'commenter' ? [] : [...validated.edits, ...related.edits], effectiveRole: role };
  }

  private async fail(request: AgentRunRequest, run: AgentRun, role: AgentRunResult['effectiveRole'], error: string): Promise<AgentRunResult> {
    run.error = error;
    run.durationMs = Math.max(0, this.options.clock.now() - run.startedAt);
    try {
      await this.options.messages?.postFailure(request.threadId, request.agentId, `Agent 暂时无法完成这次任务：${FAILURE_TEXT[classifyAgentFailure(error)]}`);
    } catch {
      // Preserve the failed run record even if the feedback port is unavailable.
    }
    return { run, edits: [], effectiveRole: role };
  }
}
