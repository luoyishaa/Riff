import { useCallback, useEffect, useState } from 'react';
import type { AuthResponse, PrincipalDto, RegisterPrincipalInput, SessionStateResponse } from '@collab/protocol';
import { api } from '../api.js';
import { loadSavedAccounts, rememberAccount, saveAccounts, type SavedAccount } from '../lib/storage.js';

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; principal: PrincipalDto };

export interface Session {
  state: SessionState;
  savedAccounts: SavedAccount[];
  signIn: (identifier: string, password: string) => Promise<void>;
  register: (input: RegisterPrincipalInput) => Promise<void>;
  /** Replace the browser session with a saved account; other devices keep theirs. */
  switchTo: (account: SavedAccount) => Promise<void>;
  signOut: () => Promise<void>;
  updatePrincipal: (principal: PrincipalDto) => void;
  forgetAccount: (identifier: string) => void;
  forgetAllAccounts: () => void;
}

export function useSession(): Session {
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  const [savedAccounts, setSavedAccounts] = useState<SavedAccount[]>(loadSavedAccounts);

  useEffect(() => {
    let active = true;
    api<SessionStateResponse>('/api/auth/session')
      .then((session) => { if (active) setState(session.authenticated ? { status: 'signed-in', principal: session.principal } : { status: 'signed-out' }); })
      .catch(() => { if (active) setState({ status: 'signed-out' }); });
    return () => { active = false; };
  }, []);

  const signedIn = useCallback((response: AuthResponse, identifier: string, password: string) => {
    const { principal } = response;
    setSavedAccounts((current) => rememberAccount(current, {
      identifier,
      password,
      displayName: principal.displayName,
      principalId: principal.id,
      ...(principal.handle === undefined ? {} : { handle: principal.handle }),
    }));
    setState({ status: 'signed-in', principal });
  }, []);

  const signIn = useCallback(async (identifier: string, password: string) => {
    signedIn(await api<AuthResponse>('/api/auth/login', { body: { identifier, password } }), identifier, password);
  }, [signedIn]);

  const register = useCallback(async (input: RegisterPrincipalInput) => {
    signedIn(await api<AuthResponse>('/api/auth/register', { body: input }), input.handle, input.password);
  }, [signedIn]);

  const switchTo = useCallback(async (account: SavedAccount) => {
    signedIn(await api<AuthResponse>('/api/auth/switch', { body: { identifier: account.identifier, password: account.password } }), account.identifier, account.password);
  }, [signedIn]);

  const signOut = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' });
    setState({ status: 'signed-out' });
  }, []);

  const updatePrincipal = useCallback((principal: PrincipalDto) => {
    setState({ status: 'signed-in', principal });
    setSavedAccounts((current) => saveAccounts(current.map((account) => account.principalId === principal.id
      ? { ...account, displayName: principal.displayName, ...(principal.handle === undefined ? {} : { handle: principal.handle }) }
      : account)));
  }, []);

  const forgetAccount = useCallback((identifier: string) => {
    setSavedAccounts((current) => saveAccounts(current.filter((account) => account.identifier.toLowerCase() !== identifier.toLowerCase())));
  }, []);

  const forgetAllAccounts = useCallback(() => setSavedAccounts(saveAccounts([])), []);

  return { state, savedAccounts, signIn, register, switchTo, signOut, updatePrincipal, forgetAccount, forgetAllAccounts };
}
