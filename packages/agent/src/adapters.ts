import type { AgentAdapter } from './types.js';

export class MockAdapter implements AgentAdapter {
  readonly id = 'mock';
  async run(req: { system: string; user: string }, _opts: { signal: AbortSignal }): Promise<{ text: string }> {
    const trigger = req.user.includes('触发消息：') ? req.user.slice(req.user.lastIndexOf('触发消息：') + '触发消息：'.length) : req.user;
    const english = /replace\s+"([^"]*)"\s+with\s+"([^"]*)"/i.exec(trigger);
    const chinese = /把「([^」]*)」改成「([^」]*)」/.exec(trigger);
    const match = english ?? chinese;
    if (!match) return { text: JSON.stringify({ reply: `收到：${trigger}`, edits: [] }) };
    const quote = match[1] ?? '';
    const newText = match[2] ?? '';
    return { text: JSON.stringify({ reply: `已提出将“${quote}”改为“${newText}”。`, edits: [{ op: 'replace', quote, newText }] }) };
  }
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
    private readonly config: { baseUrl: string; apiKey: string; model: string; id?: string },
    private readonly client: HttpJsonClient,
  ) { this.id = config.id ?? 'openai-compatible'; }
  async run(req: { system: string; user: string }, opts: { signal: AbortSignal }): Promise<{ text: string }> {
    const response = await this.client.post(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      model: this.config.model,
      messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
      response_format: { type: 'json_object' },
    }, opts.signal);
    const content = response.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('empty adapter response');
    return { text: content };
  }
}

/**
 * The Responses API has a different response envelope from chat/completions.
 * Keep this transport separate so a ChatGPT-plan OAuth token is only sent to
 * the Responses endpoint and is never treated as an API key by callers.
 */
export interface ResponsesApiResponse {
  output_text?: string | null;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string | null }>;
  }>;
}

export interface ResponsesJsonClient {
  post(url: string, body: unknown, signal: AbortSignal, accessToken?: string): Promise<ResponsesApiResponse>;
}

function responseText(response: ResponsesApiResponse): string | undefined {
  if (typeof response.output_text === 'string' && response.output_text.length > 0) return response.output_text;
  const text = response.output?.flatMap((item) => item.content ?? [])
    .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
    .map((item) => item.text ?? '')
    .join('');
  return text && text.length > 0 ? text : undefined;
}

export class OpenAIResponsesAdapter implements AgentAdapter {
  readonly id: string;
  constructor(
    private readonly config: { baseUrl: string; accessToken: string | (() => Promise<string>); model: string; id?: string },
    private readonly client: ResponsesJsonClient,
  ) { this.id = config.id ?? 'openai-responses'; }
  async run(req: { system: string; user: string }, opts: { signal: AbortSignal }): Promise<{ text: string }> {
    const accessToken = typeof this.config.accessToken === 'string' ? this.config.accessToken : await this.config.accessToken();
    const response = await this.client.post(`${this.config.baseUrl.replace(/\/$/, '')}/responses`, {
      model: this.config.model,
      instructions: req.system,
      input: [{ role: 'user', content: [{ type: 'input_text', text: req.user }] }],
      text: { format: { type: 'json_object' } },
      store: false,
      stream: true,
    }, opts.signal, accessToken);
    const content = responseText(response);
    if (typeof content !== 'string') throw new Error('empty adapter response');
    return { text: content };
  }
}

export interface CliRunner {
  run(config: { command: string; args: string[] }, input: { system: string; user: string }, signal: AbortSignal): Promise<string>;
}

export class CliAdapter implements AgentAdapter {
  readonly id: string;
  private readonly args: string[];
  constructor(
    private readonly config: { command: string; args?: string[]; id?: string; includeSystemInPrompt?: boolean },
    private readonly runner: CliRunner,
  ) { this.id = config.id ?? 'cli'; this.args = config.args ? [...config.args] : []; }
  async run(req: { system: string; user: string }, opts: { signal: AbortSignal }): Promise<{ text: string }> {
    const prompt = this.config.includeSystemInPrompt ? `${req.system}\n\n${req.user}` : req.user;
    const args = this.args.map((arg) => arg.replaceAll('{{prompt}}', prompt));
    return { text: await this.runner.run({ command: this.config.command, args }, req, opts.signal) };
  }
}
