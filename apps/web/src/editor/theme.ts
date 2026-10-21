import { HighlightStyle, LanguageSupport, syntaxHighlighting } from '@codemirror/language';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

/** Layout of the writing surface; colours come from the CSS custom properties in styles.css. */
export const editorTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--ink)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-text)', lineHeight: '1.8', overflow: 'auto' },
  '.cm-content': { maxWidth: 'var(--measure)', margin: '0 auto', padding: '48px var(--sheet-gutter) 40vh', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--selection) !important' },
  '.cm-placeholder': { color: 'var(--faint)', fontStyle: 'normal' },
  '.cm-ySelectionInfo': {
    opacity: '1',
    top: '-1.45em',
    padding: '1px 5px',
    borderRadius: '4px 4px 4px 0',
    fontFamily: 'var(--font-ui)',
    fontSize: '11px',
    fontWeight: '600',
    letterSpacing: '0',
    lineHeight: '1.4',
  },
  '.cm-ySelectionCaret': { borderLeftWidth: '2px', borderRightWidth: '0' },
});

/** Markdown keeps its source characters; highlighting only signals structure. */
const markdownStyle = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.5em', fontWeight: '700', fontFamily: 'var(--font-display)' },
  { tag: tags.heading2, fontSize: '1.3em', fontWeight: '700', fontFamily: 'var(--font-display)' },
  { tag: tags.heading3, fontSize: '1.15em', fontWeight: '700' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: 'var(--accent-ink)', textDecoration: 'underline' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.92em', color: 'var(--accent-ink)' },
  { tag: tags.quote, color: 'var(--ink-soft)', fontStyle: 'italic' },
  // List and heading markers (and other syntax characters) recede; content keeps the ink colour.
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: 'var(--faint)' },
]);

// The bare Markdown grammar: the default `markdown()` also embeds HTML, CSS
// and JavaScript grammars, about 190 KB more bundle for no visible benefit here.
export const markdownSupport = [new LanguageSupport(markdownLanguage), syntaxHighlighting(markdownStyle)];
