import type { Batch, DocumentVersion, Message, Suggestion, Thread } from './types.js';

/**
 * Persistence is kept behind this port so the domain service does not know
 * whether records are held in memory or in SQLite.
 */
export interface ReviewRepository {
  getThread(id: string): Thread | undefined;
  listThreads(docId: string): Thread[];
  /** Insert or replace the complete aggregate record. */
  saveThread(thread: Thread): void;
  /** Read markers are kept per viewer so unread state does not leak between members. */
  getThreadReadAt(threadId: string, principalId: string): number | undefined;
  saveThreadReadAt(threadId: string, principalId: string, readAt: number): void;
  getMessage(id: string): Message | undefined;
  listMessages(threadId: string): Message[];
  /** Insert or replace the complete message record. */
  saveMessage(message: Message): void;
  getSuggestion(id: string): Suggestion | undefined;
  listSuggestions(docId: string): Suggestion[];
  /** Insert or replace the complete suggestion record. */
  saveSuggestion(suggestion: Suggestion): void;
  getBatch(id: string): Batch | undefined;
  listBatches(threadId: string): Batch[];
  /** Insert or replace the complete batch record. */
  saveBatch(batch: Batch): void;
  getDocumentVersion(id: string): DocumentVersion | undefined;
  listDocumentVersions(docId: string): DocumentVersion[];
  saveDocumentVersion(version: DocumentVersion): void;
  transaction?<T>(work: () => T): T;
}

/** A deterministic repository used by domain tests and offline demos. */
export class MemoryReviewRepository implements ReviewRepository {
  private readonly threads = new Map<string, Thread>();
  private readonly messages = new Map<string, Message>();
  private readonly suggestions = new Map<string, Suggestion>();
  private readonly batches = new Map<string, Batch>();
  private readonly versions = new Map<string, DocumentVersion>();
  private readonly threadReads = new Map<string, number>();

  getThread(id: string): Thread | undefined { return this.threads.get(id); }
  listThreads(docId: string): Thread[] {
    return [...this.threads.values()].filter((thread) => thread.docId === docId);
  }
  saveThread(thread: Thread): void { this.threads.set(thread.id, thread); }
  getThreadReadAt(threadId: string, principalId: string): number | undefined { return this.threadReads.get(`${threadId}:${principalId}`); }
  saveThreadReadAt(threadId: string, principalId: string, readAt: number): void { this.threadReads.set(`${threadId}:${principalId}`, readAt); }
  getMessage(id: string): Message | undefined { return this.messages.get(id); }
  listMessages(threadId: string): Message[] {
    return [...this.messages.values()].filter((message) => message.threadId === threadId);
  }
  saveMessage(message: Message): void { this.messages.set(message.id, message); }
  getSuggestion(id: string): Suggestion | undefined { return this.suggestions.get(id); }
  listSuggestions(docId: string): Suggestion[] {
    return [...this.suggestions.values()].filter((suggestion) => suggestion.docId === docId);
  }
  saveSuggestion(suggestion: Suggestion): void { this.suggestions.set(suggestion.id, suggestion); }
  getBatch(id: string): Batch | undefined { return this.batches.get(id); }
  listBatches(threadId: string): Batch[] {
    return [...this.batches.values()].filter((batch) => batch.threadId === threadId);
  }
  saveBatch(batch: Batch): void { this.batches.set(batch.id, batch); }
  getDocumentVersion(id: string): DocumentVersion | undefined { return this.versions.get(id); }
  listDocumentVersions(docId: string): DocumentVersion[] {
    return [...this.versions.values()]
      .filter((version) => version.docId === docId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  saveDocumentVersion(version: DocumentVersion): void { this.versions.set(version.id, version); }
  transaction<T>(work: () => T): T { return work(); }
}
