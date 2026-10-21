import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { AgentStatusEventDto, AgentSummaryDto, DocumentDto, DocumentEvent, DocumentVersionDto, SuggestionDto, ThreadDto } from '@collab/protocol';
import { api, ApiError } from '../api.js';

type Part = 'document' | 'threads' | 'suggestions' | 'versions' | 'agents';

/** Review events refresh almost at once; text edits only after typing pauses. */
const EVENT_DELAY_MS = 60;
const TYPING_DELAY_MS = 600;

const EVENT_PARTS: Record<string, Part[]> = {
  'thread.created': ['threads'],
  'thread.resolved': ['threads'],
  'message.created': ['threads'],
  'message.updated': ['threads'],
  'suggestion.created': ['suggestions', 'threads'],
  'suggestion.updated': ['suggestions', 'threads', 'versions'],
  'batch.created': ['suggestions'],
  'agent.status': ['agents'],
  // Roles and member lists live on the document; agents may have been added or regranted.
  'members.changed': ['document', 'agents'],
};

export interface DocumentData {
  document: DocumentDto | undefined;
  missing: boolean;
  threads: ThreadDto[];
  suggestions: SuggestionDto[];
  versions: DocumentVersionDto[];
  agents: AgentSummaryDto[];
  /** Latest agent status per thread, straight from the event stream. */
  activity: Record<string, AgentStatusEventDto>;
  refresh: (...parts: Part[]) => void;
  setThreads: Dispatch<SetStateAction<ThreadDto[]>>;
}

/** `onMembersChanged` lets the project view refresh when the document reports a membership change. */
export function useDocumentData(docId: string | undefined, onMembersChanged: () => void): DocumentData {
  const [document, setDocument] = useState<DocumentDto>();
  const [missing, setMissing] = useState(false);
  const [threads, setThreads] = useState<ThreadDto[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestionDto[]>([]);
  const [versions, setVersions] = useState<DocumentVersionDto[]>([]);
  const [agents, setAgents] = useState<AgentSummaryDto[]>([]);
  const [activity, setActivity] = useState<Record<string, AgentStatusEventDto>>({});
  const pending = useRef<{ parts: Set<Part>; timer: number | undefined; dueAt: number }>({ parts: new Set(), timer: undefined, dueAt: 0 });
  const current = useRef(docId);
  current.current = docId;
  const membersChanged = useRef(onMembersChanged);
  membersChanged.current = onMembersChanged;

  const load = useCallback(async (id: string, parts: Set<Part>) => {
    const base = `/api/docs/${encodeURIComponent(id)}`;
    const tasks: Array<Promise<void>> = [];
    const keep = <T,>(setter: Dispatch<SetStateAction<T>>) => (value: T) => { if (current.current === id) setter(value); };
    if (parts.has('document')) {
      tasks.push(api<DocumentDto>(base).then(keep(setDocument)).catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404 && current.current === id) setMissing(true);
      }));
    }
    if (parts.has('threads')) tasks.push(api<ThreadDto[]>(`${base}/threads`).then(keep(setThreads)));
    if (parts.has('suggestions')) tasks.push(api<SuggestionDto[]>(`${base}/suggestions`).then(keep(setSuggestions)));
    if (parts.has('versions')) tasks.push(api<DocumentVersionDto[]>(`${base}/versions`).then(keep(setVersions)));
    if (parts.has('agents')) tasks.push(api<AgentSummaryDto[]>(`${base}/agents`).then(keep(setAgents)));
    await Promise.allSettled(tasks);
  }, []);

  const schedule = useCallback((parts: Part[], delay: number) => {
    const id = current.current;
    if (id === undefined) return;
    const queue = pending.current;
    parts.forEach((part) => queue.parts.add(part));
    const dueAt = Date.now() + delay;
    if (queue.timer !== undefined && queue.dueAt <= dueAt) return;
    if (queue.timer !== undefined) window.clearTimeout(queue.timer);
    queue.dueAt = dueAt;
    queue.timer = window.setTimeout(() => {
      const due = new Set(queue.parts);
      queue.parts.clear();
      queue.timer = undefined;
      void load(id, due);
    }, delay);
  }, [load]);

  const refresh = useCallback((...parts: Part[]) => schedule(parts, 0), [schedule]);

  useEffect(() => {
    setDocument(undefined);
    setMissing(false);
    setThreads([]);
    setSuggestions([]);
    setVersions([]);
    setAgents([]);
    setActivity({});
    if (docId === undefined) return undefined;
    void load(docId, new Set<Part>(['document', 'threads', 'suggestions', 'versions', 'agents']));
    const source = new EventSource(`/api/docs/${encodeURIComponent(docId)}/events`);
    const onEvent = (event: MessageEvent<string>) => {
      let payload: DocumentEvent;
      try { payload = JSON.parse(event.data) as DocumentEvent; } catch { return; }
      if (payload.type === 'document.changed') { schedule(['threads', 'suggestions'], TYPING_DELAY_MS); return; }
      if (payload.type === 'agent.status') {
        const status = payload.data as AgentStatusEventDto;
        setActivity((existing) => ({ ...existing, [status.threadId]: status }));
      }
      if (payload.type === 'members.changed') membersChanged.current();
      schedule(EVENT_PARTS[payload.type] ?? [], EVENT_DELAY_MS);
    };
    for (const type of [...Object.keys(EVENT_PARTS), 'document.changed']) source.addEventListener(type, onEvent);
    return () => {
      source.close();
      if (pending.current.timer !== undefined) window.clearTimeout(pending.current.timer);
      pending.current = { parts: new Set(), timer: undefined, dueAt: 0 };
    };
  }, [docId, load, schedule]);

  return { document, missing, threads, suggestions, versions, agents, activity, refresh, setThreads };
}
