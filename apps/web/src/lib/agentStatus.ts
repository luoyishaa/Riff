import type { AgentFailureKind, AgentState } from '@collab/protocol';

/** Readable reasons for a failed run; the server classifies the raw provider error. */
const FAILURE: Record<AgentFailureKind, string> = {
  permission: '权限不足，请检查这个 Agent 的项目角色。',
  timeout: '处理时间过长，可以缩小范围后重试。',
  authentication: '提供商未连接或登录已失效，请在“模型”里重新连接。',
  'rate-limit': '提供商限流或额度不足，请稍后再试。',
  network: '连不上提供商，请检查网络或本机 CLI。',
  'invalid-output': '返回内容无法解析，可以再试一次。',
  provider: '提供商没有完成请求，请检查模型配置。',
  unknown: '这次没有完成，请稍后重试。',
};

export function agentStatusText(name: string, state: AgentState, kind?: AgentFailureKind): string {
  if (state === 'working') return `${name} 正在处理…`;
  if (state === 'failed') return `${name} 没有完成：${FAILURE[kind ?? 'unknown']}`;
  return `${name} 已就绪`;
}
