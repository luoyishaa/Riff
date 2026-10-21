import { createAnchor, resolveAnchor, type DocumentHandle, type Role } from '@collab/kernel';
import {
  AgentDispatcher,
  AgentRunner,
  CliAdapter,
  MockAdapter,
  OpenAICompatibleAdapter,
  buildAgentPrompt,
  buildContext,
  type AgentAdapter,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentStatusEvent,
  type CliRunner,
  type HttpJsonClient,
} from '@collab/agent';
import type { ReviewEvent, ReviewService } from '@collab/review';
import type { AgentStatusEventDto, AgentSummaryDto, ModelProviderId } from '@collab/protocol';
import type { AgentSettings, AgentSettingsStore } from './agent-settings.js';
import { agentTriggerTargets } from './agent-trigger.js';
import { AgentStatusBoard } from './agent-status.js';
import type { AppEventBus } from './events.js';
import { fetchJsonClient, missingKeyClient, processCliRunner } from './agent-transports.js';
import type { AgentStore } from './infra/agent-store.js';
import type { DocumentStore } from './infra/document-store.js';
import type { ReviewStore } from './infra/review-store.js';
import { CLI_PRESETS, cliProviderForCommand, type ModelProviderRegistry } from './model-providers.js';
import { canManageAgent, canSeeAgent } from './workspace-permissions.js';

const DEFAULT_CLI_TIMEOUT_MS = 180_000;
const CONTEXT_MAX_CHARS = 12_000;

export interface AgentRuntimeOptions {
  store: DocumentStore;
  reviewStore: ReviewStore;
  reviewService: ReviewService;
  agentStore: AgentStore;
  settings: AgentSettingsStore;
  providers: ModelProviderRegistry;
  eventBus: AppEventBus;
  now: () => number;
  nextId: () => string;
  cliRunner?: CliRunner;
  httpClient?: (apiKey: string) => HttpJsonClient;
}

/** A run request plus the document snapshot the agent's offsets refer to. */
interface RuntimeRequest extends AgentRunRequest {
  snapshot: DocumentHandle;
  allowedOffset: number;
}

