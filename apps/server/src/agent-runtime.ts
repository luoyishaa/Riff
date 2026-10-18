import { spawn, type ChildProcess } from 'node:child_process';
import { resolveAnchor, roles, type Role } from '@collab/kernel';
import {
  AgentDispatcher,
  AgentRunner,
  CliAdapter,
  MockAdapter,
  OpenAICompatibleAdapter,
  OpenAIResponsesAdapter,
  buildContext,
  type AgentAdapter,
  type AgentConfig,
  type AgentFailureKind,
  type AgentRunRequest,
  type AgentStatusState,
  type ChatCompletionResponse,
  type ResponsesApiResponse,
  type CliRunner,
  type HttpJsonClient,
  type LocatedEdit,
} from '@collab/agent';
import { ReviewService, type ReviewEvent } from '@collab/review';
import { AppEventBus } from './events.js';
import { AgentStore } from './infra/agent-store.js';
import { DocumentStore } from './infra/document-store.js';
import { ReviewStore } from './infra/review-store.js';
import { agentTriggerTargets } from './agent-trigger.js';
import type { ChatGPTOAuthService } from './chatgpt-oauth.js';

const SESSION_API_KEY_ENV = '__COLLAB_SESSION_API_KEY__';
const SESSION_CHATGPT_TOKEN_ENV = '__COLLAB_CHATGPT_ACCESS_TOKEN__';
const DEFAULT_CLI_TIMEOUT_MS = 180_000;
type CliPreset = 'codex' | 'claude';

interface AgentRuntimeOptions {
  store: DocumentStore;
  reviewStore: ReviewStore;
  reviewService: ReviewService;
  agentStore: AgentStore;
  eventBus: AppEventBus;
  now: () => number;
  nextId: () => string;
  chatgptOAuth?: ChatGPTOAuthService;
}

export const AGENT_SYSTEM_PROMPT = [
  '你是协作写作助手。',
  '只根据本次触发消息执行，不要把线程中的旧请求当作当前指令。',
  '用户要求扩展、改写、润色或替换时，必须在 edits 中给出可审批的文本修改；如果无需修改或用户只是在提问，edits 可以为空。',
  '选区之外的内容只作为全文一致性检查素材；如果修改会影响其他位置的术语、指代、链接或依赖引用，只在 relatedEdits 中提出额外建议。edits 只能改选区，relatedEdits 才能改全文其他位置；没有明确影响时 relatedEdits 必须为空。',
  '每个 edit 必须使用字段 op、quote、newText，可选 contextBefore、contextAfter、rationale；op 只能是 replace、delete 或 insert。replace 必须把 quote 逐字替换为 newText。不要使用 replacement、oldText、changes 或其他字段名。',
  '始终只返回一个合法 JSON 对象，字段为 reply（字符串）、edits（数组）和 relatedEdits（数组，可为空）；不要输出 Markdown、代码围栏或额外文字。',
  '修改必须限定在允许区域，保持原文语言。',
  '如果引用包含 Markdown 标题、列表、引用、代码围栏、表格或分隔线，newText 必须保留相同顺序和结构标记，只改其中的内容；不要把结构行吞掉。',
].join('\n');

interface AgentListItem {
  id: string;
  displayName: string;
  adapter: string;
  provider: string;
  contextStrategy: AgentConfig['contextStrategy'];
  grantedRole: Role;
  status: AgentStatusState | 'idle';
  error?: string;
  errorKind?: AgentFailureKind;
  accessPolicy: 'public' | 'private';
}

interface AgentStatusRecord {
  state: AgentStatusState;
  threadId: string;
  sequence: number;
  error?: string;
  errorKind?: AgentFailureKind;
}

