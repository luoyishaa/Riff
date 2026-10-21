/**
 * Per-browser conveniences kept in localStorage. Every access is guarded:
 * private windows and blocked storage must not break the app.
 */
export interface SavedAccount {
  identifier: string;
  password: string;
  displayName: string;
  principalId?: string;
  handle?: string;
  lastUsedAt: number;
}

const SAVED_ACCOUNTS_KEY = 'collab-workbench-saved-accounts-v1';
const LAST_WORKSPACE_KEY = 'collab-workbench-last-workspace-v1';
const MAX_SAVED_ACCOUNTS = 12;

function read(key: string): unknown {
  try { return JSON.parse(window.localStorage.getItem(key) ?? 'null') as unknown; } catch { return null; }
}

function write(key: string, value: unknown): void {
  try {
    if (value === undefined) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is a convenience; the app works without it.
  }
}

function isSavedAccount(value: unknown): value is SavedAccount {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<SavedAccount>;
  return typeof item.identifier === 'string' && typeof item.password === 'string' && typeof item.displayName === 'string' && typeof item.lastUsedAt === 'number';
}

export function loadSavedAccounts(): SavedAccount[] {
  const value = read(SAVED_ACCOUNTS_KEY);
  return Array.isArray(value) ? value.filter(isSavedAccount).slice(0, MAX_SAVED_ACCOUNTS) : [];
}

export function saveAccounts(accounts: SavedAccount[]): SavedAccount[] {
  const next = accounts.slice(0, MAX_SAVED_ACCOUNTS);
  write(SAVED_ACCOUNTS_KEY, next.length ? next : undefined);
  return next;
}

export function rememberAccount(accounts: SavedAccount[], account: Omit<SavedAccount, 'lastUsedAt'>): SavedAccount[] {
  const key = account.identifier.toLowerCase();
  return saveAccounts([{ ...account, lastUsedAt: Date.now() }, ...accounts.filter((item) => item.identifier.toLowerCase() !== key)]);
}

export function loadLastWorkspace(principalId: string): string | undefined {
  const value = read(LAST_WORKSPACE_KEY);
  const id = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[principalId] : undefined;
  return typeof id === 'string' ? id : undefined;
}

export function rememberLastWorkspace(principalId: string, workspaceId: string): void {
  const value = read(LAST_WORKSPACE_KEY);
  const entries = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  write(LAST_WORKSPACE_KEY, { ...entries, [principalId]: workspaceId });
}

const LAST_DOCUMENT_KEY = 'collab-workbench-last-document-v1';

export function loadLastDocument(workspaceId: string): string | undefined {
  const value = read(LAST_DOCUMENT_KEY);
  const id = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[workspaceId] : undefined;
  return typeof id === 'string' ? id : undefined;
}

export function rememberLastDocument(workspaceId: string, documentId: string): void {
  const value = read(LAST_DOCUMENT_KEY);
  const entries = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  write(LAST_DOCUMENT_KEY, { ...entries, [workspaceId]: documentId });
}