export class AgentRuntime {
  private readonly statuses = new AgentStatusBoard();
  private readonly dispatcher: AgentDispatcher<RuntimeRequest>;
  private readonly runner: AgentRunner;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.runner = new AgentRunner({
      clock: { now: options.now },
      ids: { next: options.nextId },
      runs: options.agentStore,
      views: options.agentStore,
      controls: { start: (timeoutMs) => startControl(timeoutMs) },
      statuses: { publish: (event) => this.publishStatus(event) },
      messages: { postFailure: (threadId, agentId, body) => this.postAgentMessage(threadId, agentId, body) },
      maxRetries: 1,
    });
    this.dispatcher = new AgentDispatcher<RuntimeRequest>({ run: (request) => this.execute(request) });
  }

  settingsFor(docId: string, agentId: string): AgentSettings {
    return this.options.settings.get(this.options.store.workspaceIdForDocument(docId), agentId);
  }

  isVisible(docId: string, agentId: string, viewerId: string): boolean {
    const agent = this.options.store.principal(agentId);
    const viewerRole = this.options.store.role(docId, viewerId);
    if (agent?.kind !== 'agent' || viewerRole === null) return false;
    return canSeeAgent(this.settingsFor(docId, agentId).accessPolicy, viewerId, agent.ownerId, viewerRole);
  }

  isVisibleInWorkspace(workspaceId: string, agentId: string, viewerId: string): boolean {
    const agent = this.options.store.principal(agentId);
    const viewerRole = this.options.store.workspaceRole(workspaceId, viewerId);
    if (agent?.kind !== 'agent' || viewerRole === null) return false;
    return canSeeAgent(this.options.settings.get(workspaceId, agentId).accessPolicy, viewerId, agent.ownerId, viewerRole);
  }

  canManage(docId: string, agentId: string, operatorId: string): boolean {
    const agent = this.options.store.principal(agentId);
    const role = this.options.store.role(docId, operatorId);
    return agent?.kind === 'agent' && role !== null && canManageAgent(role, operatorId, agent.ownerId);
  }

  summaries(docId: string, viewerId: string): AgentSummaryDto[] {
    return this.options.store.members(docId)
      .filter((member) => member.kind === 'agent' && this.isVisible(docId, member.id, viewerId))
      .map((member) => this.summary(docId, member.id, member.role, viewerId));
  }

  summary(docId: string, agentId: string, grantedRole: Role, viewerId: string): AgentSummaryDto {
    const agent = this.options.store.principal(agentId);
    const settings = this.settingsFor(docId, agentId);
    const status = this.statuses.summary(docId, agentId);
    const providerId: ModelProviderId | undefined = settings.adapter.type === 'cli'
      ? cliProviderForCommand(settings.adapter.command)
      : settings.provider?.id;
    return {
      id: agentId,
      displayName: agent?.displayName ?? agentId,
      ...(agent?.ownerId === undefined ? {} : { ownerId: agent.ownerId }),
      adapter: settings.adapter.type,
      ...(providerId === undefined ? {} : { providerId }),
      ...(settings.adapter.type === 'openai-compatible' ? { model: settings.adapter.model } : {}),
      contextStrategy: settings.contextStrategy,
      grantedRole,
      accessPolicy: settings.accessPolicy,
      ...status,
      canManage: this.canManage(docId, agentId, viewerId),
      sessionOnly: settings.provider !== undefined,
    };
  }

  /** A human message triggers mentioned agents, agents already in the thread, and a task's assignee. */
  handle(event: ReviewEvent): void {
    if (event.type !== 'message.created') return;
    const { message } = event;
    const thread = this.options.reviewStore.getThread(message.threadId);
    if (!thread || this.options.store.principal(message.authorId)?.kind !== 'human') return;
    const isAgent = (id: string): boolean => this.options.store.principal(id)?.kind === 'agent';
    const participated = this.options.reviewStore.listMessages(thread.id).map((item) => item.authorId).filter(isAgent);
    for (const agentId of agentTriggerTargets({ thread, mentioned: message.mentions, participated, isAgent })) {
      this.trigger(thread.id, agentId, message.authorId, message.body);
    }
  }

  /** Re-run the agent of a stale suggestion with the latest human request in its thread. */
  regenerate(suggestionId: string, requesterId: string): boolean {
    const suggestion = this.options.reviewStore.getSuggestion(suggestionId);
    if (!suggestion || suggestion.status !== 'stale' || suggestion.authorKind !== 'agent' || suggestion.threadId === undefined) return false;
    const latestHuman = this.options.reviewStore.listMessages(suggestion.threadId)
      .filter((message) => message.status !== 'withdrawn' && this.options.store.principal(message.authorId)?.kind === 'human')
      .at(-1);
    if (!latestHuman) return false;
    this.trigger(suggestion.threadId, suggestion.authorId, requesterId, latestHuman.body);
    return true;
  }

  removeDocument(docId: string): void {
    this.statuses.removeDocument(docId);
  }

  private trigger(threadId: string, agentId: string, requesterId: string, triggerBody: string): void {
    const { store, reviewStore } = this.options;
    const thread = reviewStore.getThread(threadId);
    const record = thread ? store.get(thread.docId) : undefined;
    const requester = store.principal(requesterId);
    const agent = store.principal(agentId);
    const grantedRole = thread ? store.role(thread.docId, agentId) : null;
    if (!thread || !record || !requester || agent?.kind !== 'agent' || grantedRole === null) return;
    const settings = this.settingsFor(thread.docId, agentId);
    const requesterRole = store.role(thread.docId, requesterId) ?? 'viewer';
    if (!canSeeAgent(settings.accessPolicy, requesterId, agent.ownerId, requesterRole)) {
      this.postAgentMessage(threadId, agentId, '该 Agent 当前为私有模式，仅允许其所有者或文档 owner 交互。');
      this.publishStatus({ type: 'agent.status', agentId, threadId, state: 'failed', error: 'private agent access is restricted', errorKind: 'permission' });
      return;
    }
    // The agent works on this snapshot; its offsets are mapped back through it.
    const snapshot = record.handle.snapshot();
    const documentText = snapshot.getText();
    const resolved = thread.scope.type === 'range' ? resolveAnchor(snapshot, thread.scope.anchor) : undefined;
    const selection = resolved && resolved.status !== 'detached' ? { start: resolved.start, end: resolved.end } : undefined;
    const messages = reviewStore.listMessages(thread.id)
      .filter((message) => message.status !== 'withdrawn')
      .map((message) => ({ author: store.principal(message.authorId)?.displayName ?? message.authorId, body: message.body }));
    const previousText = this.options.agentStore.get(agentId, thread.docId)?.textSnapshot;
    const context = buildContext({
      strategy: settings.contextStrategy,
      documentText,
      ...(selection === undefined ? {} : { selection }),
      messages,
      ...(previousText === undefined ? {} : { previousText }),
      maxChars: CONTEXT_MAX_CHARS,
    });
    const request: RuntimeRequest = {
      agentId,
      docId: thread.docId,
      threadId,
      requester,
      requesterRole,
      grantedRole,
      strategy: settings.contextStrategy,
      adapter: this.adapterFor(settings),
      prompt: buildAgentPrompt(context.text, triggerBody),
      inputChars: context.inputChars,
      ...(settings.adapter.type === 'cli' ? { timeoutMs: settings.adapter.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS } : {}),
      allowedText: context.allowedText,
      documentText,
      textSnapshot: documentText,
      ...(selection === undefined ? {} : { range: selection }),
      snapshot,
      allowedOffset: context.allowedOffset,
    };
    void this.dispatcher.dispatch(request).catch(() => undefined);
  }

  private async execute(request: RuntimeRequest): Promise<AgentRunResult> {
    const result = await this.runner.run(request);
    this.applyResult(request, result);
    return result;
  }

  private applyResult(request: RuntimeRequest, result: AgentRunResult): void {
    const thread = this.options.reviewStore.getThread(request.threadId);
    const agent = this.options.store.principal(request.agentId);
    // SPEC §7.5: a thread resolved or deleted during the run discards the result.
    if (!thread || thread.status === 'resolved' || !agent) return;
    if (result.reply) this.postAgentMessage(thread.id, request.agentId, result.reply);
    if (result.edits.length === 0) return;
    const batch = thread.kind === 'task' && result.edits.length > 1 ? this.options.reviewService.createBatch(thread.id, request.agentId) : undefined;
    const suggestionIds: string[] = [];
    for (const edit of result.edits) {
      const offset = edit.scope === 'allowed' ? request.allowedOffset : 0;
      const start = edit.op === 'insert' ? edit.end + offset : edit.start + offset;
      const end = edit.end + offset;
      let anchor;
      try { anchor = createAnchor(request.snapshot, start, end); } catch { continue; }
      const created = this.options.reviewService.createSuggestion({
        docId: thread.docId,
        threadId: thread.id,
        ...(batch?.ok ? { batchId: batch.value.id } : {}),
        authorId: request.agentId,
        authorKind: 'agent',
        anchor,
        newText: edit.op === 'delete' ? '' : edit.newText,
        ...(edit.rationale === undefined ? {} : { rationale: edit.rationale }),
        authorEffectiveRole: result.effectiveRole,
      }, undefined, agent);
      if (created.ok) suggestionIds.push(created.value.suggestion.id);
    }
    this.options.agentStore.save({ ...result.run, suggestionIds });
  }

  private adapterFor(settings: AgentSettings): AgentAdapter {
    const { adapter } = settings;
    if (adapter.type === 'mock') return new MockAdapter();
    if (adapter.type === 'openai-compatible') {
      const apiKey = settings.provider
        ? this.options.providers.credentials(settings.provider.ownerId, settings.provider.id)?.apiKey
        : adapter.apiKeyEnv === undefined ? undefined : process.env[adapter.apiKeyEnv];
      const client = apiKey ? (this.options.httpClient ?? fetchJsonClient)(apiKey) : missingKeyClient;
      return new OpenAICompatibleAdapter({ baseUrl: adapter.baseUrl, model: adapter.model }, client);
    }
    // The local CLIs always run with the current preset, so a preset fix reaches existing agents.
    const preset = cliProviderForCommand(adapter.command);
    const invocation = preset === undefined ? { command: adapter.command, args: adapter.args ?? [] } : CLI_PRESETS[preset];
    return new CliAdapter({
      ...invocation,
      ...(adapter.includeSystemInPrompt === undefined ? {} : { includeSystemInPrompt: adapter.includeSystemInPrompt }),
    }, this.options.cliRunner ?? processCliRunner);
  }

  private postAgentMessage(threadId: string, agentId: string, body: string): void {
    const thread = this.options.reviewStore.getThread(threadId);
    if (!thread) return;
    this.options.reviewService.addMessage({ threadId, authorId: agentId, body });
  }

  private publishStatus(event: AgentStatusEvent): void {
    const thread = this.options.reviewStore.getThread(event.threadId);
    if (!thread) return;
    this.statuses.record(thread.docId, event);
    const data: AgentStatusEventDto = {
      agentId: event.agentId,
      threadId: event.threadId,
      state: event.state,
      ...(event.error === undefined ? {} : { error: event.error }),
      ...(event.errorKind === undefined ? {} : { errorKind: event.errorKind }),
      ...(event.range === undefined ? {} : { range: event.range }),
    };
    this.options.eventBus.publish({ type: 'agent.status', docId: thread.docId, occurredAt: this.options.now(), data });
  }
}

function startControl(timeoutMs: number): { signal: AbortSignal; timedOut: () => boolean; cancel: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  return { signal: controller.signal, timedOut: () => timedOut, cancel: () => clearTimeout(timer) };
}
