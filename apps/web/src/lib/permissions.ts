import type { Role } from '@collab/protocol';

/**
 * The client mirrors the server's role table only to decide which controls to
 * show; every action is still authorized by the server.
 */
const RANK: Record<Role, number> = { viewer: 0, commenter: 1, suggester: 2, editor: 3, owner: 4 };
const MINIMUM: Record<'view' | 'comment' | 'suggest' | 'edit' | 'approve' | 'manage', Role> = {
  view: 'viewer', comment: 'commenter', suggest: 'suggester', edit: 'editor', approve: 'editor', manage: 'owner',
};
export type Action = keyof typeof MINIMUM;

export function can(role: Role | undefined, action: Action): boolean {
  return role !== undefined && RANK[role] >= RANK[MINIMUM[action]];
}

export function atMost(role: Role, ceiling: Role): boolean {
  return RANK[role] <= RANK[ceiling];
}

export const ROLE_LABEL: Record<Role, string> = {
  viewer: '只读',
  commenter: '评论者',
  suggester: '建议者',
  editor: '编辑者',
  owner: '所有者',
};

export const ROLE_HINT: Record<Role, string> = {
  viewer: '查看文档与讨论',
  commenter: '参与讨论',
  suggester: '提交修改建议',
  editor: '直接编辑与审批',
  owner: '管理项目与成员',
};