function isAgentConfig(value: unknown): value is AgentConfig {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.principalId !== 'string' || typeof candidate.grantedRole !== 'string' || !roles.includes(candidate.grantedRole as Role) || !['selection', 'window', 'full'].includes(String(candidate.contextStrategy))) return false;
  if (candidate.accessPolicy !== undefined && candidate.accessPolicy !== 'public' && candidate.accessPolicy !== 'private') return false;
  const adapter = candidate.adapter;
  if (typeof adapter !== 'object' || adapter === null) return false;
  const type = (adapter as Record<string, unknown>).type;
  if (type === 'mock') return true;
  if (type === 'openai-compatible') {
    const item = adapter as Record<string, unknown>;
    return typeof item.baseUrl === 'string' && typeof item.apiKeyEnv === 'string' && typeof item.model === 'string';
  }
  if (type === 'openai-responses') {
    const item = adapter as Record<string, unknown>;
    return typeof item.baseUrl === 'string' && typeof item.accessTokenEnv === 'string' && typeof item.model === 'string'
      && (item.profileId === undefined || typeof item.profileId === 'string')
      && (item.ownerPrincipalId === undefined || typeof item.ownerPrincipalId === 'string');
  }
  if (type === 'cli') return typeof (adapter as Record<string, unknown>).command === 'string';
  return false;
}

class FetchJsonClient implements HttpJsonClient {
  constructor(private readonly apiKey: string) {}
  async post(url: string, body: unknown, signal: AbortSignal): Promise<ChatCompletionResponse> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error(`agent HTTP ${response.status}`);
    return await response.json() as ChatCompletionResponse;
  }
}

class FetchResponsesClient {
  constructor(private readonly defaultAccessToken = '') {}
  async post(url: string, body: unknown, signal: AbortSignal, accessToken?: string): Promise<ResponsesApiResponse> {
    const token = accessToken ?? this.defaultAccessToken;
    if (!token) throw new Error('missing ChatGPT plan access token');
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const raw = (await response.text()).trim().replace(/\s+/gu, ' ').slice(0, 320);
      let detail = raw;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) {
          const error = (parsed as { error?: unknown }).error;
          if (typeof error === 'object' && error !== null) {
            const record = error as { code?: unknown; message?: unknown };
            const code = typeof record.code === 'string' ? record.code : undefined;
            const message = typeof record.message === 'string' ? record.message : undefined;
            if (code !== undefined || message !== undefined) detail = [code, message].filter((value): value is string => value !== undefined).join(': ');
          }
        }
      } catch {
        // Keep the bounded raw response when the provider does not return JSON.
      }
      throw new Error(`agent Responses API HTTP ${response.status}${detail.length > 0 ? `: ${detail}` : ''}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) return await response.json() as ResponsesApiResponse;
    const raw = await response.text();
    let text = '';
    let failure: string | undefined;
    for (const line of raw.split(/\r?\n/u)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]' || payload.length === 0) continue;
      try {
        const event: unknown = JSON.parse(payload);
        if (typeof event !== 'object' || event === null) continue;
        const record = event as { type?: unknown; delta?: unknown; response?: { error?: { code?: unknown; message?: unknown } | null } };
        if (record.type === 'response.output_text.delta' && typeof record.delta === 'string') text += record.delta;
        if (record.type === 'response.failed' || record.type === 'response.incomplete') {
          const detail = record.response?.error;
          failure = typeof detail?.code === 'string' ? detail.code : 'response_failed';
        }
      } catch {
        throw new Error('agent Responses API returned malformed stream data');
      }
    }
    if (failure) throw new Error(`agent Responses API ${failure}`);
    return { output_text: text };
  }
}

class ProcessCliRunner implements CliRunner {
  run(config: { command: string; args: string[] }, input: { system: string; user: string }, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const start = (command: string, retryCmd: boolean): void => {
        const invocation = process.platform === 'win32' && command.toLowerCase().endsWith('.cmd')
          ? ['cmd.exe', ['/d', '/s', '/c', [quoteWindows(command), ...config.args.map(quoteWindows)].join(' ')]] as const
          : [command, config.args] as const;
        let child: ChildProcess;
        try {
          child = spawn(invocation[0], invocation[1], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (retryCmd && process.platform === 'win32' && (code === 'ENOENT' || code === 'EINVAL') && !command.toLowerCase().endsWith('.cmd')) {
            start(`${command}.cmd`, false);
            return;
          }
          reject(error);
          return;
        }
        let stdout = '';
        let stderr = '';
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
        child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
        const abort = (): void => { child.kill(); reject(new Error('agent process aborted')); };
        signal.addEventListener('abort', abort, { once: true });
        child.once('error', (error: NodeJS.ErrnoException) => {
          signal.removeEventListener('abort', abort);
          if (retryCmd && process.platform === 'win32' && (error.code === 'ENOENT' || error.code === 'EINVAL') && !command.toLowerCase().endsWith('.cmd')) {
            child.removeAllListeners('close');
            start(`${command}.cmd`, false);
            return;
          }
          reject(error);
        });
        child.once('close', (code) => {
          signal.removeEventListener('abort', abort);
          if (code === 0) resolve(stdout);
          else reject(new Error(stderr.trim() || `agent process exited with ${code ?? 'unknown status'}`));
        });
        if (config.args.includes('-')) child.stdin?.write(`${input.system}\n\n${input.user}`);
        child.stdin?.end();
      };
      start(config.command, true);
    });
  }
}

function quoteWindows(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/g, '$1$1')}"`;
}

