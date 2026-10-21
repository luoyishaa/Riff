import { describe, expect, it, vi } from 'vitest';
import { randomId, resolveAnchor, systemClock } from '@collab/kernel';
import { ReviewService, type ReviewEvent } from '@collab/review';
import type { CliRunner } from '@collab/agent';
import { AgentRuntime } from '../src/agent-runtime.js';
import { AgentSettingsStore, type AgentSettings } from '../src/agent-settings.js';
import { AppEventBus } from '../src/events.js';
import { AgentStore } from '../src/infra/agent-store.js';
import { DocumentStore } from '../src/infra/document-store.js';
import { ReviewStore } from '../src/infra/review-store.js';
import { ModelProviderRegistry } from '../src/model-providers.js';

/** A command-line agent whose answer the test releases after editing the document. */
class GatedRunner implements CliRunner {
  calls = 0;
  private release: ((output: string) => void) | undefined;
  run(): Promise<string> {
    this.calls += 1;
    return new Promise((resolve) => { this.release = resolve; });
  }
  answer(output: unknown): void {
    this.release?.(JSON.stringify(output));
  }
}

function setup(agentSettings: AgentSettings, runner?: CliRunner) {
  const store = new DocumentStore(':memory:');
  const reviewStore = new ReviewStore(store.db);
  const agentStore = new AgentStore(store.db);
  store.upsertPrincipal({ id: 'alice', kind: 'human', displayName: 'Alice' });
  store.upsertPrincipal({ id: 'bot', kind: 'agent', displayName: 'Bot', ownerId: 'alice' });
  const workspace = store.createWorkspace('space-1', 'Space', 'alice', 1);
  store.setWorkspaceMembership({ workspaceId: workspace.id, principalId: 'bot', role: 'editor' });
  const doc = store.create('doc-1', 'Draft', 'Hello world. Second sentence.', [], workspace.id);
  const listeners: Array<(event: ReviewEvent) => void> = [];
  const reviewService = new ReviewService({
    clock: systemClock, ids: randomId, repository: reviewStore,
    documents: { getDocument: (id) => store.get(id)?.handle },
    emit: (event) => listeners.forEach((listener) => listener(event)),
  });
  const runtime = new AgentRuntime({
    store, reviewStore, reviewService, agentStore,
    settings: new AgentSettingsStore(agentStore, new Map([['bot', agentSettings]]), () => 1),
    providers: new ModelProviderRegistry({ inspectCli: async () => [] }),
    eventBus: new AppEventBus(),
    now: () => Date.now(),
    nextId: () => randomId.next(),
    ...(runner === undefined ? {} : { cliRunner: runner }),
  });
  listeners.push((event) => runtime.handle(event));
  const ask = (start: number, end: number, body: string) => {
    const anchor = reviewService.createAnchor(doc.id, start, end);
    if (!anchor.ok) throw new Error(anchor.error);
    const thread = reviewService.createThread({ docId: doc.id, scope: { type: 'range', anchor: anchor.value }, kind: 'discussion', createdBy: 'alice', createdByRole: 'owner' });
    if (!thread.ok) throw new Error(thread.error);
    reviewService.addMessage({ threadId: thread.value.id, authorId: 'alice', body, mentions: ['bot'], authorRole: 'owner' });
    return thread.value;
  };
  return { store, reviewStore, reviewService, runtime, doc, ask };
}

const cliSettings: AgentSettings = { adapter: { type: 'cli', command: 'test-agent' }, contextStrategy: 'window', accessPolicy: 'public' };

