import { describe, expect, it } from 'vitest';
import { AgentDispatcher, AgentRunner, MockAdapter, OpenAIResponsesAdapter, buildContext, classifyAgentFailure, effectiveRole, parseAgentOutput, validateEdits, validateRelatedEdits, MemoryAgentRunRepository } from '../src/index.js';

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

  it('does not echo the full context when a request has no deterministic edit rule', async () => {
    const result = await new MockAdapter().run({ system: '', user: '选区：内部草稿\n\n线程：旧讨论\n\n触发消息：请扩展这句话' }, { signal: new AbortController().signal });
    expect(result.text).toContain('收到：请扩展这句话');
    expect(result.text).not.toContain('内部草稿');
    expect(result.text).not.toContain('旧讨论');
  });

  it('rejects edits that remove Markdown structure markers', () => {
    const cases = [
      { name: 'heading', quote: '# 标题', newText: '标题' },
      { name: 'list', quote: '- 列表项', newText: '列表项' },
      { name: 'fenced code', quote: '```ts\nconst value = 1;\n```', newText: 'const value = 2;' },
      { name: 'blockquote', quote: '> 引用内容', newText: '引用内容' },
      { name: 'table', quote: '| A | B |\n| --- | --- |', newText: 'A 和 B' },
      { name: 'thematic break', quote: '---', newText: '' },
    ];
    for (const testCase of cases) {
      const parsed = parseAgentOutput(JSON.stringify({ reply: 'ok', edits: [{ op: 'replace', quote: testCase.quote, newText: testCase.newText }] }));
      expect(parsed.ok, testCase.name).toBe(true);
      if (!parsed.ok) continue;
      expect(validateEdits(parsed.value, testCase.quote).rejected, testCase.name).toContainEqual({ index: 0, reason: 'structure' });
    }
    const deleteOutput = parseAgentOutput(JSON.stringify({ reply: 'ok', edits: [{ op: 'delete', quote: '- 保留列表结构' }] }));
    expect(deleteOutput.ok).toBe(true);
    if (deleteOutput.ok) expect(validateEdits(deleteOutput.value, '- 保留列表结构').rejected).toContainEqual({ index: 0, reason: 'structure' });
  });

  it('allows content changes that keep Markdown structure markers', () => {
    const quote = '# 新标题\n\n- 原列表项\n\n> 原引用\n\n```ts\nconst value = 1;\n```\n\n| A | B |\n| --- | --- |';
    const newText = '# 更新标题\n\n- 更新列表项\n\n> 更新引用\n\n```ts\nconst value = 2;\n```\n\n| C | D |\n| --- | --- |';
    const parsed = parseAgentOutput(JSON.stringify({ reply: 'ok', edits: [{ op: 'replace', quote, newText }] }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(validateEdits(parsed.value, quote).edits).toHaveLength(1);
  });
});

describe('context', () => {
  it('includes selection, thread and truncation marker', () => {
    const context = buildContext({ strategy: 'window', documentText: 'A paragraph.\n\nB paragraph.', selection: { start: 0, end: 1 }, messages: [{ author: 'Alice', body: 'Review' }], maxChars: 30 });
    expect(context.allowedText).toBe('A');
    expect(context.text).toContain('截断');
  });

  it('includes read-only full text for consistency checks while keeping the selected text as the edit boundary', () => {
    const context = buildContext({ strategy: 'window', documentText: 'Term appears here.\n\nAnother paragraph repeats Term.', selection: { start: 0, end: 4 }, messages: [], maxChars: 500 });
    expect(context.text).toContain('全文一致性检查素材（只读）：');
    expect(context.allowedText).toBe('Term');
    expect(context.allowedOffset).toBe(0);
  });

  it('keeps the review thread visible when a long document is truncated', () => {
    const documentText = `Selected sentence.\n\n${'A long supporting paragraph. '.repeat(80)}`;
    const context = buildContext({
      strategy: 'window',
      documentText,
      selection: { start: 0, end: 8 },
      messages: [{ author: 'Alice', body: '请保留这条讨论里的约束' }],
      maxChars: 180,
    });
    expect(context.text).toContain('线程：');
    expect(context.text).toContain('请保留这条讨论里的约束');
    expect(context.text).toContain('截断');
  });

  it('validates related edits against the full document instead of widening the selected edit boundary', async () => {
    const documentText = 'Term appears here.\n\nAnother paragraph repeats Term.';
    const context = buildContext({ strategy: 'window', documentText, selection: { start: 0, end: 4 }, messages: [], maxChars: 500 });
    const adapter = new MockAdapter();
    const response = await adapter.run({ system: '', user: `${context.text}\n\n触发消息：replace "Term" with "Label"` }, { signal: new AbortController().signal });
    const parsed = parseAgentOutput(response.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(validateEdits(parsed.value, context.allowedText).edits).toHaveLength(1);
    expect(validateRelatedEdits(parsed.value, documentText).edits).toHaveLength(1);
    expect(validateRelatedEdits(parsed.value, documentText).edits[0]?.scope).toBe('document');
  });
});

describe('Responses API adapter', () => {
  it('posts instructions and input to /responses and reads output_text', async () => {
    let request: { url: string; body: unknown; accessToken?: string } | undefined;
    const adapter = new OpenAIResponsesAdapter(
      { baseUrl: 'https://api.openai.com/v1', accessToken: 'oauth-token', model: 'gpt-plan' },
      { post: async (url, body, _signal, accessToken) => {
        request = { url, body, accessToken };
        return { output_text: '{"reply":"ok","edits":[]}' };
      } },
    );
    const result = await adapter.run({ system: 'system', user: 'user' }, { signal: new AbortController().signal });
    expect(result.text).toBe('{"reply":"ok","edits":[]}');
    expect(request?.url).toBe('https://api.openai.com/v1/responses');
    expect(request?.accessToken).toBe('oauth-token');
    expect(request?.body).toEqual({
      model: 'gpt-plan',
      instructions: 'system',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'user' }] }],
      text: { format: { type: 'json_object' } },
      store: false,
      stream: true,
    });
  });

  it('extracts output_text from the Responses message content envelope', async () => {
    const adapter = new OpenAIResponsesAdapter(
      { baseUrl: 'https://example.test/v1', accessToken: 'oauth-token', model: 'gpt-plan' },
      { post: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'response body' }] }] }) },
    );
    await expect(adapter.run({ system: '', user: '' }, { signal: new AbortController().signal })).resolves.toEqual({ text: 'response body' });
  });
});

