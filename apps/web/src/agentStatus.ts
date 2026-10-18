export type AgentFailureKind = 'permission' | 'timeout' | 'authentication' | 'rate-limit' | 'network' | 'invalid-output' | 'provider' | 'unknown';
export type AgentStatus = 'working' | 'idle' | 'failed';

export interface AgentStatusCopy {
  label: string;
  detail: string;
}

const failureDetail: Record<AgentFailureKind, string> = {
  permission: '当前权限不足，请检查这个 Agent 的项目权限。',
  timeout: '处理时间过长，可能是任务范围太大或提供商响应较慢。',
  authentication: '提供商授权或登录状态不可用，请重新连接。',
  'rate-limit': '提供商暂时限流或额度不足，请稍后再试。',
  network: '无法连接到提供商，请检查网络或本机 CLI 登录状态。',
  'invalid-output': '提供商返回的内容无法解析，请重试一次。',
  provider: '提供商没有完成这次请求，请检查模型配置。',
  unknown: '服务暂时没有完成这次请求，请稍后重试。',
};

export function classifyAgentFailure(error: string | undefined, kind?: AgentFailureKind): AgentFailureKind {
  if (kind !== undefined) return kind;
  const normalized = (error ?? '').toLowerCase();
  if (/(permission|forbidden|insufficient|not allowed|unauthorized)/u.test(normalized)) return 'permission';
  if (/(timeout|timed out|aborted|deadline)/u.test(normalized)) return 'timeout';
  if (/(401|403|auth|token|login|credential|api key)/u.test(normalized)) return 'authentication';
  if (/(429|rate.?limit|quota|too many requests)/u.test(normalized)) return 'rate-limit';
  if (/(enoent|econn|network|fetch failed|socket|dns|unreachable|http 5\d\d)/u.test(normalized)) return 'network';
  if (/(invalid output|no-json|malformed|protocol)/u.test(normalized)) return 'invalid-output';
  if (/(agent http|responses api|provider|model)/u.test(normalized)) return 'provider';
  return 'unknown';
}

export function agentStatusCopy(name: string, status: AgentStatus, error?: string, kind?: AgentFailureKind): AgentStatusCopy {
  if (status === 'working') return { label: `${name} 正在处理…`, detail: '任务已收到，正在读取上下文并生成回复。' };
  if (status === 'failed') {
    const failureKind = classifyAgentFailure(error, kind);
    return { label: `${name} 暂时无法连接`, detail: failureDetail[failureKind] };
  }
  return { label: '可以接收任务', detail: '' };
}
