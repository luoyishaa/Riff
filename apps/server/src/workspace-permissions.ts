import { can, roleRank, type Role } from '@collab/kernel';

export function canInviteAgent(operatorRole: Role, grantedRole: Role): boolean {
  return can(operatorRole, 'comment') && roleRank(grantedRole) <= roleRank(operatorRole);
}

export function canManageAgent(operatorRole: Role, operatorId: string, ownerId: string | undefined): boolean {
  return can(operatorRole, 'comment') && (operatorId === ownerId || operatorRole === 'owner');
}

export function canSeeAgent(accessPolicy: 'public' | 'private', viewerId: string, ownerId: string | undefined, viewerRole: Role): boolean {
  return accessPolicy === 'public' || viewerId === ownerId || viewerRole === 'owner';
}
