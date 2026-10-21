import { PROMPT_SECTIONS, readPromptSection } from './prompts.js';
import type { AgentAdapter, AgentEdit } from './types.js';

const REPLACE_RULES = [/replace\s+"([^"]*)"\s+with\s+"([^"]*)"/i, /把「([^」]*)」改成「([^」]*)」/u];
const RELATED_CONTEXT_CHARS = 12;

/**
 * Deterministic adapter for tests and offline demos (SPEC §7.4). It reads the
 * latest trigger message; `replace "A" with "B"` or `把「A」改成「B」` produces a
 * replace edit for A, plus related edits for other occurrences of A in the
 * read-only consistency material. Anything else only gets an acknowledgement.
 */
export class MockAdapter implements AgentAdapter {
  readonly id = 'mock';
  async run(req: { system: string; user: string }, _opts: { signal: AbortSignal }): Promise<{ text: string }> {
    const trigger = readPromptSection(req.user, PROMPT_SECTIONS.trigger) ?? req.user;
    const match = REPLACE_RULES.map((rule) => rule.exec(trigger)).find((result) => result !== null);
    if (!match) return { text: JSON.stringify({ reply: `收到：${trigger}`, edits: [], relatedEdits: [] }) };
    const quote = match[1] ?? '';
    const newText = match[2] ?? '';
    const relatedEdits = relatedOccurrences(req.user, quote, newText);
    const note = relatedEdits.length > 0 ? `另发现 ${relatedEdits.length} 处可能需要保持一致。` : '';
    return { text: JSON.stringify({ reply: `已提出将“${quote}”改为“${newText}”。${note}`, edits: [{ op: 'replace', quote, newText }], relatedEdits }) };
  }
}

function relatedOccurrences(prompt: string, quote: string, newText: string): AgentEdit[] {
  const material = readPromptSection(prompt, PROMPT_SECTIONS.consistency);
  const selection = readPromptSection(prompt, PROMPT_SECTIONS.selection) ?? '';
  if (!material || !quote || !selection.includes(quote)) return [];
  const selectedAt = material.indexOf(selection);
  if (selectedAt < 0) return [];
  const ownOccurrence = selectedAt + selection.indexOf(quote);
  const edits: AgentEdit[] = [];
  for (let index = material.indexOf(quote); index >= 0; index = material.indexOf(quote, index + quote.length)) {
    if (index === ownOccurrence) continue;
    edits.push({
      op: 'replace',
      quote,
      newText,
      contextBefore: material.slice(Math.max(0, index - RELATED_CONTEXT_CHARS), index),
      contextAfter: material.slice(index + quote.length, index + quote.length + RELATED_CONTEXT_CHARS),
      rationale: '保持全文中相同术语或引用的一致性。',
    });
  }
  return edits;
}

export interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

export interface HttpJsonClient {
  post(url: string, body: unknown, signal: AbortSignal): Promise<ChatCompletionResponse>;
}

export class OpenAICompatibleAdapter implements AgentAdapter {
  readonly id: string;
  constructor(
    private readonly config: { baseUrl: string; model: string; id?: string },
    private readonly client: HttpJsonClient,
  ) { this.id = config.id ?? 'openai-compatible'; }
  async run(req: { system: string; user: string }, opts: { signal: AbortSignal }): Promise<{ text: string }> {
    const response = await this.client.post(`${this.config.baseUrl.replace(/\/$/u, '')}/chat/completions`, {
      model: this.config.model,
      messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
      response_format: { type: 'json_object' },
    }, opts.signal);
    const content = response.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('empty adapter response');
    return { text: content };
  }
}

export interface CliRunner {
  /** Run the command; `stdin` is written and closed when provided. Resolves with stdout. */
  run(config: { command: string; args: string[] }, stdin: string | undefined, signal: AbortSignal): Promise<string>;
}

const PROMPT_PLACEHOLDER = '{{prompt}}';

/**
 * Command-line agents have no separate system channel, so the system prompt is
 * sent with the user prompt unless disabled. The prompt goes into the argument
 * that holds `{{prompt}}`; without a placeholder it is written to stdin, which
 * also avoids command-line length and newline limits on Windows.
 */
export class CliAdapter implements AgentAdapter {
  readonly id: string;
  private readonly args: string[];
  constructor(
    private readonly config: { command: string; args?: string[]; id?: string; includeSystemInPrompt?: boolean },
    private readonly runner: CliRunner,
  ) { this.id = config.id ?? 'cli'; this.args = config.args ? [...config.args] : []; }
  async run(req: { system: string; user: string }, opts: { signal: AbortSignal }): Promise<{ text: string }> {
    const prompt = this.config.includeSystemInPrompt === false ? req.user : `${req.system}\n\n${req.user}`;
    const usesPlaceholder = this.args.some((arg) => arg.includes(PROMPT_PLACEHOLDER));
    const args = usesPlaceholder ? this.args.map((arg) => arg.replaceAll(PROMPT_PLACEHOLDER, prompt)) : this.args;
    return { text: await this.runner.run({ command: this.config.command, args }, usesPlaceholder ? undefined : prompt, opts.signal) };
  }
}
