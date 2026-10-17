import { describe, expect, it } from 'vitest';
import type { Principal } from '@collab/kernel';
import { DocumentStore } from '../src/infra/document-store.js';

function human(id: string, displayName: string): Principal {
  return { id, kind: 'human', displayName, };
}

describe('database auth sessions', () => {
  it('keeps credentials separate from the principal directory and expires sessions', () => {
    const store = new DocumentStore(':memory:');
    store.upsertPrincipal({ ...human('alice', 'Alice'), handle: 'alice' });
    expect(store.setPrincipalPasswordHash('alice', 'scrypt$test')).toBe(true);
    expect(store.principalPasswordHash('alice')).toBe('scrypt$test');

    store.createAuthSession('token-hash', 'alice', 10, 20);
    expect(store.principalIdForAuthSession('token-hash', 19)).toBe('alice');
    expect(store.principalIdForAuthSession('token-hash', 20)).toBeUndefined();
    expect(store.principalIdForAuthSession('token-hash', 19)).toBeUndefined();
  });

  it('revokes a live session explicitly', () => {
    const store = new DocumentStore(':memory:');
    store.upsertPrincipal(human('alice', 'Alice'));
    store.createAuthSession('token-hash', 'alice', 10, 100);
    store.revokeAuthSession('token-hash');
    expect(store.principalIdForAuthSession('token-hash', 11)).toBeUndefined();
  });
});
