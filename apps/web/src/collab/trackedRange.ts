import * as Y from 'yjs';

/** A range that keeps pointing at the same characters while anyone edits the document. */
export interface TrackedRange { start: Y.RelativePosition; end: Y.RelativePosition }

export function trackRange(ytext: Y.Text, start: number, end: number): TrackedRange {
  // The start sticks to the first character and the end to the last, so text
  // typed right before or after the range is not pulled into it.
  return { start: Y.createRelativePositionFromTypeIndex(ytext, start, 0), end: Y.createRelativePositionFromTypeIndex(ytext, end, -1) };
}

/** Current offsets, or undefined once the characters were deleted. */
export function resolveRange(ytext: Y.Text, range: TrackedRange): { start: number; end: number } | undefined {
  const doc = ytext.doc;
  if (!doc) return undefined;
  const start = Y.createAbsolutePositionFromRelativePosition(range.start, doc)?.index;
  const end = Y.createAbsolutePositionFromRelativePosition(range.end, doc)?.index;
  return start !== undefined && end !== undefined && start < end ? { start, end } : undefined;
}
