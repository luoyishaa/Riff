export const roles = ['viewer', 'commenter', 'suggester', 'editor', 'owner'] as const;
export type Role = (typeof roles)[number];
export type PrincipalKind = 'human' | 'agent';
export interface Principal { id: string; kind: PrincipalKind; displayName: string; ownerId?: string }
export interface Membership { docId: string; principalId: string; role: Role }
export type Action = 'view' | 'comment' | 'suggest' | 'edit' | 'approve' | 'manage';
const minimumRole: Record<Action, Role> = {
  view: 'viewer', comment: 'commenter', suggest: 'suggester', edit: 'editor', approve: 'editor', manage: 'owner',
};
export function roleRank(role: Role): number { return roles.indexOf(role); }
export function can(role: Role, action: Action): boolean { return roleRank(role) >= roleRank(minimumRole[action]); }
export function minRole(a: Role, b: Role): Role { return roleRank(a) <= roleRank(b) ? a : b; }
