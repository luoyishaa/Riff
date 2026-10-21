import { spawn, type ChildProcess } from 'node:child_process';

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not run to completion (ENOENT, ETIMEDOUT, ABORT_ERR…). */
  errorCode?: string;
}

export interface ProcessOptions {
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function quoteWindows(value: string): string {
  if (!/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\*)$/u, '$1$1')}"`;
}

/**
 * Runs a fixed executable with an argument array. `shell:false` is deliberate:
 * provider names and prompts must never become shell source. npm installs CLIs
 * on Windows as `.cmd` shims, which only run through cmd.exe; arguments pass
 * through it quoted, which is only safe for single-line values, so callers
 * send prompts on stdin.
 */
export function runProcess(command: string, args: string[], options: ProcessOptions = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const attempt = (executable: string, allowCmdFallback: boolean): void => {
      const isCmdShim = process.platform === 'win32' && executable.toLowerCase().endsWith('.cmd');
      const shouldRetryAsCmd = (code: string | undefined): boolean => allowCmdFallback && !isCmdShim && process.platform === 'win32' && (code === 'ENOENT' || code === 'EINVAL');
      let child: ChildProcess;
      try {
        child = isCmdShim
          ? spawn('cmd.exe', ['/d', '/s', '/c', [executable, ...args].map(quoteWindows).join(' ')], { shell: false, windowsHide: true })
          : spawn(executable, args, { shell: false, windowsHide: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (shouldRetryAsCmd(code)) attempt(`${executable}.cmd`, false);
        else resolve({ code: null, stdout: '', stderr: '', errorCode: code ?? 'UNKNOWN' });
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        return true;
      };
      const finish = (result: CommandResult): void => { if (settle()) resolve(result); };
      const abort = (): void => { child.kill(); finish({ code: null, stdout, stderr, errorCode: 'ABORT_ERR' }); };
      const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
        child.kill();
        finish({ code: null, stdout, stderr, errorCode: 'ETIMEDOUT' });
      }, options.timeoutMs);
      if (options.signal?.aborted) { abort(); return; }
      options.signal?.addEventListener('abort', abort, { once: true });
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', (error: NodeJS.ErrnoException) => {
        if (shouldRetryAsCmd(error.code)) {
          if (settle()) attempt(`${executable}.cmd`, false);
          return;
        }
        finish({ code: null, stdout, stderr, errorCode: error.code ?? 'UNKNOWN' });
      });
      child.once('close', (code) => finish({ code, stdout, stderr }));
      // A process that exits before reading its input must not crash the server.
      child.stdin?.on('error', () => undefined);
      if (options.stdin !== undefined) child.stdin?.write(options.stdin);
      child.stdin?.end();
    };
    attempt(command, true);
  });
}
