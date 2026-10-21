import { minRole, type Role } from '@collab/kernel';

/** Effective permission for one agent run is the lower of both grants. */
export function effectiveRole(grantedRole: Role, requesterRole: Role): Role {
  return minRole(grantedRole, requesterRole);
}
