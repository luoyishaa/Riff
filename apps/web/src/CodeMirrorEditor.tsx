import { useEffect, useRef, useState } from 'react';
import { Compartment, EditorState, StateEffect } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { MarkdownPreview, type MarkdownPreviewAction, type MarkdownPreviewSelection } from './MarkdownPreview.js';
import { InlineSelectionComposer, type InlineComposerMode, type InlineMember } from './InlineSelectionComposer.js';

export type EditorSelection = { start: number; end: number };

export interface CodeMirrorEditorProps {
  value: string;
  editable: boolean;
  onChange: (value: string) => void;
  onSelectionChange?: (selection: EditorSelection) => void;
  onPreviewSelectionChange?: (selection: MarkdownPreviewSelection | null) => void;
  onPreviewAction?: (action: MarkdownPreviewAction) => void;
  onInlineActionSubmit?: (action: MarkdownPreviewAction, body: string) => void | Promise<void>;
  members?: InlineMember[];
  onViewModeChange?: (mode: 'source' | 'preview') => void;
  /** Source offsets used by the document outline to reveal the matching block. */
  outlineTarget?: EditorSelection | null;
  className?: string;
  /** Markdown documents expose a preview while plain text remains source-only. */
  documentKind?: 'text' | 'markdown';
}

const remoteTransaction = StateEffect.define<boolean>();

/**
 * A small React wrapper around CodeMirror's stateful editor. The document value
 * remains owned by the parent (and, in this app, by Yjs); local transactions
 * are reported through onChange and remote transactions are applied without
 * echoing them back to the parent.
 */
