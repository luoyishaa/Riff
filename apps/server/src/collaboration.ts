import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { can } from '@collab/kernel';
import type { ReviewService } from '@collab/review';
import { clientSocketMessageSchema, type MemberDto, type ServerSocketMessage } from '@collab/protocol';
import type { AppEventBus } from './events.js';
import type { DocumentStore } from './infra/document-store.js';
import type { LocalProjectService } from './infra/local-project.js';

/** SPEC §6: pending suggestions are re-evaluated after edits settle, not on every keystroke. */
const REVIEW_REFRESH_DELAY_MS = 300;
/** Local files are written back once typing pauses instead of on every update. */
const LOCAL_WRITE_DELAY_MS = 500;

interface Peer { principalId: string; awareness: Map<number, string> }

interface Room {
  peers: Map<WebSocket, Peer>;
  unsubscribe: () => void;
  timers: { review?: ReturnType<typeof setTimeout>; local?: ReturnType<typeof setTimeout> };
}

export interface CollaborationOptions {
  store: DocumentStore;
  events: AppEventBus;
  reviewService: ReviewService;
  localProject: LocalProjectService;
  now: () => number;
  /** Members (people and visible agents) the viewer may see in this document. */
  visibleMembers: (docId: string, viewerId: string) => MemberDto[];
  /** Resolves the session principal of an upgrade request. */
  principalId: (request: IncomingMessage) => string;
}

function send(socket: WebSocket, message: ServerSocketMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

/**
 * One room per open document: persists Yjs updates, relays them and
 * y-protocols awareness (remote cursors) between sockets, and schedules the
 * follow-up work an edit causes.
 */
export class Collaboration {
  private readonly rooms = new Map<string, Room>();
  private readonly sockets = new WebSocketServer({ noServer: true });

  constructor(private readonly options: CollaborationOptions) {}

  /** Start persisting and relaying a document's updates; safe to call repeatedly. */
  open(docId: string): boolean {
    return this.room(docId) !== undefined;
  }

  private room(docId: string): Room | undefined {
    const existing = this.rooms.get(docId);
    if (existing) return existing;
    const record = this.options.store.get(docId);
    if (!record) return undefined;
    const room: Room = { peers: new Map(), timers: {}, unsubscribe: () => undefined };
    room.unsubscribe = record.handle.subscribe(({ update, origin }) => {
      this.options.store.persistUpdate(docId, update);
      if (!this.options.localProject.isDiskOrigin(origin)) this.schedule(room, 'local', LOCAL_WRITE_DELAY_MS, () => this.options.localProject.onDocumentUpdate(docId));
      this.schedule(room, 'review', REVIEW_REFRESH_DELAY_MS, () => this.options.reviewService.refreshPending(docId));
      this.options.events.publish({ type: 'document.changed', docId, occurredAt: this.options.now(), data: {} });
      const payload: ServerSocketMessage = { type: 'sync', update: Buffer.from(update).toString('base64') };
      for (const socket of room.peers.keys()) if (socket !== origin) send(socket, payload);
    });
    this.rooms.set(docId, room);
    return room;
  }

  /** Disconnect everyone and stop all work for a deleted document. */
  close(docId: string): void {
    const room = this.rooms.get(docId);
    if (!room) return;
    room.unsubscribe();
    if (room.timers.review !== undefined) clearTimeout(room.timers.review);
    if (room.timers.local !== undefined) clearTimeout(room.timers.local);
    for (const socket of room.peers.keys()) socket.close(1000, 'document deleted');
    this.rooms.delete(docId);
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const match = new URL(request.url ?? '/', 'http://localhost').pathname.match(/^\/ws\/docs\/([^/]+)$/u);
    const docId = match?.[1] ? decodeURIComponent(match[1]) : undefined;
    if (docId === undefined) { socket.destroy(); return; }
    const principalId = this.options.principalId(request);
    this.sockets.handleUpgrade(request, socket, head, (ws) => this.connect(ws, docId, principalId));
  }

  private connect(ws: WebSocket, docId: string, principalId: string): void {
    const record = this.options.store.get(docId);
    const room = this.room(docId);
    if (!record || !room || this.options.store.role(docId, principalId) === null) { ws.close(1008, 'not a member'); return; }
    const peer: Peer = { principalId, awareness: new Map() };
    room.peers.set(ws, peer);
    send(ws, { type: 'sync', update: Buffer.from(record.handle.encodeStateAsUpdate()).toString('base64') });
    for (const other of room.peers.values()) for (const update of other.awareness.values()) send(ws, { type: 'awareness', update });
    this.broadcastMembers(docId, room);
    ws.on('message', (raw: RawData) => this.receive(ws, docId, room, peer, raw));
    ws.on('close', () => {
      room.peers.delete(ws);
      if (peer.awareness.size > 0) {
        for (const socket of room.peers.keys()) send(socket, { type: 'awareness-leave', clientIds: [...peer.awareness.keys()] });
      }
      this.broadcastMembers(docId, room);
    });
  }

  private receive(ws: WebSocket, docId: string, room: Room, peer: Peer, raw: RawData): void {
    let value: unknown;
    try { value = JSON.parse(raw.toString()); } catch { return; }
    const message = clientSocketMessageSchema.safeParse(value);
    if (!message.success) return;
    if (message.data.type === 'sync') {
      // Roles can change while a socket is open, so permission is checked per update.
      const role = this.options.store.role(docId, peer.principalId);
      if (role !== null && can(role, 'edit')) this.options.store.get(docId)?.handle.applyUpdate(new Uint8Array(Buffer.from(message.data.update, 'base64')), ws);
      return;
    }
    peer.awareness.set(message.data.clientId, message.data.update);
    for (const socket of room.peers.keys()) if (socket !== ws) send(socket, { type: 'awareness', update: message.data.update });
  }

  private broadcastMembers(docId: string, room: Room): void {
    const online = new Set([...room.peers.values()].map((peer) => peer.principalId));
    for (const [socket, peer] of room.peers) {
      send(socket, { type: 'members', members: this.options.visibleMembers(docId, peer.principalId).filter((member) => online.has(member.id)) });
    }
  }

  private schedule(room: Room, timer: keyof Room['timers'], delay: number, work: () => void): void {
    if (room.timers[timer] !== undefined) clearTimeout(room.timers[timer]);
    room.timers[timer] = setTimeout(() => {
      delete room.timers[timer];
      work();
    }, delay);
  }
}
