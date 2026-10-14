import * as Y from 'yjs';
import type { Result } from './result.js';

export interface DocumentChange { update: Uint8Array; origin?: unknown }
export type DocumentListener = (change: DocumentChange) => void;

export interface DocumentHandle {
  readonly id: string;
  getText(): string;
  applyUpdate(update: Uint8Array, origin?: unknown): void;
  encodeStateAsUpdate(): Uint8Array;
  createRelativePosition(index: number, assoc?: number): Y.RelativePosition;
  resolveRelativePosition(position: Y.RelativePosition): number | null;
  transact(fn: () => void, origin?: unknown): void;
  subscribe(listener: DocumentListener): () => void;
  ydoc: Y.Doc;
}

export class YjsDocument implements DocumentHandle {
  readonly ydoc: Y.Doc;
  private readonly text: Y.Text;
  private readonly listeners = new Set<DocumentListener>();
  constructor(readonly id: string, initialText = '') {
    this.ydoc = new Y.Doc();
    this.text = this.ydoc.getText('content');
    if (initialText) this.text.insert(0, initialText);
    this.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      for (const listener of this.listeners) listener({ update, origin });
    });
  }
  getText(): string { return this.text.toString(); }
  applyUpdate(update: Uint8Array, origin?: unknown): void { Y.applyUpdate(this.ydoc, update, origin); }
  encodeStateAsUpdate(): Uint8Array { return Y.encodeStateAsUpdate(this.ydoc); }
  createRelativePosition(index: number, assoc = 0): Y.RelativePosition { return Y.createRelativePositionFromTypeIndex(this.text, index, assoc); }
  resolveRelativePosition(position: Y.RelativePosition): number | null {
    const absolute = Y.createAbsolutePositionFromRelativePosition(position, this.ydoc);
    return absolute?.index ?? null;
  }
  transact(fn: () => void, origin?: unknown): void { this.ydoc.transact(fn, origin); }
  subscribe(listener: DocumentListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  replace(start: number, end: number, value: string, origin?: unknown): Result<void, 'range-out-of-bounds'> {
    if (start < 0 || end < start || end > this.text.length) return { ok: false, error: 'range-out-of-bounds' };
    this.ydoc.transact(() => { this.text.delete(start, end - start); if (value) this.text.insert(start, value); }, origin);
    return { ok: true, value: undefined };
  }
}
