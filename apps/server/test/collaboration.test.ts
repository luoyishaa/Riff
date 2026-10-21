import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import * as Y from 'yjs';
import type { ServerSocketMessage } from '@collab/protocol';
import { createServer } from '../src/server.js';

let app: FastifyInstance;
let base: string;

/** A socket that records every frame, so a test can wait for one that matches. */
class Client {
  readonly frames: ServerSocketMessage[] = [];
  readonly socket: WebSocket;
  constructor(principalId: string) {
    this.socket = new WebSocket(`${base}/ws/docs/demo-doc`, { headers: { 'x-principal-id': principalId } });
    this.socket.on('message', (raw) => this.frames.push(JSON.parse(raw.toString()) as ServerSocketMessage));
  }
  opened(): Promise<void> {
    return new Promise((resolve, reject) => { this.socket.once('open', () => resolve()); this.socket.once('error', reject); });
  }
  send(message: unknown): void { this.socket.send(JSON.stringify(message)); }
  async next<T extends ServerSocketMessage['type']>(type: T, predicate: (frame: Extract<ServerSocketMessage, { type: T }>) => boolean = () => true): Promise<Extract<ServerSocketMessage, { type: T }>> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const frame = this.frames.find((item): item is Extract<ServerSocketMessage, { type: T }> => item.type === type && predicate(item as Extract<ServerSocketMessage, { type: T }>));
      if (frame) return frame;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no ${type} frame arrived`);
  }
}

function replicaFrom(frame: { update: string }): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(frame.update, 'base64')));
  return doc;
}

function encode(update: Uint8Array): string { return Buffer.from(update).toString('base64'); }

describe('document collaboration socket', () => {
  beforeAll(async () => {
    app = createServer({ dbPath: ':memory:', allowLegacyIdentityHeader: true, logger: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await app.close(); });

  it('relays an editor update to other clients and drops updates from a commenter', async () => {
    const bob = new Client('bob');
    const dan = new Client('dan');
    await Promise.all([bob.opened(), dan.opened()]);
    const bobDoc = replicaFrom(await bob.next('sync'));
    const danDoc = replicaFrom(await dan.next('sync'));
    const original = bobDoc.getText('content').toString();

    let bobUpdate: Uint8Array | undefined;
    bobDoc.on('update', (update: Uint8Array) => { bobUpdate = update; });
    bobDoc.getText('content').insert(0, 'Bob: ');
    bob.send({ type: 'sync', update: encode(bobUpdate ?? new Uint8Array()) });
    const relayed = await dan.next('sync', (frame) => {
      const probe = replicaFrom({ update: encode(Y.encodeStateAsUpdate(danDoc)) });
      Y.applyUpdate(probe, new Uint8Array(Buffer.from(frame.update, 'base64')));
      return probe.getText('content').toString().startsWith('Bob: ');
    });
    Y.applyUpdate(danDoc, new Uint8Array(Buffer.from(relayed.update, 'base64')));
    expect(danDoc.getText('content').toString()).toBe(`Bob: ${original}`);

    let danUpdate: Uint8Array | undefined;
    danDoc.on('update', (update: Uint8Array) => { danUpdate = update; });
    danDoc.getText('content').insert(0, 'Dan: ');
    dan.send({ type: 'sync', update: encode(danUpdate ?? new Uint8Array()) });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const server = await app.inject({ method: 'GET', url: '/api/docs/demo-doc', headers: { 'x-principal-id': 'alice' } });
    expect(server.json().text).toBe(`Bob: ${original}`);
    bob.socket.close();
    dan.socket.close();
  });

  it('relays awareness and announces the peer leaving', async () => {
    const alice = new Client('alice');
    const carol = new Client('carol');
    await Promise.all([alice.opened(), carol.opened()]);
    alice.send({ type: 'awareness', clientId: 42, update: 'YXdhcmVuZXNz' });
    await carol.next('awareness', (frame) => frame.update === 'YXdhcmVuZXNz');
    const late = new Client('bob');
    await late.opened();
    await late.next('awareness', (frame) => frame.update === 'YXdhcmVuZXNz');
    alice.socket.close();
    const leave = await carol.next('awareness-leave');
    expect(leave.clientIds).toEqual([42]);
    carol.socket.close();
    late.socket.close();
  });

  it('reports the members online to each viewer', async () => {
    const alice = new Client('alice');
    await alice.opened();
    const members = await alice.next('members', (frame) => frame.members.some((member) => member.id === 'alice'));
    expect(members.members.map((member) => member.id)).toContain('alice');
    alice.socket.close();
  });
});
