import { EventEmitter } from 'node:events';
import type { DocumentEvent } from '@collab/protocol';

/** In-process event bus per document (SPEC §3); no queue, no replay across restarts. */
export class AppEventBus {
  private readonly emitter = new EventEmitter();
  private sequence = 0;

  constructor() {
    // Every open SSE stream of a document is one listener.
    this.emitter.setMaxListeners(0);
  }

  publish(event: Omit<DocumentEvent, 'id'>): DocumentEvent {
    const value: DocumentEvent = { ...event, id: String(++this.sequence) };
    this.emitter.emit(`doc:${event.docId}`, value);
    return value;
  }

  subscribe(docId: string, listener: (event: DocumentEvent) => void): () => void {
    const key = `doc:${docId}`;
    this.emitter.on(key, listener);
    return () => this.emitter.off(key, listener);
  }
}
