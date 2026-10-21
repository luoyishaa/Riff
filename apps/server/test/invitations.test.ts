import { describe, expect, it } from 'vitest';
import type { Principal } from '@collab/kernel';
import { DocumentStore } from '../src/infra/document-store.js';

function human(id: string, displayName: string): Principal {
  return { id, kind: 'human', displayName };
}

describe('workspace invitations', () => {
  it('keeps an invitation pending until the invited principal accepts it', () => {
    const store = new DocumentStore(':memory:');
    store.upsertPrincipal(human('alice', 'Alice'));
    store.upsertPrincipal(human('bob', 'Bob'));
    store.createWorkspace('space-1', 'Writing', 'alice');

    const invitation = store.createWorkspaceInvitation('invite-1', 'space-1', 'bob', 'editor', 'alice', 1);
    expect(invitation.status).toBe('pending');
    expect(store.workspaceRole('space-1', 'bob')).toBeNull();
    expect(store.pendingWorkspaceInvitations('bob')).toHaveLength(1);

    const accepted = store.acceptWorkspaceInvitation('invite-1', 'bob', 2);
    expect(accepted?.status).toBe('accepted');
    expect(accepted?.respondedAt).toBe(2);
    expect(store.workspaceRole('space-1', 'bob')).toBe('editor');
    expect(store.pendingWorkspaceInvitations('bob')).toHaveLength(0);
  });

  it('does not let another principal accept or reject an invitation', () => {
    const store = new DocumentStore(':memory:');
    store.upsertPrincipal(human('alice', 'Alice'));
    store.upsertPrincipal(human('bob', 'Bob'));
    store.upsertPrincipal(human('carol', 'Carol'));
    store.createWorkspace('space-1', 'Writing', 'alice');
    store.createWorkspaceInvitation('invite-1', 'space-1', 'bob', 'commenter', 'alice');

    expect(store.acceptWorkspaceInvitation('invite-1', 'carol')).toBeUndefined();
    expect(store.rejectWorkspaceInvitation('invite-1', 'carol')).toBeUndefined();
    expect(store.workspaceInvitation('invite-1')?.status).toBe('pending');
  });

  it('updates an existing pending invitation instead of duplicating it', () => {
    const store = new DocumentStore(':memory:');
    store.upsertPrincipal(human('alice', 'Alice'));
    store.upsertPrincipal(human('bob', 'Bob'));
    store.createWorkspace('space-1', 'Writing', 'alice');

    store.createWorkspaceInvitation('invite-1', 'space-1', 'bob', 'viewer', 'alice', 1);
    const updated = store.createWorkspaceInvitation('invite-2', 'space-1', 'bob', 'editor', 'alice', 2);
    expect(updated.id).toBe('invite-1');
    expect(updated.role).toBe('editor');
    expect(store.workspaceInvitations('space-1', 'pending')).toHaveLength(1);
  });

  it('finds registered human accounts by a case-insensitive stable handle', () => {
    const store = new DocumentStore(':memory:');
    store.upsertPrincipal({ ...human('alice', 'Alice'), handle: 'alice.writer', email: 'alice@example.test' });
    store.upsertPrincipal({ ...human('bob', 'Bob'), handle: 'bob' });
    store.upsertPrincipal({ id: 'polisher', kind: 'agent', displayName: 'Polisher', ownerId: 'alice' });

    expect(store.humanPrincipalByIdentifier('ALICE.WRITER')).toMatchObject({ id: 'alice', handle: 'alice.writer' });
    expect(store.humanPrincipalByHandle('ALICE.WRITER')).toMatchObject({ id: 'alice', handle: 'alice.writer' });
    expect(store.humanPrincipalByIdentifier('@alice.writer')).toMatchObject({ id: 'alice', handle: 'alice.writer' });
    expect(store.humanPrincipalByIdentifier('ALICE@EXAMPLE.TEST')).toMatchObject({ id: 'alice', email: 'alice@example.test' });
    expect(store.humanPrincipalByIdentifier('polisher')).toBeUndefined();
    expect(store.searchHumanPrincipals('alice')).toHaveLength(1);
    expect(store.searchHumanPrincipals('@alice')).toHaveLength(1);
    expect(store.searchHumanPrincipals('writer')[0]?.id).toBe('alice');
  });
});

describe('workspace membership changes', () => {
  it('apply to document-level memberships, so a removed member loses access', () => {
    const store = new DocumentStore(':memory:');
    store.upsertPrincipal(human('alice', 'Alice'));
    store.upsertPrincipal(human('bob', 'Bob'));
    store.createWorkspace('space-1', 'Writing', 'alice');
    store.create('doc-1', 'Draft', 'text', [], 'space-1');
    store.setWorkspaceMembership({ workspaceId: 'space-1', principalId: 'bob', role: 'editor' });
    store.setMembership({ docId: 'doc-1', principalId: 'bob', role: 'editor' });

    store.updateWorkspaceMemberRole('space-1', 'bob', 'viewer');
    expect(store.role('doc-1', 'bob')).toBe('viewer');
    store.removeWorkspaceMembership('space-1', 'bob');
    expect(store.role('doc-1', 'bob')).toBeNull();
  });
});
