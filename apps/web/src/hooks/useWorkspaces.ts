import { useCallback, useEffect, useRef, useState } from 'react';
import type { InvitationDto, WorkspaceDetailDto, WorkspaceDto } from '@collab/protocol';
import { api } from '../api.js';
import { loadLastWorkspace, rememberLastWorkspace } from '../lib/storage.js';

const INVITATION_POLL_MS = 60_000;

export interface Workspaces {
  workspaces: WorkspaceDto[];
  loaded: boolean;
  workspaceId: string | undefined;
  detail: WorkspaceDetailDto | undefined;
  invitations: InvitationDto[];
  select: (workspaceId: string | undefined) => void;
  reload: () => Promise<WorkspaceDto[]>;
  reloadDetail: () => Promise<void>;
  reloadInvitations: () => Promise<void>;
}

/** The signed-in account's projects, the open project's details and incoming invitations. */
export function useWorkspaces(principalId: string): Workspaces {
  const [workspaces, setWorkspaces] = useState<WorkspaceDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [detail, setDetail] = useState<WorkspaceDetailDto>();
  const [invitations, setInvitations] = useState<InvitationDto[]>([]);
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;

  const reload = useCallback(async () => {
    const next = await api<WorkspaceDto[]>('/api/workspaces');
    setWorkspaces(next);
    setLoaded(true);
    return next;
  }, []);

  const reloadDetail = useCallback(async () => {
    const id = workspaceRef.current;
    if (id === undefined) { setDetail(undefined); return; }
    const next = await api<WorkspaceDetailDto>(`/api/workspaces/${encodeURIComponent(id)}`);
    if (workspaceRef.current === id) setDetail(next);
  }, []);

  const reloadInvitations = useCallback(async () => {
    setInvitations(await api<InvitationDto[]>('/api/invitations'));
  }, []);

  const select = useCallback((id: string | undefined) => {
    setWorkspaceId(id);
    setDetail(undefined);
    if (id !== undefined) rememberLastWorkspace(principalId, id);
  }, [principalId]);

  useEffect(() => {
    reload().then((list) => {
      const remembered = loadLastWorkspace(principalId);
      setWorkspaceId((current) => current ?? (list.find((item) => item.id === remembered) ?? list[0])?.id);
    }).catch(() => setLoaded(true));
    const refreshInvitations = (): void => { reloadInvitations().catch(() => undefined); };
    refreshInvitations();
    // Invitations have no live channel: check on a slow timer and whenever the window regains focus.
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') refreshInvitations(); }, INVITATION_POLL_MS);
    window.addEventListener('focus', refreshInvitations);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refreshInvitations); };
  }, [principalId, reload, reloadInvitations]);

  useEffect(() => {
    reloadDetail().catch(() => setDetail(undefined));
  }, [workspaceId, reloadDetail]);

  return { workspaces, loaded, workspaceId, detail, invitations, select, reload, reloadDetail, reloadInvitations };
}