export class AgentRuntime {
  private readonly configs = new Map<string, AgentConfig>();
  private readonly sessionApiKeys = new Map<string, string>();
  private readonly statuses = new Map<string, AgentStatusRecord>();
  private statusSequence = 0;
  private readonly dispatcher: AgentDispatcher;
  private readonly runner: AgentRunner;

  constructor(private readonly options: AgentRuntimeOptions) {
    for (const principal of options.store.principals().filter((item) => item.kind === 'agent')) {
      for (const document of options.store.list()) {
        const role = options.store.role(document.id, principal.id) ?? 'suggester';
        this.configs.set(this.key(document.id, principal.id), this.defaultConfig(principal.id, role));
      }
    }
    this.loadEnvironmentConfigs();
    this.loadPersistedConfigs();
    this.runner = new AgentRunner({
      clock: { now: options.now },
      ids: { next: options.nextId },
      runs: options.agentStore,
      views: options.agentStore,
      controls: { start: (timeoutMs) => this.startControl(timeoutMs) },
      statuses: { publish: (event) => this.publishStatus(event.agentId, event.threadId, event.state, event.range, event.error, event.errorKind) },
      messages: { postFailure: (threadId, agentId, body) => this.postAgentMessage(threadId, agentId, body) },
      maxRetries: 1,
    });
    this.dispatcher = new AgentDispatcher(this.runner);
  }

  list(docId: string, viewerId?: string): AgentListItem[] {
    return this.options.store.members(docId).filter((member) => member.kind === 'agent' && this.isVisible(docId, member.id, viewerId)).map((member) => {
      const config = this.configs.get(this.key(docId, member.id));
      const statusRecord = this.latestStatus(docId, member.id);
      return {
        id: member.id,
        displayName: member.displayName,
        adapter: config?.adapter.type ?? 'mock',
        provider: config?.adapter.type === 'cli' ? config.adapter.command : config?.adapter.type ?? 'mock',
        contextStrategy: config?.contextStrategy ?? 'window',
        grantedRole: config?.grantedRole ?? member.role,
        status: statusRecord?.state ?? 'idle',
        ...(statusRecord?.error === undefined ? {} : { error: statusRecord.error }),
        ...(statusRecord?.errorKind === undefined ? {} : { errorKind: statusRecord.errorKind }),
        accessPolicy: config?.accessPolicy ?? 'public',
      };
    });
  }

  isVisible(docId: string, agentId: string, viewerId?: string): boolean {
    const config = this.config(docId, agentId);
    if (config?.accessPolicy !== 'private') return true;
    const agent = this.options.store.principals().find((principal) => principal.id === agentId && principal.kind === 'agent');
    if (!viewerId || !agent) return false;
    return agent.ownerId === viewerId || this.options.store.role(docId, viewerId) === 'owner';
  }