describe('runner and dispatcher', () => {
  it('classifies provider failures and publishes the category with the failed status', async () => {
    expect(classifyAgentFailure('agent HTTP 401: invalid token')).toBe('authentication');
    const statuses: Array<{ state: string; errorKind?: string }> = [];
    const runs = new MemoryAgentRunRepository();
    const runner = new AgentRunner({
      clock: { now: () => 100 }, ids: { next: () => 'run-failed' }, runs,
      controls: { start: () => ({ signal: new AbortController().signal, timedOut: () => false, cancel: () => undefined }) },
      statuses: { publish: (event) => statuses.push({ state: event.state, errorKind: event.errorKind }) },
    });
    await runner.run({
      agentId: 'agent', docId: 'doc', threadId: 'thread', requester: { id: 'alice', kind: 'human', displayName: 'Alice' }, requesterRole: 'editor', grantedRole: 'editor', strategy: 'selection',
      adapter: { id: 'failing', run: async () => { throw new Error('agent HTTP 401: invalid token'); } }, prompt: { system: '', user: 'run' }, inputChars: 3,
    });
    expect(statuses).toEqual([{ state: 'working' }, { state: 'failed', errorKind: 'authentication' }]);
  });

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

  it('explains when an otherwise valid agent edit is outside the allowed selection', async () => {
    const runs = new MemoryAgentRunRepository();
    const runner = new AgentRunner({
      clock: { now: () => 100 }, ids: { next: () => 'run-invalid-selection' }, runs,
      controls: { start: () => ({ signal: new AbortController().signal, timedOut: () => false, cancel: () => undefined }) },
    });
    const result = await runner.run({
      agentId: 'agent', docId: 'doc', threadId: 'thread',
      requester: { id: 'alice', kind: 'human', displayName: 'Alice' }, requesterRole: 'editor', grantedRole: 'editor',
      strategy: 'selection', adapter: { id: 'test', run: async () => ({ text: JSON.stringify({ reply: '已完成扩展。', edits: [{ op: 'replace', quote: 'B', newText: 'C' }] }) }) },
      prompt: { system: '', user: 'expand' }, inputChars: 20, allowedText: 'A',
    });
    expect(result.edits).toHaveLength(0);
    expect(result.reply).toContain('未生成可审批修改建议');
  });

  it('explains when a proposed edit would remove Markdown structure', async () => {
    const runs = new MemoryAgentRunRepository();
    const runner = new AgentRunner({
      clock: { now: () => 100 }, ids: { next: () => 'run-structure' }, runs,
      controls: { start: () => ({ signal: new AbortController().signal, timedOut: () => false, cancel: () => undefined }) },
    });
    const result = await runner.run({
      agentId: 'agent', docId: 'doc', threadId: 'thread',
      requester: { id: 'alice', kind: 'human', displayName: 'Alice' }, requesterRole: 'editor', grantedRole: 'editor',
      strategy: 'selection', adapter: { id: 'test', run: async () => ({ text: JSON.stringify({ reply: '我来修改标题。', edits: [{ op: 'replace', quote: '# 标题', newText: '标题' }] }) }) },
      prompt: { system: '', user: 'rewrite' }, inputChars: 20, allowedText: '# 标题',
    });
    expect(result.edits).toHaveLength(0);
    expect(result.reply).toContain('Markdown 结构');
    expect(result.reply).toContain('请保留对应结构标记');
  });

  it('returns selected and cross-document consistency suggestions as separate validated edits', async () => {
    const runs = new MemoryAgentRunRepository();
    const documentText = 'Term appears here.\n\nAnother paragraph repeats Term.';
    const context = buildContext({ strategy: 'window', documentText, selection: { start: 0, end: 4 }, messages: [], maxChars: 500 });
    const runner = new AgentRunner({
      clock: { now: () => 100 }, ids: { next: () => 'run-related' }, runs,
      controls: { start: () => ({ signal: new AbortController().signal, timedOut: () => false, cancel: () => undefined }) },
    });
    const result = await runner.run({
      agentId: 'agent', docId: 'doc', threadId: 'thread', requester: { id: 'alice', kind: 'human', displayName: 'Alice' }, requesterRole: 'editor', grantedRole: 'editor', strategy: 'window', adapter: new MockAdapter(),
      prompt: { system: '', user: `${context.text}\n\n触发消息：replace "Term" with "Label"` }, inputChars: context.inputChars, allowedText: context.allowedText, documentText, range: { start: 0, end: 4 },
    });
    expect(result.edits).toHaveLength(2);
    expect((result.edits[0] as { scope?: string }).scope).toBe('allowed');
    expect((result.edits[1] as { scope?: string }).scope).toBe('document');
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
