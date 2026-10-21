import { describe, expect, it } from 'vitest';
import { inspectCliProviders, type CliCommandRunner, type CommandResult } from '../src/cli-providers.js';

class FakeRunner implements CliCommandRunner {
  constructor(private readonly results: Record<string, CommandResult>) {}
  async run(command: string, args: string[]): Promise<CommandResult> {
    return this.results[`${command} ${args.join(' ')}`] ?? { code: 1, stdout: '', stderr: 'unknown' };
  }
}

describe('inspectCliProviders', () => {
  it('reports Codex login status without exposing raw auth output', async () => {
    const result = await inspectCliProviders(new FakeRunner({
      'codex --version': { code: 0, stdout: 'codex-cli 0.160.0\n', stderr: '' },
      'codex login status': { code: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' },
      'claude --version': { code: null, stdout: '', stderr: '', errorCode: 'ENOENT' },
    }));
    expect(result.find((item) => item.id === 'codex')).toMatchObject({ installed: true, auth: 'authenticated', version: 'codex-cli 0.160.0' });
    expect(result.find((item) => item.id === 'claude')).toMatchObject({ installed: false, auth: 'unavailable' });
  });

  it('parses Claude Code auth status JSON and does not return the JSON payload', async () => {
    const result = await inspectCliProviders(new FakeRunner({
      'codex --version': { code: null, stdout: '', stderr: '', errorCode: 'ENOENT' },
      'claude --version': { code: 0, stdout: 'Claude Code 1.2.3\n', stderr: '' },
      'claude auth status': { code: 0, stdout: '{"loggedIn":true,"authMethod":"oauth_token"}\n', stderr: '' },
    }));
    const claude = result.find((item) => item.id === 'claude');
    expect(claude).toMatchObject({ installed: true, auth: 'authenticated', version: 'Claude Code 1.2.3', detail: 'Claude Code 报告已登录' });
    expect(claude?.detail).not.toContain('oauth_token');
  });

  it('does not mistake a negative Codex status for a successful login', async () => {
    const result = await inspectCliProviders(new FakeRunner({
      'codex --version': { code: 0, stdout: 'codex-cli 0.1\n', stderr: '' },
      'codex login status': { code: 1, stdout: 'Not logged in\n', stderr: '' },
      'claude --version': { code: null, stdout: '', stderr: '', errorCode: 'ENOENT' },
    }));
    expect(result.find((item) => item.id === 'codex')).toMatchObject({ auth: 'not-authenticated', detail: 'Codex CLI 报告未登录' });
  });
});
