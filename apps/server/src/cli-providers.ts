import { spawn, type ChildProcess } from 'node:child_process';

export type CliProviderId = 'codex' | 'claude';
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

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
}

export interface CliCommandRunner {
  run(command: string, args: string[], timeoutMs: number): Promise<CommandResult>;
}

/**
 * Runs a fixed executable with an argument array. `shell:false` is deliberate:
 * provider names and prompts must never become shell source.
 */
export class SafeCommandRunner implements CliCommandRunner {
  run(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
    return new Promise((resolve) => {
      const runOne = (executable: string, allowCmdRetry: boolean): void => {
        let child: ChildProcess;
        try {
          const invocation = process.platform === 'win32' && executable.toLowerCase().endsWith('.cmd')
            ? ['cmd.exe', ['/d', '/s', '/c', [quoteWindows(executable), ...args.map(quoteWindows)].join(' ')]] as const
            : [executable, args] as const;
          child = spawn(invocation[0], invocation[1], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (allowCmdRetry && process.platform === 'win32' && (code === 'ENOENT' || code === 'EINVAL') && !executable.toLowerCase().endsWith('.cmd')) {
            runOne(`${executable}.cmd`, false);
            return;
          }
          resolve({ code: null, stdout: '', stderr: '', errorCode: code ?? 'UNKNOWN' });
          return;
        }
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (result: CommandResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          child.kill();
          finish({ code: null, stdout, stderr, errorCode: 'ETIMEDOUT' });
        }, timeoutMs);
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
        child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
        child.once('error', (error: NodeJS.ErrnoException) => {
          if (allowCmdRetry && process.platform === 'win32' && (error.code === 'ENOENT' || error.code === 'EINVAL') && !executable.toLowerCase().endsWith('.cmd')) {
            settled = true;
            clearTimeout(timer);
            runOne(`${executable}.cmd`, false);
            return;
          }
          finish({ code: null, stdout, stderr, errorCode: error.code ?? 'UNKNOWN' });
        });
        child.once('close', (code) => finish({ code, stdout, stderr }));
      };
      runOne(command, true);
    });
  }
}

function quoteWindows(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/g, '$1$1')}"`;
}

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

export async function inspectCliProviders(runner: CliCommandRunner = new SafeCommandRunner()): Promise<CliProviderStatus[]> {
  return await Promise.all([probeProvider('codex', runner), probeProvider('claude', runner)]);
}