  updateConfig(docId: string, config: AgentConfig): void { this.configs.set(this.key(docId, config.principalId), config); }

  /** Persist a document-scoped configuration and apply it to future runs. */
  configure(docId: string, config: AgentConfig): AgentConfig {
    if (config.adapter.type === 'openai-compatible' && config.adapter.apiKeyEnv === 'session') {
      const sessionConfig: AgentConfig = { ...config, adapter: { ...config.adapter, apiKeyEnv: SESSION_API_KEY_ENV } };
      this.updateConfig(docId, sessionConfig);
      return sessionConfig;
    }
    if (config.adapter.type === 'openai-responses' && config.adapter.accessTokenEnv === 'session') {
      const sessionConfig: AgentConfig = { ...config, adapter: { ...config.adapter, accessTokenEnv: SESSION_CHATGPT_TOKEN_ENV } };
      this.updateConfig(docId, sessionConfig);
      return sessionConfig;
    }
    this.updateConfig(docId, config);
    this.options.agentStore.saveConfig(docId, config);
    return config;
  }

  /** Remove an override and restore the member's safe default configuration. */
  removeConfig(docId: string, agentId: string): void {
    this.sessionApiKeys.delete(this.key(docId, agentId));
    this.options.agentStore.deleteConfig(docId, agentId);
    const member = this.options.store.members(docId).find((item) => item.id === agentId && item.kind === 'agent');
    if (!member) {
      this.configs.delete(this.key(docId, agentId));
      return;
    }
    this.configs.set(this.key(docId, agentId), this.defaultConfig(agentId, member.role));
  }

  config(docId: string, agentId: string): AgentConfig | undefined {
    return this.configs.get(this.key(docId, agentId));
  }

  /** Connect an installed provider without exposing or persisting credentials. */
  connectProvider(docId: string, agentId: string, input: {
    provider: 'codex' | 'claude' | 'openai-compatible';
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    grantedRole?: Role;
    contextStrategy?: AgentConfig['contextStrategy'];
    accessPolicy?: AgentConfig['accessPolicy'];
  }): AgentConfig | undefined {
    const member = this.options.store.members(docId).find((item) => item.id === agentId && item.kind === 'agent');
    const current = this.config(docId, agentId) ?? (member === undefined ? undefined : this.defaultConfig(agentId, member.role));
    if (!current) return undefined;
    if (!this.config(docId, agentId)) this.updateConfig(docId, current);
    const grantedRole = input.grantedRole ?? current.grantedRole;
    const contextStrategy = input.contextStrategy ?? current.contextStrategy;
    const accessPolicy = input.accessPolicy ?? current.accessPolicy ?? 'public';
    if (input.provider === 'openai-compatible') {
      if (!input.baseUrl || !input.model || !input.apiKey) return undefined;
      this.sessionApiKeys.set(this.key(docId, agentId), input.apiKey);
      const config: AgentConfig = {
        principalId: agentId,
        adapter: { type: 'openai-compatible', baseUrl: input.baseUrl, apiKeyEnv: SESSION_API_KEY_ENV, model: input.model },
        grantedRole,
        contextStrategy,
        accessPolicy,
      };
      // API keys are session-only. Keep this override in memory and never
      // write the sentinel env name to the persisted agent_configs table.
      this.updateConfig(docId, config);
      return config;
    }
    this.sessionApiKeys.delete(this.key(docId, agentId));
    const preset = input.provider as CliPreset;
    const config: AgentConfig = {
      principalId: agentId,
      adapter: {
        type: 'cli',
        command: preset === 'codex' ? 'codex' : 'claude',
        args: this.presetArgs(preset),
        ...(preset === 'claude' ? { includeSystemInPrompt: true } : {}),
      },
      grantedRole,
      contextStrategy,
      accessPolicy,
    };
    this.configure(docId, config);
    return config;
  }

