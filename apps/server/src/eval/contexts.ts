import {
  AgentRunner,
  MemoryAgentRunRepository,
  MockAdapter,
  buildAgentPrompt,
  buildContext,
  type AgentAdapter,
  type AgentStrategy,
} from '@collab/agent';
import { z } from 'zod';

/**
 * SPEC §12 `eval:contexts`: every task runs once per context strategy through
 * the real context builder, prompt, runner and output validation. Without
 * `rawOutputs` the mock adapter answers; with them, attempt n returns
 * rawOutputs[n] so retry behaviour can be measured on recorded model output.
 */
export const STRATEGIES: readonly AgentStrategy[] = ['selection', 'window', 'full'];

const taskSchema = z.object({
  id: z.string().min(1).optional(),
  document: z.string(),
  selection: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).optional(),
  messages: z.array(z.object({ author: z.string(), body: z.string() })).default([]),
  previousText: z.string().optional(),
  maxChars: z.number().int().positive().default(4000),
  windowParagraphs: z.number().int().nonnegative().optional(),
  rawOutputs: z.array(z.string()).min(1).optional(),
});
export const tasksetSchema = z.union([z.array(taskSchema), z.object({ tasks: z.array(taskSchema) }).transform((value) => value.tasks)]);
export type ContextTask = z.infer<typeof taskSchema>;

export interface ContextEvalRow {
  strategy: AgentStrategy;
  task: string;
  validity: 'valid' | 'invalid';
  retries: number;
  latency: number;
  inputChars: number;
  suggestionCount: number;
}

function scriptedAdapter(outputs: string[]): AgentAdapter {
  let attempt = 0;
  return { id: 'recorded', run: async () => ({ text: outputs[Math.min(attempt++, outputs.length - 1)] ?? '' }) };
}

export async function evaluateContexts(tasks: ContextTask[], now: () => number): Promise<ContextEvalRow[]> {
  const rows: ContextEvalRow[] = [];
  for (const [index, task] of tasks.entries()) {
    const taskId = task.id ?? `task-${index + 1}`;
    const selection = task.selection && task.selection.end <= task.document.length && task.selection.start <= task.selection.end ? task.selection : undefined;
    for (const strategy of STRATEGIES) {
      const context = buildContext({
        strategy,
        documentText: task.document,
        ...(selection === undefined ? {} : { selection }),
        messages: task.messages,
        ...(task.previousText === undefined ? {} : { previousText: task.previousText }),
        maxChars: task.maxChars,
        ...(task.windowParagraphs === undefined ? {} : { windowParagraphs: task.windowParagraphs }),
      });
      const runner = new AgentRunner({
        clock: { now },
        ids: { next: () => `${taskId}-${strategy}` },
        runs: new MemoryAgentRunRepository(),
        controls: { start: () => ({ signal: new AbortController().signal, timedOut: () => false, cancel: () => undefined }) },
        maxRetries: 1,
      });
      const result = await runner.run({
        agentId: 'eval-agent',
        docId: taskId,
        threadId: taskId,
        requester: { id: 'eval', kind: 'human', displayName: 'Eval' },
        requesterRole: 'editor',
        grantedRole: 'editor',
        strategy,
        adapter: task.rawOutputs ? scriptedAdapter(task.rawOutputs) : new MockAdapter(),
        prompt: buildAgentPrompt(context.text, task.messages.at(-1)?.body ?? ''),
        inputChars: context.inputChars,
        allowedText: context.allowedText,
        documentText: task.document,
        ...(selection === undefined ? {} : { range: selection }),
      });
      rows.push({
        strategy,
        task: taskId,
        validity: result.run.outputValid ? 'valid' : 'invalid',
        retries: result.run.retries,
        latency: Math.round(result.run.durationMs),
        inputChars: result.run.inputChars,
        suggestionCount: result.edits.length,
      });
    }
  }
  return rows;
}

export function contextRowsToCsv(rows: ContextEvalRow[]): string {
  const header = ['strategy', 'task', 'validity', 'retries', 'latency', 'inputChars', 'suggestionCount'] as const;
  const cell = (value: string | number): string => {
    const text = String(value);
    return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `${[header.join(','), ...rows.map((row) => header.map((key) => cell(row[key])).join(','))].join('\n')}\n`;
}
