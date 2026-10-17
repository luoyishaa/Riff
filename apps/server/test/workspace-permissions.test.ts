import { describe, expect, it } from 'vitest';
import { canInviteAgent, canManageAgent, canSeeAgent } from '../src/workspace-permissions.js';

describe('workspace and agent permissions', () => {
  it('caps an agent role at the operator role', () => {
    expect(canInviteAgent('editor', 'editor')).toBe(true);
    expect(canInviteAgent('suggester', 'editor')).toBe(false);
    expect(canInviteAgent('viewer', 'viewer')).toBe(false);
  });

  it('lets an operator manage only their agent unless they own the document', () => {
    expect(canManageAgent('editor', 'bob', 'bob')).toBe(true);
    expect(canManageAgent('editor', 'bob', 'alice')).toBe(false);
    expect(canManageAgent('owner', 'alice', 'bob')).toBe(true);
  });

  it('hides private agents from other members', () => {
    expect(canSeeAgent('public', 'bob', 'alice', 'viewer')).toBe(true);
    expect(canSeeAgent('private', 'alice', 'alice', 'viewer')).toBe(true);
    expect(canSeeAgent('private', 'bob', 'alice', 'editor')).toBe(false);
    expect(canSeeAgent('private', 'bob', 'alice', 'owner')).toBe(true);
  });
});