  regenerate(suggestionId: string, requesterId: string): boolean {
    const suggestion = this.options.reviewStore.getSuggestion(suggestionId);
    if (!suggestion || suggestion.status !== 'stale' || suggestion.authorKind !== 'agent' || suggestion.threadId === undefined) return false;
    const messages = this.options.reviewStore.listMessages(suggestion.threadId);
    const latestHuman = [...messages].reverse().find((message) => this.options.store.principals().some((principal) => principal.id === message.authorId && principal.kind === 'human'));
    if (!latestHuman) return false;
    this.trigger(suggestion.threadId, suggestion.authorId, requesterId, latestHuman.body);
    return true;
  }

  handle(event: ReviewEvent): void {
    // A task's initial request is posted as the first message immediately
    // after its thread is created. Waiting for that message is important:
    // triggering from thread.created would send a generic placeholder before
    // the user's actual task text reached the agent context.
    if (event.type === 'thread.created') return;
    if (event.type !== 'message.created') return;
    const message = event.message;
    const thread = this.options.reviewStore.getThread(message.threadId);
    if (!thread) return;
    const author = this.options.store.principals().find((principal) => principal.id === message.authorId);
    if (author?.kind === 'agent') return;
    const isAgent = (id: string): boolean => this.options.store.principals().some((principal) => principal.id === id && principal.kind === 'agent');
    const mentioned = message.mentions;
    const participated = this.options.reviewStore.listMessages(thread.id).map((item) => item.authorId)
      .filter(isAgent);
    // An assigned task agent is an implicit target for every human message in
    // that task. It must be included alongside explicit mentions and agents
    // that have already participated in the thread.
    for (const agentId of agentTriggerTargets({ thread, mentioned, participated, isAgent })) {
      this.trigger(thread.id, agentId, message.authorId, message.body);
    }
  }

  private trigger(threadId: string, agentId: string, requesterId: string, triggerBody: string): void {
    const thread = this.options.reviewStore.getThread(threadId);
    const document = thread ? this.options.store.get(thread.docId) : undefined;
    const requester = this.options.store.principals().find((principal) => principal.id === requesterId);
    if (!thread || !document || !requester) return;
    const config = this.configs.get(this.key(thread.docId, agentId));
    if (!config) return;
    const agent = this.options.store.principals().find((item) => item.id === agentId);
    const requesterRole = this.options.store.role(thread.docId, requesterId) ?? 'viewer';
    if (config.accessPolicy === 'private' && requesterId !== agent?.ownerId && requesterRole !== 'owner') {
      this.postAgentMessage(threadId, agentId, '该 Agent 当前为私有模式，仅允许其所有者或文档 owner 交互。');
      this.publishStatus(agentId, threadId, 'failed', undefined, 'private agent access is restricted', 'permission');
      return;
    }
    const selection = thread.scope.type === 'range' ? (() => {
      const resolved = resolveAnchor(document.handle, thread.scope.anchor);
      return resolved.status === 'detached' ? undefined : { start: resolved.start, end: resolved.end };
    })() : undefined;
    const messages = this.options.reviewStore.listMessages(thread.id).map((item) => ({
      author: this.options.store.principals().find((principal) => principal.id === item.authorId)?.displayName ?? item.authorId,
      body: item.body,
    }));
    const previous = this.options.agentStore.get(agentId, thread.docId)?.textSnapshot;
    const context = buildContext({
      strategy: config.contextStrategy,
      documentText: document.handle.getText(),
      ...(selection === undefined ? {} : { selection }),
      messages,
      ...(previous === undefined ? {} : { previousText: previous }),
      maxChars: 12000,
    });
    const request: AgentRunRequest = {
      agentId,
      docId: thread.docId,
      threadId,
      requester,
      requesterRole,
      grantedRole: config.grantedRole,
      strategy: config.contextStrategy,
      adapter: this.adapter(thread.docId, config),
      prompt: {
        system: AGENT_SYSTEM_PROMPT,
        user: `${context.text}\n\n触发消息：${triggerBody}\n请先处理选区内的请求；如果修改会影响全文其他位置，再用 relatedEdits 提出选区之外的、能由原文直接验证的同步建议。不要直接改正文。`,
      },
      inputChars: context.inputChars,
      ...(config.adapter.type === 'cli' ? { timeoutMs: config.adapter.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS } : {}),
      allowedText: context.allowedText,
      documentText: document.handle.getText(),
      textSnapshot: document.handle.getText(),
      ...(selection === undefined ? {} : { range: selection }),
    };
    void this.dispatcher.dispatch(request).then((result) => this.applyResult(thread.id, agentId, context.allowedOffset, result)).catch(() => undefined);
  }

