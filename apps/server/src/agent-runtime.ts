import { spawn } from 'node:child_process';
import { resolveAnchor, type Role } from '@collab/kernel';
import {
  AgentDispatcher,
  AgentRunner,
  CliAdapter,
  MockAdapter,
  OpenAICompatibleAdapter,
  buildContext,
  type AgentAdapter,
  type AgentConfig,
  type AgentRunRequest,
  type AgentStatusState,
  type ChatCompletionResponse,
  type CliRunner,
  type HttpJsonClient,
  type LocatedEdit,
} from '@collab/agent';
import { ReviewService, type ReviewEvent } from '@collab/review';
import { AppEventBus } from './events.js';
import { AgentStore } from './infra/agent-store.js';
import { DocumentStore } from './infra/document-store.js';
import { ReviewStore } from './infra/review-store.js';

interface AgentRuntimeOptions {
  store: DocumentStore;
  reviewStore: ReviewStore;
  reviewService: ReviewService;
  agentStore: AgentStore;
  eventBus: AppEventBus;
  now: () => number;
  nextId: () => string;
}

interface AgentListItem {
  id: string;
  displayName: string;
  adapter: string;
  contextStrategy: AgentConfig['contextStrategy'];
  grantedRole: Role;
  status: AgentStatusState | 'idle';
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

class ProcessCliRunner implements CliRunner {
  run(config: { command: string; args: string[] }, input: { system: string; user: string }, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(config.command, config.args, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      const abort = (): void => { child.kill(); reject(new Error('agent process aborted')); };
      signal.addEventListener('abort', abort, { once: true });
      child.on('error', (error) => { signal.removeEventListener('abort', abort); reject(error); });
      child.on('close', (code) => {
        signal.removeEventListener('abort', abort);
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `agent process exited with ${code ?? 'unknown status'}`));
      });
      child.stdin.write(`${input.system}\n\n${input.user}`);
      child.stdin.end();
    });
  }
}

export class AgentRuntime {
  private readonly configs = new Map<string, AgentConfig>();
  private readonly statuses = new Map<string, AgentStatusState>();
  private readonly dispatcher: AgentDispatcher;
  private readonly runner: AgentRunner;

  constructor(private readonly options: AgentRuntimeOptions) {
    for (const principal of options.store.principals().filter((item) => item.kind === 'agent')) {
      for (const document of options.store.list()) {
        const role = options.store.role(document.id, principal.id) ?? 'suggester';
        this.configs.set(this.key(document.id, principal.id), { principalId: principal.id, adapter: { type: 'mock' }, grantedRole: role, contextStrategy: 'window' });
      }
    }
    this.runner = new AgentRunner({
      clock: { now: options.now },
      ids: { next: options.nextId },
      runs: options.agentStore,
      views: options.agentStore,
      controls: { start: (timeoutMs) => this.startControl(timeoutMs) },
      statuses: { publish: (event) => this.publishStatus(event.agentId, event.threadId, event.state, event.range) },
      messages: { postFailure: (threadId, agentId, body) => this.postAgentMessage(threadId, agentId, body) },
      maxRetries: 1,
    });
    this.dispatcher = new AgentDispatcher(this.runner);
  }

  list(docId: string): AgentListItem[] {
    return this.options.store.members(docId).filter((member) => member.kind === 'agent').map((member) => {
      const config = this.configs.get(this.key(docId, member.id));
      return {
        id: member.id,
        displayName: member.displayName,
        adapter: config?.adapter.type ?? 'mock',
        contextStrategy: config?.contextStrategy ?? 'window',
        grantedRole: config?.grantedRole ?? member.role,
        status: [...this.statuses.entries()].find(([key]) => key.startsWith(`${docId}:`) && key.endsWith(`:${member.id}`))?.[1] ?? 'idle',
      };
    });
  }

  updateConfig(docId: string, config: AgentConfig): void { this.configs.set(this.key(docId, config.principalId), config); }

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
    if (event.type !== 'message.created') return;
    const message = event.message;
    const thread = this.options.reviewStore.getThread(message.threadId);
    if (!thread) return;
    const author = this.options.store.principals().find((principal) => principal.id === message.authorId);
    if (author?.kind === 'agent') return;
    const mentioned = message.mentions.filter((id) => this.options.store.principals().some((principal) => principal.id === id && principal.kind === 'agent'));
    const participated = this.options.reviewStore.listMessages(thread.id).map((item) => item.authorId)
      .filter((id) => this.options.store.principals().some((principal) => principal.id === id && principal.kind === 'agent'));
    for (const agentId of new Set([...mentioned, ...participated])) this.trigger(thread.id, agentId, message.authorId, message.body);
  }

  private trigger(threadId: string, agentId: string, requesterId: string, triggerBody: string): void {
    const thread = this.options.reviewStore.getThread(threadId);
    const document = thread ? this.options.store.get(thread.docId) : undefined;
    const requester = this.options.store.principals().find((principal) => principal.id === requesterId);
    if (!thread || !document || !requester) return;
    const config = this.configs.get(this.key(thread.docId, agentId));
    if (!config) return;
    const requesterRole = this.options.store.role(thread.docId, requesterId) ?? 'viewer';
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
      adapter: this.adapter(config),
      prompt: {
        system: '你是协作写作助手。请只返回一个 JSON 对象，包含 reply 和 edits；最小修改，保持原文语言。',
        user: `${context.text}\n\n触发消息：${triggerBody}\n请根据允许区域提出修改。`,
      },
      inputChars: context.inputChars,
      allowedText: context.allowedText,
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
      const start = typeof edit.start === 'number' ? edit.start + allowedOffset : document.handle.getText().indexOf(edit.quote);
      if (start < 0) continue;
      const end = edit.op === 'insert' ? start + edit.quote.length : (typeof edit.end === 'number' ? edit.end + allowedOffset : start + edit.quote.length);
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

  private publishStatus(agentId: string, threadId: string, state: AgentStatusState, range?: { start: number; end: number }): void {
    const thread = this.options.reviewStore.getThread(threadId);
    if (!thread) return;
    this.statuses.set(`${thread.docId}:${threadId}:${agentId}`, state);
    this.options.eventBus.publish({ type: 'agent.status', docId: thread.docId, occurredAt: this.options.now(), data: { type: 'agent.status', agentId, threadId, state, ...(range === undefined ? {} : { range }) } });
  }

  private adapter(config: AgentConfig): AgentAdapter {
    if (config.adapter.type === 'mock') return new MockAdapter();
    if (config.adapter.type === 'openai-compatible') {
      const apiKey = process.env[config.adapter.apiKeyEnv] ?? '';
      return new OpenAICompatibleAdapter({ baseUrl: config.adapter.baseUrl, apiKey, model: config.adapter.model }, new FetchJsonClient(apiKey));
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
}
