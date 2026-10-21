import type { ApiErrorBody } from '@collab/protocol';

/** A failed request with the server's error code; `status` 0 means the server was unreachable. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function errorBody(value: unknown): ApiErrorBody['error'] | undefined {
  if (typeof value !== 'object' || value === null || !('error' in value)) return undefined;
  const error = (value as { error: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code === 'string' ? { code, message: typeof message === 'string' ? message : code } : undefined;
}

export interface RequestOptions { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown; signal?: AbortSignal }

/** JSON request with the session cookie. Throws ApiError on any failure. */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      credentials: 'include',
      headers: options.body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'network', '无法连接服务端');
  }
  const text = await response.text();
  let value: unknown;
  try { value = text ? JSON.parse(text) : undefined; } catch { value = undefined; }
  if (!response.ok) {
    const error = errorBody(value);
    throw new ApiError(response.status, error?.code ?? 'http-error', error?.message ?? `HTTP ${response.status}`);
  }
  return value as T;
}

const MESSAGES: Record<string, string> = {
  network: '连不上服务端，请确认后端服务已启动。',
  'authentication-required': '登录已过期，请重新登录。',
  'permission-denied': '当前角色没有这项操作的权限。',
  'invalid-credentials': '账号或密码不正确。',
  'account-handle-taken': '这个账号标识已被注册，换一个试试。',
  'account-email-taken': '这个邮箱已被注册。',
  'principal-not-found': '没有找到这个账号，请检查账号标识或邮箱。',
  'already-member': '对方已经是项目成员。',
  'provider-not-connected': '请先在“模型”里连接这个提供商。',
  'stale-anchor': '这段文字已经被修改，建议已过期。',
  'structure-loss': '这条修改会破坏 Markdown 结构，没有应用。',
  'invalid-state': '这项内容已经被处理过了。',
  'thread-resolved': '讨论已解决，无法继续回复。',
  'delete-confirmation-mismatch': '输入的名称与项目名称不一致。',
  'selection-changed': '所选文字刚被修改，请重新选择后再评论。',
};

/** A sentence for the user; falls back to the caller's description of what failed. */
export function describeError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return MESSAGES[error.code] ?? fallback;
  return fallback;
}
