import { useEffect, useRef, useState } from 'react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type { DocumentKind } from '@collab/protocol';
import type { DocumentConnection } from '../collab/connection.js';
import { resolveRange, trackRange, type TrackedRange } from '../collab/trackedRange.js';
import type { MentionCandidate } from '../lib/mentions.js';
import { flashRange, reviewExtensions, reviewHandlers, setCommentTarget, setReviewMarks, type ReviewHandlers, type ReviewMarks } from './reviewDecorations.js';
import { COMPOSER_WIDTH, InlineComposer, SelectionBubble, type OverlayPosition } from './SelectionTools.js';
import { editorTheme, markdownSupport } from './theme.js';

export interface FocusRequest { start: number; end: number; nonce: number; select?: boolean }
export interface CommentRange { start: number; end: number; quote: string }

export interface EditorProps {
  connection: DocumentConnection;
  synced: boolean;
  editable: boolean;
  kind: DocumentKind;
  marks: ReviewMarks;
  focus: FocusRequest | undefined;
  canComment: boolean;
  members: MentionCandidate[];
  onOpenThread: (threadId: string) => void;
  onDecide: (suggestionId: string, action: 'accept' | 'reject') => void;
  /** Resolves true once the comment thread exists. */
  onComment: (range: CommentRange, body: string) => Promise<boolean>;
  onSelectionLength: (length: number) => void;
}

const FLASH_MS = 1400;
const editability = (editable: boolean): Extension => EditorState.readOnly.of(!editable);

export function Editor(props: EditorProps): React.ReactElement {
  const { connection, synced, editable, kind, marks, focus, canComment, members } = props;
  const wrapper = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>();
  const compartments = useRef({ editable: new Compartment(), language: new Compartment() });
  const latest = useRef(props);
  latest.current = props;
  const [bubble, setBubble] = useState<OverlayPosition>();
  const [composer, setComposer] = useState<{ range: TrackedRange; quote: string; position: OverlayPosition }>();
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const selecting = useRef(false);

  /** Overlay coordinates below `pos`, relative to the editor surface. */
  const place = (view: EditorView, pos: number): OverlayPosition | undefined => {
    const coords = view.coordsAtPos(pos);
    const box = wrapper.current?.getBoundingClientRect();
    if (!coords || !box || coords.bottom < box.top || coords.top > box.bottom) return undefined;
    return { top: coords.bottom - box.top + 8, left: Math.max(12, Math.min(box.width - COMPOSER_WIDTH - 12, coords.left - box.left - 24)) };
  };

  const reposition = (): void => {
    const view = viewRef.current;
    if (!view) return;
    const open = composerRef.current;
    if (open) {
      const range = resolveRange(connection.ytext, open.range);
      const position = range ? place(view, range.end) : undefined;
      if (position) setComposer({ ...open, position });
      return;
    }
    const selection = view.state.selection.main;
    setBubble(!selection.empty && latest.current.canComment && !selecting.current ? place(view, selection.to) : undefined);
  };

  useEffect(() => {
    if (!host.current) return undefined;
    const handlers: ReviewHandlers = {
      openThread: (threadId) => latest.current.onOpenThread(threadId),
      decide: (suggestionId, action) => latest.current.onDecide(suggestionId, action),
    };
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: connection.ytext.toString(),
        extensions: [
          compartments.current.editable.of(editability(false)),
          compartments.current.language.of([]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': '文档正文', spellcheck: 'false' }),
          drawSelection(),
          placeholder('开始写作…'),
          keymap.of([...yUndoManagerKeymap, ...defaultKeymap]),
          yCollab(connection.ytext, connection.awareness, { undoManager: connection.undoManager }),
          editorTheme,
          reviewExtensions,
          reviewHandlers.of(handlers),
          EditorView.updateListener.of((update) => {
            if (update.selectionSet) {
              const selection = update.state.selection.main;
              latest.current.onSelectionLength(selection.to - selection.from);
            }
            if (update.selectionSet || update.docChanged || update.geometryChanged) window.requestAnimationFrame(reposition);
          }),
        ],
      }),
    });
    viewRef.current = view;
    const onScroll = (): void => { window.requestAnimationFrame(reposition); };
    const onPointerDown = (event: PointerEvent): void => {
      if ((event.target as Element | null)?.closest('.cm-content')) { selecting.current = true; setBubble(undefined); }
    };
    const onPointerUp = (): void => {
      if (!selecting.current) return;
      selecting.current = false;
      window.requestAnimationFrame(reposition);
    };
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    view.dom.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointerup', onPointerUp);
    return () => {
      view.scrollDOM.removeEventListener('scroll', onScroll);
      view.dom.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('pointerup', onPointerUp);
      view.destroy();
      viewRef.current = undefined;
      setBubble(undefined);
      setComposer(undefined);
    };
    // The view lives as long as the document connection.
  }, [connection]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.current.editable.reconfigure(editability(editable && synced)) });
  }, [editable, synced]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.current.language.reconfigure(kind === 'markdown' ? markdownSupport : []) });
  }, [kind]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setReviewMarks.of(marks) });
  }, [marks]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !focus) return undefined;
    const length = view.state.doc.length;
    const start = Math.max(0, Math.min(focus.start, length));
    const end = Math.max(start, Math.min(focus.end, length));
    view.dispatch({
      effects: [EditorView.scrollIntoView(start, { y: 'center' }), flashRange.of({ start, end })],
      ...(focus.select ? { selection: { anchor: start, head: end } } : {}),
    });
    const timer = window.setTimeout(() => viewRef.current?.dispatch({ effects: flashRange.of(null) }), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [focus]);

  const openComposer = (): void => {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const position = place(view, to);
    if (from === to || !position) return;
    setBubble(undefined);
    setComposer({ range: trackRange(connection.ytext, from, to), quote: view.state.sliceDoc(from, to), position });
    view.dispatch({ effects: setCommentTarget.of({ start: from, end: to }) });
  };

  const closeComposer = (): void => {
    setComposer(undefined);
    viewRef.current?.dispatch({ effects: setCommentTarget.of(null) });
  };

  const submitComment = async (body: string): Promise<boolean> => {
    const open = composerRef.current;
    const range = open ? resolveRange(connection.ytext, open.range) : undefined;
    if (!open || !range) {
      closeComposer();
      return false;
    }
    const posted = await props.onComment({ ...range, quote: connection.ytext.toString().slice(range.start, range.end) }, body);
    if (posted) {
      closeComposer();
      // The selection has served its purpose; keeping it would bring the bubble back.
      viewRef.current?.dispatch({ selection: { anchor: range.end } });
    }
    return posted;
  };

  return (
    <div ref={wrapper} className={`editor-surface${synced ? '' : ' is-loading'}`}>
      <div ref={host} className="editor-host" />
      {!synced ? <div className="editor-loading" role="status">正在载入文档…</div> : null}
      {bubble && !composer && canComment ? <SelectionBubble position={bubble} onComment={openComposer} /> : null}
      {composer ? <InlineComposer position={composer.position} quote={composer.quote} members={members} onSubmit={submitComment} onCancel={closeComposer} /> : null}
    </div>
  );
}
