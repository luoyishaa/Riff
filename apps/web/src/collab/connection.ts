import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import type { ClientSocketMessage, MemberDto, ServerSocketMessage } from '@collab/protocol';
import { fromBase64, toBase64 } from '../lib/base64.js';
import { colorFor } from '../lib/format.js';

export type ConnectionStatus = 'connecting' | 'connected' | 'offline';

export interface ConnectionListener {
  status: (status: ConnectionStatus) => void;
  /** The server's state arrived; until then the editor stays read-only. */
  synced: () => void;
  members: (members: MemberDto[]) => void;
}

const REMOTE = 'remote';
const MAX_RETRY_MS = 10_000;

/**
 * One document's live connection: a Y.Doc shared with the server over the
 * document WebSocket, plus y-protocols awareness for remote cursors. Local
 * changes are sent as incremental updates; after a reconnect the full local
 * state is sent once so edits made while offline are merged, not lost.
 */
export class DocumentConnection {
  readonly ydoc = new Y.Doc();
  readonly ytext = this.ydoc.getText('content');
  readonly awareness = new Awareness(this.ydoc);
  readonly undoManager = new Y.UndoManager(this.ytext);
  private socket: WebSocket | undefined;
  private retries = 0;
  private retryTimer: number | undefined;
  private destroyed = false;
  private hasSynced = false;

  constructor(private readonly docId: string, private readonly user: { id: string; name: string }, private readonly listener: ConnectionListener) {
    this.rename(user.name);
    this.ydoc.on('update', this.sendUpdate);
    this.awareness.on('update', this.sendAwareness);
    this.connect();
  }

  /** The name and colour other people see next to this user's cursor. */
  rename(name: string): void {
    const color = colorFor(this.user.id);
    this.awareness.setLocalStateField('user', { id: this.user.id, name, color, colorLight: `${color}33` });
  }

  destroy(): void {
    this.destroyed = true;
    if (this.retryTimer !== undefined) window.clearTimeout(this.retryTimer);
    this.ydoc.off('update', this.sendUpdate);
    this.awareness.off('update', this.sendAwareness);
    this.socket?.close();
    this.undoManager.destroy();
    this.awareness.destroy();
    this.ydoc.destroy();
  }

  private connect(): void {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws/docs/${encodeURIComponent(this.docId)}`);
    this.socket = socket;
    this.listener.status('connecting');
    socket.onopen = () => {
      this.retries = 0;
      this.listener.status('connected');
      this.send({ type: 'sync', update: toBase64(Y.encodeStateAsUpdate(this.ydoc)) });
      this.send({ type: 'awareness', clientId: this.ydoc.clientID, update: toBase64(encodeAwarenessUpdate(this.awareness, [this.ydoc.clientID])) });
    };
    socket.onmessage = (event: MessageEvent<string>) => this.receive(event.data);
    socket.onclose = () => {
      if (this.socket !== socket || this.destroyed) return;
      this.listener.status('offline');
      // Remote cursors would freeze in place while disconnected.
      removeAwarenessStates(this.awareness, [...this.awareness.getStates().keys()].filter((id) => id !== this.ydoc.clientID), REMOTE);
      const delay = Math.min(MAX_RETRY_MS, 500 * 2 ** this.retries++);
      this.retryTimer = window.setTimeout(() => this.connect(), delay);
    };
  }

  private receive(data: string): void {
    let message: ServerSocketMessage;
    try { message = JSON.parse(data) as ServerSocketMessage; } catch { return; }
    if (message.type === 'sync') {
      Y.applyUpdate(this.ydoc, fromBase64(message.update), REMOTE);
      if (!this.hasSynced) {
        this.hasSynced = true;
        // The initial load must not become an undo step.
        this.undoManager.clear();
        this.listener.synced();
      }
    } else if (message.type === 'awareness') {
      applyAwarenessUpdate(this.awareness, fromBase64(message.update), REMOTE);
    } else if (message.type === 'awareness-leave') {
      removeAwarenessStates(this.awareness, message.clientIds, REMOTE);
    } else {
      this.listener.members(message.members);
    }
  }

  private readonly sendUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin !== REMOTE) this.send({ type: 'sync', update: toBase64(update) });
  };

  private readonly sendAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown): void => {
    if (origin === REMOTE) return;
    const own = [...added, ...updated, ...removed].filter((id) => id === this.ydoc.clientID);
    if (own.length > 0) this.send({ type: 'awareness', clientId: this.ydoc.clientID, update: toBase64(encodeAwarenessUpdate(this.awareness, own)) });
  };

  private send(message: ClientSocketMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
}