  private async applyResult(threadId: string, agentId: string, allowedOffset: number, result: Awaited<ReturnType<AgentRunner['run']>>): Promise<void> {
    const thread = this.options.reviewStore.getThread(threadId);
    if (!thread) return;
    const agent = this.options.store.principals().find((principal) => principal.id === agentId);
    const document = this.options.store.get(thread.docId);
    if (!agent || !document) return;
    if (result.reply) this.postAgentMessage(threadId, agentId, result.reply);
    if (result.edits.length === 0 || result.effectiveRole === 'commenter' || result.effectiveRole === 'viewer') return;
    const batch = thread.kind === 'task' && result.edits.length > 1 ? this.options.reviewService.createBatch(thread.id, agentId) : undefined;
    const batchId = batch?.ok ? batch.value.id : undefined;
    const suggestionIds: string[] = [];
    for (const edit of result.edits as LocatedEdit[]) {
      const start = typeof edit.start === 'number' && edit.start >= 0
        ? (edit.scope === 'document' ? edit.start : edit.start + allowedOffset)
        : document.handle.getText().indexOf(edit.quote);
      if (start < 0) continue;
      const end = edit.op === 'insert' ? start + edit.quote.length : (typeof edit.end === 'number' && edit.end >= 0 ? (edit.scope === 'document' ? edit.end : edit.end + allowedOffset) : start + edit.quote.length);
      const anchor = this.options.reviewService.createAnchor(thread.docId, edit.op === 'insert' ? end : start, edit.op === 'insert' ? end : end);
      if (!anchor.ok) continue;
      const suggestion = this.options.reviewService.createSuggestion({
        docId: thread.docId,
        threadId: thread.id,
        ...(batchId === undefined ? {} : { batchId }),
        authorId: agentId,
        authorKind: 'agent',
        anchor: anchor.value,
        newText: edit.op === 'delete' ? '' : edit.newText,
        ...(edit.rationale === undefined ? {} : { rationale: edit.rationale }),
        authorEffectiveRole: result.effectiveRole,
      }, undefined, agent);
      if (suggestion.ok) suggestionIds.push(suggestion.value.suggestion.id);
    }
    result.run.suggestionIds = suggestionIds;
    this.options.agentStore.save(result.run);
  }

  private postAgentMessage(threadId: string, agentId: string, body: string): void {
    const thread = this.options.reviewStore.getThread(threadId);
    if (!thread) return;
    const role = this.options.store.role(thread.docId, agentId) ?? 'commenter';
    this.options.reviewService.addMessage({ threadId, authorId: agentId, body, authorRole: role });
  }

  private publishStatus(agentId: string, threadId: string, state: AgentStatusState, range?: { start: number; end: number }, error?: string, errorKind?: AgentFailureKind): void {
    const thread = this.options.reviewStore.getThread(threadId);
    if (!thread) return;
    const record: AgentStatusRecord = { state, threadId, sequence: ++this.statusSequence, ...(error === undefined ? {} : { error }), ...(errorKind === undefined ? {} : { errorKind }) };
    this.statuses.set(`${thread.docId}:${threadId}:${agentId}`, record);
    this.options.eventBus.publish({ type: 'agent.status', docId: thread.docId, occurredAt: this.options.now(), data: { type: 'agent.status', agentId, threadId, state, ...(error === undefined ? {} : { error }), ...(errorKind === undefined ? {} : { errorKind }), ...(range === undefined ? {} : { range }) } });
  }

