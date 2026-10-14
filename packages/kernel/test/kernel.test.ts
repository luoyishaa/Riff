import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { YjsDocument, can, createAnchor, resolveAnchor } from '../src/index.js';

describe('permissions', () => {
  it('uses the role matrix', () => {
    expect(can('viewer', 'view')).toBe(true);
    expect(can('viewer', 'edit')).toBe(false);
    expect(can('suggester', 'suggest')).toBe(true);
    expect(can('editor', 'approve')).toBe(true);
  });
});
describe('anchors', () => {
  it('survives inserts at both range boundaries without changing the quote', () => {
    const doc = new YjsDocument('d', 'hello world');
    const anchor = createAnchor(doc, 6, 11);
    doc.ydoc.getText('content').insert(6, 'new ');
    doc.ydoc.getText('content').insert(15, '!');
    const resolved = resolveAnchor(doc, anchor);
    expect(resolved.status).toBe('exact');
    if (resolved.status === 'exact') expect(doc.getText().slice(resolved.start, resolved.end)).toBe('world');
  });
  it('relocates a unique quote and detaches ambiguous quotes', () => {
    const doc = new YjsDocument('d', 'alpha beta');
    const anchor = createAnchor(doc, 6, 10);
    doc.replace(6, 10, 'gamma');
    expect(resolveAnchor(doc, anchor).status).toBe('detached');
    const second = new YjsDocument('d2', 'x beta y');
    const a2 = createAnchor(second, 2, 6);
    second.replace(2, 6, 'changed');
    second.replace(0, 0, 'beta ');
    expect(resolveAnchor(second, a2).status).toBe('relocated');
  });
});
describe('convergence', () => {
  it('applies updates from two clients to one canonical document', () => {
    const a = new YjsDocument('d', ''); const b = new YjsDocument('d', '');
    a.ydoc.getText('content').insert(0, 'A'); b.ydoc.getText('content').insert(0, 'B');
    const mergedA = new Y.Doc(); const mergedB = new Y.Doc();
    Y.applyUpdate(mergedA, a.encodeStateAsUpdate()); Y.applyUpdate(mergedA, b.encodeStateAsUpdate());
    Y.applyUpdate(mergedB, b.encodeStateAsUpdate()); Y.applyUpdate(mergedB, a.encodeStateAsUpdate());
    expect(mergedA.getText('content').toString()).toBe(mergedB.getText('content').toString());
  });
});
