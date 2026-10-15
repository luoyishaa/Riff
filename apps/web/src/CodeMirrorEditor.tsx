import { useEffect, useRef } from 'react';
import { Compartment, EditorState, StateEffect } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';

export type EditorSelection = { start: number; end: number };

export interface CodeMirrorEditorProps {
  value: string;
  editable: boolean;
  onChange: (value: string) => void;
  onSelectionChange?: (selection: EditorSelection) => void;
  className?: string;
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
  className,
}: CodeMirrorEditorProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const editableCompartmentRef = useRef<Compartment | null>(null);

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
        keymap.of([...defaultKeymap, indentWithTab]),
        editableCompartment.of([
          EditorState.readOnly.of(!editable),
          EditorView.editable.of(editable),
        ]),
        EditorView.theme({
          '&': { height: '480px', border: '1px solid #cbd2df', borderRadius: '8px' },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit', lineHeight: '1.7' },
          '.cm-content': { padding: '16px', minHeight: '448px' },
          '.cm-gutters': { borderRight: '1px solid #edf0f5', backgroundColor: '#fafbfc' },
          '&.cm-focused': { outline: '2px solid #b5c8ff', outlineOffset: '1px' },
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

  return <div ref={hostRef} className={className ?? 'cm-editor-shell'} />;
}