  private latestStatus(docId: string, agentId: string): AgentStatusRecord | undefined {
    const matches = [...this.statuses.entries()]
      .filter(([key]) => key.startsWith(`${docId}:`) && key.endsWith(`:${agentId}`))
      .map(([, value]) => value);
    return matches.reduce<AgentStatusRecord | undefined>((latest, current) => latest === undefined || current.sequence > latest.sequence ? current : latest, undefined);
  }

  private adapter(docId: string, config: AgentConfig): AgentAdapter {
    if (config.adapter.type === 'mock') return new MockAdapter();
    if (config.adapter.type === 'openai-compatible') {
      const apiKey = this.sessionApiKeys.get(this.key(docId, config.principalId)) ?? process.env[config.adapter.apiKeyEnv] ?? '';
      return new OpenAICompatibleAdapter({ baseUrl: config.adapter.baseUrl, apiKey, model: config.adapter.model }, new FetchJsonClient(apiKey));
    }
    if (config.adapter.type === 'openai-responses') {
      const responseConfig = config.adapter;
      if (responseConfig.profileId && responseConfig.ownerPrincipalId && this.options.chatgptOAuth) {
        return new OpenAIResponsesAdapter({ baseUrl: responseConfig.baseUrl, accessToken: () => this.options.chatgptOAuth!.accessToken(responseConfig.ownerPrincipalId!, responseConfig.profileId!), model: responseConfig.model }, new FetchResponsesClient());
      }
      const accessToken = this.sessionApiKeys.get(this.key(docId, config.principalId)) ?? process.env[responseConfig.accessTokenEnv] ?? '';
      return new OpenAIResponsesAdapter({ baseUrl: responseConfig.baseUrl, accessToken, model: responseConfig.model }, new FetchResponsesClient(accessToken));
    }
    return new CliAdapter(config.adapter, new ProcessCliRunner());
  }

  private startControl(timeoutMs: number): { signal: AbortSignal; timedOut: () => boolean; cancel: () => void } {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    return { signal: controller.signal, timedOut: () => timedOut, cancel: () => clearTimeout(timer) };
  }

  private key(docId: string, agentId: string): string { return `${docId}:${agentId}`; }

  private defaultConfig(principalId: string, role: Role): AgentConfig {
    return { principalId, adapter: { type: 'mock' }, grantedRole: role, contextStrategy: 'window', accessPolicy: 'public' };
  }

  private presetArgs(provider: CliPreset): string[] {
    return provider === 'codex'
      ? ['exec', '--skip-git-repo-check', '-c', 'model_reasoning_effort=medium', '-']
      : ['-p', '--output-format', 'text', '{{prompt}}'];
  }

  private loadEnvironmentConfigs(): void {
    const raw = process.env.COLLAB_AGENT_CONFIG_JSON;
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const item of parsed) {
        if (!isAgentConfig(item)) continue;
        for (const document of this.options.store.list()) {
          if (this.options.store.role(document.id, item.principalId)) this.updateConfig(document.id, item);
        }
      }
    } catch {
      // Invalid optional configuration leaves the safe mock defaults in place.
    }
  }

  private loadPersistedConfigs(): void {
    for (const document of this.options.store.list()) {
      for (const config of this.options.agentStore.listConfigs(document.id)) {
        const member = this.options.store.members(document.id).find((item) => item.id === config.principalId && item.kind === 'agent');
        if (member && !((config.adapter.type === 'openai-compatible' && config.adapter.apiKeyEnv === SESSION_API_KEY_ENV) || (config.adapter.type === 'openai-responses' && config.adapter.accessTokenEnv === SESSION_CHATGPT_TOKEN_ENV))) this.updateConfig(document.id, config);
      }
    }
  }
}
