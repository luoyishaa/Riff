import { runProcess, type CommandResult } from './process-runner.js';

export type CliProviderId = 'codex' | 'claude';
export type { CommandResult };
export type CliAuthState = 'authenticated' | 'not-authenticated' | 'unknown' | 'unavailable';

export interface CliProviderStatus {
  id: CliProviderId;
  displayName: string;
  command: string;
  installed: boolean;
  version?: string;
  auth: CliAuthState;
  detail: string;
}

export interface CliCommandRunner {
  run(command: string, args: string[], timeoutMs: number): Promise<CommandResult>;
}

/** Probes the real CLI binaries; tests substitute a fake runner. */
export const processCommandRunner: CliCommandRunner = {
  run: (command, args, timeoutMs) => runProcess(command, args, { timeoutMs }),
};

function firstLine(value: string): string | undefined {
  const line = value.split(/\r?\n/).map((item) => item.trim()).find((item) => item.length > 0);
  return line?.slice(0, 160);
}

function authFromOutput(id: CliProviderId, result: CommandResult): CliAuthState {
  const output = `${result.stdout}\n${result.stderr}`;
  if (id === 'codex') {
    if (/not\s+logged\s+in|login\s+required|logged\s+out/i.test(output)) return 'not-authenticated';
    if (/logged\s+in/i.test(output)) return 'authenticated';
    return result.errorCode === 'ENOENT' ? 'unavailable' : 'unknown';
  }
  // Current Claude Code releases expose `claude auth status` as JSON; the
  // documented `claude doctor` command is intentionally not used as auth proof.
  if (id === 'claude') {
    try {
      const jsonText = result.stdout.trim();
      const jsonBlock = jsonText.startsWith('{') ? jsonText : jsonText.slice(jsonText.indexOf('{'));
      const parsed: unknown = JSON.parse(jsonBlock);
      if (typeof parsed === 'object' && parsed !== null && 'loggedIn' in parsed && typeof parsed.loggedIn === 'boolean') {
        return parsed.loggedIn ? 'authenticated' : 'not-authenticated';
      }
    } catch {
      // Fall through to conservative text matching for older versions.
    }
  }
  if (/not\s+authenticated|not\s+logged\s+in|login\s+required/i.test(output)) return 'not-authenticated';
  if (/authenticated|logged\s+in/i.test(output)) return 'authenticated';
  return result.errorCode === 'ENOENT' ? 'unavailable' : 'unknown';
}

async function probeProvider(id: CliProviderId, runner: CliCommandRunner): Promise<CliProviderStatus> {
  const command = id;
  const displayName = id === 'codex' ? 'Codex CLI' : 'Claude Code';
  const version = await runner.run(command, ['--version'], 5000);
  if (version.errorCode === 'ENOENT') {
    return { id, displayName, command, installed: false, auth: 'unavailable', detail: '未检测到可执行文件' };
  }
  const authCheck = id === 'codex'
    ? await runner.run(command, ['login', 'status'], 5000)
    : await runner.run(command, ['auth', 'status'], 5000);
  const auth = authFromOutput(id, authCheck);
  const detail = id === 'codex'
    ? (auth === 'authenticated' ? 'Codex CLI 报告已登录' : auth === 'not-authenticated' ? 'Codex CLI 报告未登录' : /config|unsupported|invalid/i.test(`${authCheck.stdout}\n${authCheck.stderr}`) ? 'Codex CLI 报告配置错误，请在终端检查 login status' : 'Codex CLI 未报告明确登录状态')
    : auth === 'unknown'
      ? 'Claude Code 已安装；无法从 auth status 确认登录状态'
      : auth === 'authenticated' ? 'Claude Code 报告已登录' : 'Claude Code 报告未登录';
  const versionText = firstLine(version.stdout);
  return {
    id,
    displayName,
    command,
    installed: true,
    ...(versionText === undefined ? {} : { version: versionText }),
    auth,
    detail,
  };
}

export async function inspectCliProviders(runner: CliCommandRunner = processCommandRunner): Promise<CliProviderStatus[]> {
  return await Promise.all([probeProvider('codex', runner), probeProvider('claude', runner)]);
}
