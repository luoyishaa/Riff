import { EventEmitter } from 'node:events';
import type { ReviewEvent } from '@collab/review';

export interface AppEvent { id: string; type: ReviewEvent['type'] | 'document.changed' | 'agent.status'; docId: string; occurredAt: number; data: unknown }
export class AppEventBus {
  private readonly emitter = new EventEmitter();
  private sequence = 0;
  publish(event: Omit<AppEvent, 'id'>): AppEvent {
    const value = { ...event, id: String(++this.sequence) };
    this.emitter.emit(`doc:${event.docId}`, value);
    return value;
  }
  subscribe(docId: string, listener: (event: AppEvent) => void): () => void {
    const key = `doc:${docId}`; this.emitter.on(key, listener); return () => this.emitter.off(key, listener);
  }
}
