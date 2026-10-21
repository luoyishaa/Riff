import { Facet, StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

export interface ThreadMark { threadId: string; start: number; end: number; unread: boolean; active: boolean }
export interface SuggestionMark { id: string; threadId?: string; start: number; end: number; newText: string; decidable: boolean }
export interface WorkingMark { threadId: string; at: number; label: string }
export interface ReviewMarks { threads: ThreadMark[]; suggestions: SuggestionMark[]; working: WorkingMark[] }

export interface ReviewHandlers {
  openThread: (threadId: string) => void;
  decide: (suggestionId: string, action: 'accept' | 'reject') => void;
}

const noHandlers: ReviewHandlers = { openThread: () => undefined, decide: () => undefined };
export const reviewHandlers = Facet.define<ReviewHandlers, ReviewHandlers>({ combine: (values) => values[values.length - 1] ?? noHandlers });

export const setReviewMarks = StateEffect.define<ReviewMarks>();
export const setCommentTarget = StateEffect.define<{ start: number; end: number } | null>();
export const flashRange = StateEffect.define<{ start: number; end: number } | null>();

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The proposed text, shown after the struck-through original (SPEC §9 inline diff). */
class SuggestionWidget extends WidgetType {
  constructor(private readonly mark: SuggestionMark) { super(); }
  override eq(other: SuggestionWidget): boolean {
    return other.mark.id === this.mark.id && other.mark.newText === this.mark.newText && other.mark.decidable === this.mark.decidable;
  }
  toDOM(view: EditorView): HTMLElement {
    const wrapper = element('span', 'cm-suggestion');
    if (this.mark.newText) {
      const added = element('ins', 'cm-suggestion-new', this.mark.newText);
      added.title = '打开这条建议所在的讨论';
      added.addEventListener('mousedown', (event) => {
        event.preventDefault();
        if (this.mark.threadId) view.state.facet(reviewHandlers).openThread(this.mark.threadId);
      });
      wrapper.append(added);
    }
    if (this.mark.decidable) {
      for (const [action, label, symbol] of [['accept', '接受这条修改', '✓'], ['reject', '拒绝这条修改', '✕']] as const) {
        const button = element('button', `cm-suggestion-action ${action}`, symbol);
        button.setAttribute('type', 'button');
        button.setAttribute('aria-label', label);
        button.title = label;
        button.addEventListener('mousedown', (event) => {
          event.preventDefault();
          view.state.facet(reviewHandlers).decide(this.mark.id, action);
        });
        wrapper.append(button);
      }
    }
    return wrapper;
  }
}

class WorkingWidget extends WidgetType {
  constructor(private readonly label: string) { super(); }
  override eq(other: WorkingWidget): boolean { return other.label === this.label; }
  toDOM(): HTMLElement {
    const pill = element('span', 'cm-agent-working');
    pill.append(element('span', 'cm-agent-working-dot'), document.createTextNode(this.label));
    return pill;
  }
}

function buildMarks(marks: ReviewMarks, length: number): DecorationSet {
  const inside = (start: number, end: number): boolean => start >= 0 && end <= length && start <= end;
  const ranges: Array<Range<Decoration>> = [];
  for (const thread of marks.threads) {
    if (!inside(thread.start, thread.end) || thread.start === thread.end) continue;
    const className = `cm-thread-mark${thread.unread ? ' is-unread' : ''}${thread.active ? ' is-active' : ''}`;
    ranges.push(Decoration.mark({ class: className, attributes: { 'data-thread-id': thread.threadId } }).range(thread.start, thread.end));
  }
  for (const suggestion of marks.suggestions) {
    if (!inside(suggestion.start, suggestion.end)) continue;
    if (suggestion.end > suggestion.start) {
      ranges.push(Decoration.mark({ class: 'cm-suggestion-old', attributes: suggestion.threadId ? { 'data-thread-id': suggestion.threadId } : {} }).range(suggestion.start, suggestion.end));
    }
    ranges.push(Decoration.widget({ widget: new SuggestionWidget(suggestion), side: 1 }).range(suggestion.end));
  }
  for (const working of marks.working) {
    if (inside(working.at, working.at)) ranges.push(Decoration.widget({ widget: new WorkingWidget(working.label), side: 2 }).range(working.at));
  }
  return Decoration.set(ranges, true);
}

/** Server positions are replaced when fresh data arrives and mapped through every edit in between. */
const reviewField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(setReviewMarks)) next = buildMarks(effect.value, transaction.state.doc.length);
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function rangeField(className: string, effect: typeof setCommentTarget) {
  return StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, transaction) {
      let next = value.map(transaction.changes);
      for (const item of transaction.effects) {
        if (!item.is(effect)) continue;
        const range = item.value;
        next = range && range.end > range.start && range.end <= transaction.state.doc.length
          ? Decoration.set([Decoration.mark({ class: className }).range(range.start, range.end)])
          : Decoration.none;
      }
      return next;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

/** A plain click on marked text opens its discussion; a drag that selects text does not. */
const openThreadOnClick = EditorView.domEventHandlers({
  click(event, view) {
    if (event.button !== 0 || !view.state.selection.main.empty) return false;
    const target = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
    const threadId = target?.closest<HTMLElement>('[data-thread-id]')?.dataset.threadId;
    if (threadId) view.state.facet(reviewHandlers).openThread(threadId);
    return false;
  },
});

export const reviewExtensions = [reviewField, rangeField('cm-comment-target', setCommentTarget), rangeField('cm-flash', flashRange), openThreadOnClick];