export function CodeMirrorEditor({
  value,
  editable,
  onChange,
  onSelectionChange,
  onPreviewSelectionChange,
  onPreviewAction,
  onInlineActionSubmit,
  members = [],
  onViewModeChange,
  outlineTarget,
  className,
  documentKind = 'text',
}: CodeMirrorEditorProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sourcePaneRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const editableCompartmentRef = useRef<Compartment | null>(null);
  const [viewMode, setViewMode] = useState<'source' | 'preview'>('source');
  const [sourceMenu, setSourceMenu] = useState<{ top: number; left: number } | null>(null);
  const [sourceComposer, setSourceComposer] = useState<{ top: number; left: number; mode: InlineComposerMode } | null>(null);
  const isMarkdown = documentKind === 'markdown';

  onChangeRef.current = onChange;
  onSelectionChangeRef.current = onSelectionChange;
  valueRef.current = value;

  useEffect(() => {
    if (!hostRef.current) return undefined;

    const editorHost = hostRef.current;
    const editableCompartment = new Compartment();
    // Keep the compartment in a ref so role changes can reconfigure the same
    // editor without recreating it or losing the current selection.
    editableCompartmentRef.current = editableCompartment;

    const editorState = EditorState.create({
      doc: valueRef.current,
      extensions: [
        lineNumbers(),
        EditorView.lineWrapping,
        keymap.of([...defaultKeymap, indentWithTab]),
        editableCompartment.of([
          EditorState.readOnly.of(!editable),
          EditorView.editable.of(editable),
        ]),
        EditorView.theme({
          '&': { height: '480px', backgroundColor: '#fcfbf8', color: '#25231f' },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit', lineHeight: '1.78' },
          '.cm-content': { padding: '34px 34px', minHeight: '448px', maxWidth: '78ch' },
          '.cm-line': { padding: '0 0 2px' },
          '.cm-gutters': { borderRight: '1px solid #e7e1d7', backgroundColor: '#f8f6f0', color: '#a49e93' },
          '.cm-activeLine': { backgroundColor: '#f7f1eb' },
          '.cm-activeLineGutter': { color: '#a7463b', backgroundColor: '#f3e4de' },
          '.cm-selectionBackground, ::selection': { backgroundColor: '#ead1ca !important' },
          '&.cm-focused': { outline: 'none' },
        }),
        // A marker lets the listener distinguish a parent/Yjs update from a
        // user edit. It is deliberately a transaction effect, not a global
        // mutable flag, so updates remain safe when transactions are queued.
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(remoteTransaction)))) {
            const next = update.state.doc.toString();
            valueRef.current = next;
            onChangeRef.current(next);
          }
          if (update.selectionSet) {
            const selection = update.state.selection.main;
            if (selection.empty) {
              setSourceMenu(null);
            } else {
              const coords = view.coordsAtPos(selection.to);
              const pane = sourcePaneRef.current;
              if (coords && pane) {
                const paneRect = pane.getBoundingClientRect();
                const width = 170;
                const belowTop = coords.bottom - paneRect.top + 8;
                setSourceMenu({
                  top: belowTop,
                  left: Math.max(8, Math.min(paneRect.width - width - 8, coords.left - paneRect.left)),
                });
              }
            }
            onSelectionChangeRef.current?.({ start: selection.from, end: selection.to });
          }
        }),
      ],
    });
    const view = new EditorView({ state: editorState, parent: editorHost });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
      editableCompartmentRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const compartment = editableCompartmentRef.current;
    if (!compartment) return;
    view.dispatch({
      effects: compartment.reconfigure([
        EditorState.readOnly.of(!editable),
        EditorView.editable.of(editable),
      ]),
    });
  }, [editable]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      effects: remoteTransaction.of(true),
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || viewMode !== 'source' || !outlineTarget) return;
    const start = Math.max(0, Math.min(outlineTarget.start, view.state.doc.length));
    const end = Math.max(start, Math.min(outlineTarget.end, view.state.doc.length));
    view.dispatch({
      selection: { anchor: start, head: end },
      effects: EditorView.scrollIntoView(start, { y: 'center' }),
    });
  }, [outlineTarget, viewMode]);

  useEffect(() => {
    setSourceMenu(null);
    setSourceComposer(null);
  }, [viewMode]);

  useEffect(() => {
    setSourceMenu(null);
    setSourceComposer(null);
  }, [value]);

  const openSourceComposer = (mode: InlineComposerMode) => {
    if (!sourceMenu) return;
    setSourceComposer({ ...sourceMenu, mode });
    setSourceMenu(null);
    onPreviewAction?.(mode);
  };

  return (
    <div className={`document-editor-shell${isMarkdown ? ' document-editor-shell-markdown' : ''}`}>
      {isMarkdown ? (
        <div className="document-editor-view-switch" role="group" aria-label="Markdown 文档视图">
          <button
            type="button"
            className={`document-editor-view-button${viewMode === 'source' ? ' selected' : ''}`}
            aria-pressed={viewMode === 'source'}
            onClick={() => { setViewMode('source'); onViewModeChange?.('source'); }}
          >
            源码
          </button>
          <button
            type="button"
            className={`document-editor-view-button${viewMode === 'preview' ? ' selected' : ''}`}
            aria-pressed={viewMode === 'preview'}
            onClick={() => { setViewMode('preview'); onViewModeChange?.('preview'); }}
          >
            预览
          </button>
        </div>
      ) : null}
      <div ref={sourcePaneRef} className={`document-editor-pane document-editor-source-pane${isMarkdown && viewMode === 'preview' ? ' is-hidden' : ''}`} aria-hidden={isMarkdown && viewMode === 'preview'}>
        {sourceMenu ? (
          <div className="source-selection-menu" role="toolbar" aria-label="选区操作" style={{ top: sourceMenu.top, left: sourceMenu.left }}>
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => openSourceComposer('comment')}>评论</button>
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => openSourceComposer('suggestion')}>建议修改</button>
          </div>
        ) : null}
        {sourceComposer && onInlineActionSubmit ? (
          <InlineSelectionComposer
            mode={sourceComposer.mode}
            top={sourceComposer.top}
            left={sourceComposer.left}
            members={members}
            onCancel={() => setSourceComposer(null)}
            onSubmit={(body) => {
              const mode = sourceComposer.mode;
              setSourceComposer(null);
              void onInlineActionSubmit(mode, body);
            }}
          />
        ) : null}
        <div ref={hostRef} className={className ?? 'cm-editor-shell'} />
      </div>
      {isMarkdown ? (
        <div className={`document-editor-pane document-editor-preview-pane${viewMode === 'source' ? ' is-hidden' : ''}`} aria-hidden={viewMode === 'source'}>
          <MarkdownPreview
            value={value}
            active={viewMode === 'preview'}
            {...(outlineTarget ? { scrollTo: outlineTarget } : {})}
            {...(onPreviewSelectionChange ? { onSelectionChange: onPreviewSelectionChange } : {})}
            {...(onPreviewAction ? { onAction: onPreviewAction } : {})}
            {...(onInlineActionSubmit ? { onInlineActionSubmit } : {})}
            members={members}
          />
        </div>
      ) : null}
    </div>
  );
}
