import { describe, expect, it } from 'vitest';
import { AgentDispatcher, AgentRunner, MockAdapter, buildContext, effectiveRole, parseAgentOutput, validateEdits, MemoryAgentRunRepository } from '../src/index.js';

describe('agent protocol', () => {
  it('extracts JSON from fenced output and validates unique edits', () => {
    const parsed = parseAgentOutput('```json\n{"reply":"ok","edits":[{"op":"replace","quote":"A","newText":"B"}]}\n```');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(validateEdits(parsed.value, 'A').edits[0]?.newText).toBe('B');
    expect(validateEdits(parsed.value, 'A A').rejected[0]?.reason).toBe('ambiguous');
  });

  it('uses the lower effective role and deterministic mock rules', async () => {
    expect(effectiveRole('editor', 'commenter')).toBe('commenter');
    const result = await new MockAdapter().run({ system: '', user: 'replace "A" with "B"' }, { signal: new AbortController().signal });
    expect(parseAgentOutput(result.text).ok).toBe(true);
  });

  it('uses the latest trigger when context contains older edit requests', async () => {
    const result = await new MockAdapter().run({ system: '', user: '线程：把「A」改成「B」\n触发消息：把「B」改成「C」' }, { signal: new AbortController().signal });
    expect(result.text).toContain('"quote":"B"');
    expect(result.text).toContain('"newText":"C"');
  });
});

describe('context', () => {
  it('includes selection, thread and truncation marker', () => {
    const context = buildContext({ strategy: 'window', documentText: 'A paragraph.\n\nB paragraph.', selection: { start: 0, end: 1 }, messages: [{ author: 'Alice', body: 'Review' }], maxChars: 30 });
    expect(context.allowedText).toBe('A');
    expect(context.text).toContain('截断');
  });
});

describe('runner and dispatcher', () => {
  it('records a run and drops edits for commenter effective role', async () => {
    const runs = new MemoryAgentRunRepository();
    const runner = new AgentRunner({
      clock: { now: () => 100 }, ids: { next: () => 'run-1' }, runs,
      controls: { start: () => ({ signal: new AbortController().signal, timedOut: () => false, cancel: () => undefined }) },
    });
    const result = await runner.run({ agentId: 'agent', docId: 'doc', threadId: 'thread', requester: { id: 'dan', kind: 'human', displayName: 'Dan' }, requesterRole: 'commenter', grantedRole: 'editor', strategy: 'selection', adapter: new MockAdapter(), prompt: { system: '', user: 'replace "A" with "B"' }, inputChars: 20, allowedText: 'A' });
    expect(result.effectiveRole).toBe('commenter');
    expect(result.edits).toHaveLength(0);
    expect(runs.runs).toHaveLength(1);
  });

  it('queues only the latest trigger while one pair is active', async () => {
    let release: (() => void) | undefined;
    const executor = { run: async (request: Parameters<AgentDispatcher['dispatch']>[0]) => {
      if (request.prompt.user === 'first') await new Promise<void>((resolve) => { release = resolve; });
      return { run: { id: request.prompt.user, agentId: request.agentId, docId: request.docId, threadId: request.threadId, requesterId: request.requester.id, strategy: request.strategy, startedAt: 0, durationMs: 0, inputChars: 0, outputValid: true, retries: 0, suggestionIds: [] }, edits: [], effectiveRole: 'editor' as const };
    } };
    const dispatcher = new AgentDispatcher(executor);
    const base = { agentId: 'a', docId: 'd', threadId: 't', requester: { id: 'u', kind: 'human' as const, displayName: 'U' }, requesterRole: 'editor' as const, grantedRole: 'editor' as const, strategy: 'selection' as const, adapter: new MockAdapter(), prompt: { system: '', user: 'first' }, inputChars: 0 };
    const first = dispatcher.dispatch(base);
    const queued = dispatcher.dispatch({ ...base, prompt: { system: '', user: 'second' } });
    release?.();
    await first;
    expect((await queued).run.id).toBe('second');
  });
});
