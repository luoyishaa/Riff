import * as Y from 'yjs';
import type { DocumentHandle } from './document.js';

export interface SerializedRelativePosition { type: string; item: string | null; assoc: number }
export interface Anchor { start: SerializedRelativePosition; end: SerializedRelativePosition; quote: string }
export type AnchorResolution =
  | { status: 'exact'; start: number; end: number; anchor: Anchor }
  | { status: 'relocated'; start: number; end: number; anchor: Anchor }
  | { status: 'detached'; anchor: Anchor };

function encode(position: Y.RelativePosition): SerializedRelativePosition {
  const toString = (id: Y.ID | null): string => id ? `${id.client}:${id.clock}` : '';
  return { type: toString(position.type), item: position.item ? toString(position.item) : null, assoc: position.assoc };
}
function decode(position: SerializedRelativePosition): Y.RelativePosition {
  const parse = (value: string | null): Y.ID | null => {
    if (!value) return null;
    const [clientText, clockText] = value.split(':');
    if (clientText === undefined || clockText === undefined) throw new Error('invalid relative position id');
    return { client: Number(clientText), clock: Number(clockText) };
  };
  return new Y.RelativePosition(parse(position.type), null, parse(position.item), position.assoc);
}
export function serializePosition(position: Y.RelativePosition): SerializedRelativePosition { return encode(position); }
export function createAnchor(document: DocumentHandle, start: number, end: number): Anchor {
  if (start < 0 || end < start || end > document.getText().length) throw new RangeError('anchor range out of bounds');
  return { start: encode(document.createRelativePosition(start, 0)), end: encode(document.createRelativePosition(end, -1)), quote: document.getText().slice(start, end) };
}
function uniqueMatches(text: string, quote: string): number[] {
  if (!quote) return [];
  const positions: number[] = []; let from = 0;
  while (true) { const index = text.indexOf(quote, from); if (index < 0) return positions; positions.push(index); from = index + 1; }
}
export function resolveAnchor(document: DocumentHandle, anchor: Anchor): AnchorResolution {
  const start = document.resolveRelativePosition(decode(anchor.start));
  const end = document.resolveRelativePosition(decode(anchor.end));
  const text = document.getText();
  if (start !== null && end !== null && start <= end && text.slice(start, end) === anchor.quote) return { status: 'exact', start, end, anchor };
  const matches = uniqueMatches(text, anchor.quote);
  if (matches.length === 1) {
    const match = matches[0];
    if (match === undefined) return { status: 'detached', anchor };
    const next = createAnchor(document, match, match + anchor.quote.length);
    return { status: 'relocated', start: match, end: match + anchor.quote.length, anchor: next };
  }
  return { status: 'detached', anchor };
}
