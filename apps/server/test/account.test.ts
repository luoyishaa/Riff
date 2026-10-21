import { describe, expect, it } from 'vitest';
import type { Principal } from '@collab/kernel';
import { DocumentStore } from '../src/infra/document-store.js';

describe('local demo account profile', () => {
  it('updates only the selected principal display name', () => {
    const store = new DocumentStore(':memory:');
    const alice: Principal = { id: 'alice', kind: 'human', displayName: 'Alice' };
    const bob: Principal = { id: 'bob', kind: 'human', displayName: 'Bob' };
    store.upsertPrincipal(alice);
    store.upsertPrincipal(bob);

    expect(store.updatePrincipalDisplayName('alice', 'Alice Chen')).toMatchObject({ ...alice, displayName: 'Alice Chen' });
    expect(store.principals()).toContainEqual(expect.objectContaining(bob));
    expect(store.principals()).not.toContainEqual(expect.objectContaining(alice));
    expect(store.updatePrincipalDisplayName('missing', 'Nobody')).toBeUndefined();
  });

  it('persists a stable account handle separately from the display name', () => {
    const store = new DocumentStore(':memory:');
    store.upsertPrincipal({ id: 'alice', kind: 'human', displayName: 'Alice', handle: 'alice' });

    expect(store.updatePrincipalProfile('alice', 'Alice Chen', 'alice.chen')).toMatchObject({
      id: 'alice',
      displayName: 'Alice Chen',
      handle: 'alice.chen',
    });
    expect(store.humanPrincipalByIdentifier('ALICE.CHEN')?.displayName).toBe('Alice Chen');
    expect(store.principalHandleTaken('alice.chen', 'alice')).toBe(false);
  });
});