describe('agent runtime', () => {
  it('turns an @mention into a pending suggestion that updates the text when accepted', async () => {
    const { reviewStore, reviewService, doc, ask } = setup({ adapter: { type: 'mock' }, contextStrategy: 'window', accessPolicy: 'public' });
    const thread = ask(6, 11, '@Bot 把「world」改成「there」');
    await vi.waitFor(() => expect(reviewStore.listSuggestions(doc.id)).toHaveLength(1));
    const [suggestion] = reviewStore.listSuggestions(doc.id);
    expect(suggestion).toMatchObject({ status: 'pending', newText: 'there', threadId: thread.id, authorKind: 'agent' });
    expect(reviewStore.listMessages(thread.id).map((message) => message.authorId)).toEqual(['alice', 'bot']);
    expect(reviewService.acceptSuggestion(doc.id, suggestion?.id ?? '', 'alice', 'owner').ok).toBe(true);
    expect(doc.handle.getText()).toBe('Hello there. Second sentence.');
  });

  it('anchors edits to the text the agent saw when others typed elsewhere during the run', async () => {
    const runner = new GatedRunner();
    const { reviewStore, doc, ask } = setup(cliSettings, runner);
    ask(6, 11, '@Bot tighten this');
    await vi.waitFor(() => expect(runner.calls).toBe(1));
    doc.handle.replace(0, 0, 'Intro. ');
    runner.answer({ reply: 'ok', edits: [{ op: 'replace', quote: 'world', newText: 'there' }] });
    await vi.waitFor(() => expect(reviewStore.listSuggestions(doc.id)).toHaveLength(1));
    const [suggestion] = reviewStore.listSuggestions(doc.id);
    expect(suggestion?.status).toBe('pending');
    const resolved = suggestion ? resolveAnchor(doc.handle, suggestion.anchor) : undefined;
    expect(resolved?.status === 'exact' && doc.handle.getText().slice(resolved.start, resolved.end)).toBe('world');
  });

  it('marks the suggestion stale when someone rewrote the quoted text during the run', async () => {
    const runner = new GatedRunner();
    const { reviewStore, doc, ask } = setup(cliSettings, runner);
    ask(6, 11, '@Bot tighten this');
    await vi.waitFor(() => expect(runner.calls).toBe(1));
    doc.handle.replace(6, 11, 'earth');
    runner.answer({ reply: 'ok', edits: [{ op: 'replace', quote: 'world', newText: 'there' }] });
    await vi.waitFor(() => expect(reviewStore.listSuggestions(doc.id)).toHaveLength(1));
    expect(reviewStore.listSuggestions(doc.id)[0]?.status).toBe('stale');
    expect(doc.handle.getText()).toBe('Hello earth. Second sentence.');
  });

  it('regenerates a stale agent suggestion, also after it was read back from the database', async () => {
    const runner = new GatedRunner();
    const { reviewStore, runtime, doc, ask } = setup(cliSettings, runner);
    ask(6, 11, '@Bot tighten this');
    await vi.waitFor(() => expect(runner.calls).toBe(1));
    doc.handle.replace(6, 11, 'earth');
    runner.answer({ reply: 'ok', edits: [{ op: 'replace', quote: 'world', newText: 'there' }] });
    await vi.waitFor(() => expect(reviewStore.listSuggestions(doc.id)[0]?.status).toBe('stale'));
    const stale = reviewStore.listSuggestions(doc.id)[0];
    expect(stale?.authorKind).toBe('agent');
    expect(runtime.regenerate(stale?.id ?? '', 'alice')).toBe(true);
    await vi.waitFor(() => expect(runner.calls).toBe(2));
  });

  it('runs with the role the agent holds as a member, which the members dialog edits', async () => {
    const { store, reviewStore, doc, ask } = setup({ adapter: { type: 'mock' }, contextStrategy: 'window', accessPolicy: 'public' });
    store.updateWorkspaceMemberRole('space-1', 'bot', 'commenter');
    const thread = ask(6, 11, '@Bot 把「world」改成「there」');
    await vi.waitFor(() => expect(reviewStore.listMessages(thread.id)).toHaveLength(2));
    expect(reviewStore.listSuggestions(doc.id)).toHaveLength(0);
    expect(reviewStore.listMessages(thread.id)[1]?.body).toContain('只允许回复');
  });
});
