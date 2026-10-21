import { YjsDocument, createAnchor, resolveAnchor, type Anchor } from '@collab/kernel';
import { MemoryReviewRepository, ReviewService } from '@collab/review';

/**
 * SPEC §12 `eval:concurrency`. Independent Yjs replicas edit one document
 * while their updates reach a server replica — and through it the other
 * clients — in random order and with random delay. Comments and suggestions
 * are anchored with the kernel and tracked by the real review service.
 *
 * Ground truth does not come from anchors: every character gets an identity
 * from the server's observed text deltas, and a suggestion is truly outdated
 * when one of its characters was deleted or text was inserted inside it.
 */
export interface ConcurrencyOptions { clients: number; steps: number; seed: number; document?: string }

export interface ConcurrencyReport {
  seed: number;
  clients: number;
  steps: number;
  /** Every replica holds the same text and state once all updates are delivered. */
  converged: boolean;
  events: { edits: number; comments: number; suggestions: number; deliveries: number };
  anchors: { exact: number; relocated: number; detached: number };
  stale: { outdated: number; detected: number; falseAlarms: number; detectionRate: number };
  finalLength: number;
}

const DEFAULT_DOCUMENT = '协作文档的第一段用于测试锚点。\n\n第二段保留几个可重复的词语：协作、建议、协作。\n\n第三段用于并发编辑和评论。';

function createRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Character identities of the server text, maintained from its own deltas. */
class IdentityTrack {
  private ids: number[];
  private next: number;
  constructor(length: number) {
    this.ids = Array.from({ length }, (_, index) => index);
    this.next = length;
  }
  apply(delta: Array<{ insert?: unknown; delete?: number; retain?: number }>): void {
    const result: number[] = [];
    let index = 0;
    for (const op of delta) {
      if (op.retain !== undefined) { for (const id of this.ids.slice(index, index + op.retain)) result.push(id); index += op.retain; }
      if (op.delete !== undefined) index += op.delete;
      if (typeof op.insert === 'string') for (let count = 0; count < op.insert.length; count += 1) result.push(this.next++);
    }
    this.ids = result.concat(this.ids.slice(index));
  }
  span(start: number, end: number): number[] { return this.ids.slice(start, end); }
  /** Whether a span still exists unchanged: none deleted, nothing inserted inside. */
  intact(span: number[]): boolean {
    if (span.length === 0) return true;
    const at = this.ids.indexOf(span[0] ?? -1);
    return at >= 0 && span.every((id, offset) => this.ids[at + offset] === id);
  }
}

interface Replica { doc: YjsDocument; outbox: Uint8Array[]; inbox: Uint8Array[] }

export function simulateConcurrency(options: ConcurrencyOptions): ConcurrencyReport {
  const random = createRandom(options.seed);
  const pick = (maximum: number): number => (maximum <= 0 ? 0 : Math.floor(random() * maximum));
  const server = new YjsDocument('eval');
  // Fixed client ids make conflict resolution, and therefore the run, reproducible.
  server.ydoc.clientID = 1;
  server.ydoc.getText('content').insert(0, options.document ?? DEFAULT_DOCUMENT);
  const track = new IdentityTrack(server.getText().length);
  server.ydoc.getText('content').observe((event) => track.apply(event.delta as Array<{ insert?: unknown; delete?: number; retain?: number }>));

  let sequence = 0;
  const repository = new MemoryReviewRepository();
  const review = new ReviewService({
    clock: { now: () => ++sequence },
    ids: { next: () => `id-${++sequence}` },
    repository,
    documents: { getDocument: () => server },
  });
  const replicas: Replica[] = Array.from({ length: options.clients }, (_, index) => {
    const doc = new YjsDocument('eval');
    doc.ydoc.clientID = index + 2;
    doc.applyUpdate(server.encodeStateAsUpdate(), 'server');
    const replica: Replica = { doc, outbox: [], inbox: [] };
    doc.ydoc.on('update', (update: Uint8Array, origin: unknown) => { if (origin !== 'server') replica.outbox.push(update); });
    return replica;
  });
  server.subscribe(({ update, origin }) => {
    for (const replica of replicas) if (replica !== origin) replica.inbox.push(update);
    review.refreshPending('eval');
  });

  const events = { edits: 0, comments: 0, suggestions: 0, deliveries: 0 };
  const anchors: Anchor[] = [];
  const suggestions: Array<{ id: string; span: number[] }> = [];
  const deliverOne = (): boolean => {
    const queues = replicas.flatMap((replica) => [
      ...(replica.outbox.length ? [() => server.applyUpdate(replica.outbox.shift() as Uint8Array, replica)] : []),
      ...(replica.inbox.length ? [() => replica.doc.applyUpdate(replica.inbox.shift() as Uint8Array, 'server')] : []),
    ]);
    if (queues.length === 0) return false;
    queues[pick(queues.length)]?.();
    events.deliveries += 1;
    return true;
  };
  const randomRange = (length: number): [number, number] => {
    const start = pick(length);
    return [start, Math.min(length, start + 1 + pick(12))];
  };

  for (let step = 0; step < options.steps; step += 1) {
    const choice = random();
    if (choice < 0.45) {
      const replica = replicas[pick(replicas.length)];
      const text = replica?.doc.getText() ?? '';
      if (replica && (text.length === 0 || random() < 0.55)) {
        const position = pick(text.length + 1);
        replica.doc.replace(position, position, `〔${step}〕`);
      } else if (replica) {
        const [start, end] = randomRange(text.length);
        replica.doc.replace(start, Math.min(end, start + 8), random() < 0.3 ? '' : `〔${step}〕`);
      }
      events.edits += 1;
    } else if (choice < 0.55 && server.getText().length > 0) {
      const [start, end] = randomRange(server.getText().length);
      anchors.push(createAnchor(server, start, end));
      events.comments += 1;
    } else if (choice < 0.65 && server.getText().length > 0) {
      const [start, end] = randomRange(server.getText().length);
      const created = review.createSuggestion({ docId: 'eval', authorId: 'eval', anchor: createAnchor(server, start, end), newText: '改', authorEffectiveRole: 'suggester' });
      if (created.ok) suggestions.push({ id: created.value.suggestion.id, span: track.span(start, end) });
      events.suggestions += 1;
    } else {
      for (let count = 0; count < 3; count += 1) deliverOne();
    }
    if (random() < 0.3) deliverOne();
  }
  while (deliverOne()) { /* drain the network */ }

  const finalText = server.getText();
  const finalState = server.stateVector().toString();
  const converged = replicas.every((replica) => replica.doc.getText() === finalText && replica.doc.stateVector().toString() === finalState);
  const counts = { exact: 0, relocated: 0, detached: 0 };
  for (const anchor of anchors) counts[resolveAnchor(server, anchor).status] += 1;
  let outdated = 0;
  let detected = 0;
  let falseAlarms = 0;
  for (const suggestion of suggestions) {
    const stale = repository.getSuggestion(suggestion.id)?.status === 'stale';
    const truth = !track.intact(suggestion.span);
    if (truth) outdated += 1;
    if (truth && stale) detected += 1;
    if (!truth && stale) falseAlarms += 1;
  }
  return {
    seed: options.seed,
    clients: options.clients,
    steps: options.steps,
    converged,
    events,
    anchors: counts,
    stale: { outdated, detected, falseAlarms, detectionRate: outdated === 0 ? 1 : Number((detected / outdated).toFixed(4)) },
    finalLength: finalText.length,
  };
}
