import type { ChatCompletionResponse, CliRunner, HttpJsonClient } from '@collab/agent';
import { runProcess } from './process-runner.js';

/** chat/completions over fetch; the key only ever travels in the Authorization header. */
export function fetchJsonClient(apiKey: string): HttpJsonClient {
  return {
    async post(url: string, body: unknown, signal: AbortSignal): Promise<ChatCompletionResponse> {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) throw new Error(`agent HTTP ${response.status}`);
      return await response.json() as ChatCompletionResponse;
    },
  };
}

/** Used when the provider connection behind an agent is gone (e.g. after a server restart). */
export const missingKeyClient: HttpJsonClient = {
  post: () => Promise.reject(new Error('api key unavailable: reconnect the model provider')),
};

export const processCliRunner: CliRunner = {
  async run(config, stdin, signal) {
    const result = await runProcess(config.command, config.args, { signal, ...(stdin === undefined ? {} : { stdin }) });
    if (result.errorCode === 'ABORT_ERR') throw new Error('agent process aborted');
    if (result.errorCode !== undefined) throw new Error(`agent process failed: ${result.errorCode}`);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `agent process exited with ${result.code ?? 'unknown status'}`);
    return result.stdout;
  },
};
