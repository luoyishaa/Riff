import { useEffect, useRef, useState } from 'react';
import type { MemberDto } from '@collab/protocol';
import { DocumentConnection, type ConnectionStatus } from './connection.js';

export interface Collaboration {
  connection: DocumentConnection | undefined;
  status: ConnectionStatus;
  synced: boolean;
  online: MemberDto[];
  /** Live document text, updated at most once per animation frame. */
  text: string;
}

export function useCollaboration(docId: string | undefined, user: { id: string; name: string }): Collaboration {
  const [connection, setConnection] = useState<DocumentConnection>();
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [synced, setSynced] = useState(false);
  const [online, setOnline] = useState<MemberDto[]>([]);
  const [text, setText] = useState('');
  const nameRef = useRef(user.name);
  nameRef.current = user.name;

  useEffect(() => {
    setSynced(false);
    setOnline([]);
    setText('');
    if (docId === undefined) { setConnection(undefined); return undefined; }
    const next = new DocumentConnection(docId, { id: user.id, name: nameRef.current }, { status: setStatus, synced: () => setSynced(true), members: setOnline });
    let frame: number | undefined;
    const observe = (): void => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => { frame = undefined; setText(next.ytext.toString()); });
    };
    next.ytext.observe(observe);
    setConnection(next);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      next.ytext.unobserve(observe);
      next.destroy();
    };
  }, [docId, user.id]);

  useEffect(() => { connection?.rename(user.name); }, [connection, user.name]);

  return { connection, status, synced, online, text };
}
