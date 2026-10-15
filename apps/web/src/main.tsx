import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Y from 'yjs';
import './styles.css';

type Principal = { id: string; displayName: string; kind: 'human' | 'agent'; role?: string };
type Doc = { id: string; title: string; text: string };
type Thread = { id: string; docId: string; kind: 'discussion' | 'task'; status: 'open' | 'resolved'; scope: { type: 'range'; anchor: unknown } | { type: 'document' }; messages: Message[] };
type Message = { id: string; authorId: string; body: string; mentions: string[]; createdAt: number };
type Suggestion = { id: string; threadId?: string; batchId?: string; authorId: string; anchor: unknown; newText: string; rationale?: string; status: 'pending' | 'accepted' | 'rejected' | 'stale' };
type Selection = { start: number; end: number };
type AnchorPreview = { quote?: string };
type Agent = { id: string; displayName: string; adapter: string; contextStrategy: 'selection' | 'window' | 'full'; grantedRole: string; status: 'working' | 'idle' | 'failed' };

async function request<T>(url: string, options: RequestInit = {}): Promise<T | null> {
  const response = await fetch(url, options);
  const value = await response.json() as T | { error?: { message?: string } };
  if (!response.ok) { console.warn((value as { error?: { message?: string } }).error?.message ?? 'Request failed'); return null; }
  return value as T;
}

function App(): React.ReactElement {
  const [principals, setPrincipals] = useState<Principal[]>([]);
  const [principalId, setPrincipalId] = useState('alice');
  const [docs, setDocs] = useState<Doc[]>([]);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [text, setText] = useState('');
  const [members, setMembers] = useState<Principal[]>([]);
  const [online, setOnline] = useState<string[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [selectedRange, setSelectedRange] = useState<Selection | null>(null);
  const [comment, setComment] = useState('');
  const [newText, setNewText] = useState('');
  const [asTask, setAsTask] = useState(false);
  const [assignedAgentId, setAssignedAgentId] = useState('');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tab, setTab] = useState<'comments' | 'suggestions' | 'agents'>('comments');
  const socketRef = useRef<WebSocket | null>(null);
  const ydocRef = useRef<Y.Doc | null>(null);
  const suppressRef = useRef(false);
  const headers = { 'x-principal-id': principalId, 'Content-Type': 'application/json' };
  const reloadReview = async (docId: string) => {
    const [nextThreads, nextSuggestions] = await Promise.all([
      request<Thread[]>(`/api/docs/${docId}/threads`, { headers }),
      request<Suggestion[]>(`/api/docs/${docId}/suggestions`, { headers }),
    ]);
    if (nextThreads) setThreads(nextThreads);
    if (nextSuggestions) setSuggestions(nextSuggestions);
  };
  useEffect(() => { void request<Principal[]>('/api/principals').then((value) => { if (value) setPrincipals(value); }); }, []);
  useEffect(() => {
    void request<Doc[]>('/api/docs', { headers }).then((items) => { if (items) { setDocs(items); setDoc((current) => current && items.some((item) => item.id === current.id) ? current : items[0] ?? null); } });
  }, [principalId]);
  useEffect(() => { if (doc) void reloadReview(doc.id); }, [doc?.id, principalId]);
  useEffect(() => { if (doc) void request<Agent[]>(`/api/docs/${doc.id}/agents`, { headers }).then((value) => { if (value) setAgents(value); }); }, [doc?.id, principalId]);
  useEffect(() => {
    if (!doc) return;
    const source = new EventSource(`/api/docs/${doc.id}/events?principal=${encodeURIComponent(principalId)}`);
    const reload = () => { void reloadReview(doc.id); };
    for (const name of ['thread.created', 'thread.resolved', 'message.created', 'suggestion.created', 'suggestion.updated', 'document.changed', 'agent.status']) source.addEventListener(name, reload);
    source.addEventListener('agent.status', () => { void request<Agent[]>(`/api/docs/${doc.id}/agents`, { headers }).then((value) => { if (value) setAgents(value); }); });
    return () => source.close();
  }, [doc?.id, principalId]);
  useEffect(() => {
    if (!doc) return;
    const ydoc = new Y.Doc(); ydocRef.current = ydoc; setText(doc.text);
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/docs/${doc.id}?principal=${principalId}`); socketRef.current = socket;
    socket.onmessage = (event) => { const message = JSON.parse(String(event.data)) as { type: string; update?: string; members?: Principal[]; principalId?: string; state?: unknown }; if (message.type === 'sync' && message.update) { Y.applyUpdate(ydoc, Uint8Array.from(atob(message.update), (char) => char.charCodeAt(0))); suppressRef.current = true; setText(ydoc.getText('content').toString()); suppressRef.current = false; } else if (message.type === 'members' && message.members) { setMembers(message.members); setOnline(message.members.map((member) => member.id)); } else if (message.type === 'awareness' && message.principalId) setOnline((current) => current.includes(message.principalId as string) ? current : [...current, message.principalId as string]); };
    return () => { socket.close(); ydoc.destroy(); socketRef.current = null; };
  }, [doc?.id, principalId]);
  const updateText = (next: string) => {
    setText(next); if (suppressRef.current || !ydocRef.current || socketRef.current?.readyState !== WebSocket.OPEN) return;
    const ytext = ydocRef.current.getText('content'); const previous = ytext.toString(); let start = 0; while (start < previous.length && start < next.length && previous[start] === next[start]) start += 1; let oldEnd = previous.length; let newEnd = next.length; while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) { oldEnd -= 1; newEnd -= 1; }
    ydocRef.current.transact(() => { ytext.delete(start, oldEnd - start); if (newEnd > start) ytext.insert(start, next.slice(start, newEnd)); });
    const update = Y.encodeStateAsUpdate(ydocRef.current); socketRef.current.send(JSON.stringify({ type: 'sync', update: btoa(String.fromCharCode(...update)) }));
  };
  const role = members.find((member) => member.id === principalId)?.role ?? (principalId === 'alice' ? 'owner' : 'viewer');
  const editable = ['editor', 'owner'].includes(role);
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const createComment = async () => {
    if (!doc || !comment.trim()) return;
    const scope = selectedRange ? { type: 'range', start: selectedRange.start, end: selectedRange.end } : { type: 'document' };
    const thread = await request<Thread>(`/api/docs/${doc.id}/threads`, { method: 'POST', headers, body: JSON.stringify({ kind: asTask ? 'task' : 'discussion', ...(asTask && assignedAgentId ? { agentId: assignedAgentId } : {}), scope }) });
    if (!thread) return;
    await request(`/api/threads/${thread.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ body: comment }) });
    setComment(''); setActiveThreadId(thread.id); setTab('comments'); await reloadReview(doc.id);
  };
  const sendMessage = async () => {
    if (!activeThread || !comment.trim()) return;
    await request(`/api/threads/${activeThread.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ body: comment }) });
    setComment(''); await reloadReview(activeThread.docId);
  };
  const createSuggestion = async () => {
    if (!doc || !selectedRange || role === 'viewer' || role === 'commenter' || !newText.trim()) return;
    await request(`/api/docs/${doc.id}/suggestions`, { method: 'POST', headers, body: JSON.stringify({ start: selectedRange.start, end: selectedRange.end, newText }) });
    setNewText(''); setTab('suggestions'); await reloadReview(doc.id);
  };
  const decide = async (id: string, action: 'accept' | 'reject' | 'regenerate') => { if (!doc) return; await request(`/api/suggestions/${id}/${action}`, { method: 'POST', headers, body: '{}' }); await reloadReview(doc.id); };
  const batchGroups = [...new Set(suggestions.map((suggestion) => suggestion.batchId).filter((id): id is string => Boolean(id)))].map((id) => ({ id, items: suggestions.filter((suggestion) => suggestion.batchId === id) }));
  const decideBatch = async (id: string, action: 'accept-remaining' | 'reject-remaining') => { if (!doc) return; await request(`/api/batches/${id}/${action}`, { method: 'POST', headers, body: '{}' }); await reloadReview(doc.id); };
  return <main><header><h1>协作写作</h1><label>当前身份 <select value={principalId} onChange={(event) => setPrincipalId(event.target.value)}>{principals.map((principal) => <option key={principal.id} value={principal.id}>{principal.displayName} · {principal.kind === 'agent' ? 'AI' : '人'}</option>)}</select></label><span className="presence">在线：{online.map((id) => principals.find((principal) => principal.id === id)?.displayName ?? id).join('、')}</span></header><section className="layout"><aside><h2>文档</h2>{docs.map((item) => <button className={item.id === doc?.id ? 'selected' : ''} key={item.id} onClick={() => setDoc(item)}>{item.title}</button>)}<h2>成员</h2>{members.map((member) => <div className="member" key={member.id}><span className={member.kind === 'agent' ? 'avatar agent' : 'avatar'}>{member.kind === 'agent' ? 'AI' : member.displayName[0]}</span>{member.displayName}<small>{member.role}</small></div>)}</aside><article><h2>{doc?.title ?? '没有文档'}</h2><div className="toolbar"><button disabled={!selectedRange || !['commenter', 'suggester', 'editor', 'owner'].includes(role)} onClick={() => setTab('comments')}>评论选区</button><button disabled={!selectedRange || !['suggester', 'editor', 'owner'].includes(role)} onClick={() => setTab('suggestions')}>建议修改</button>{selectedRange ? <span>选区 {selectedRange.start}–{selectedRange.end}</span> : <span>先选择一段文字</span>}</div><textarea value={text} readOnly={!editable} onChange={(event) => updateText(event.target.value)} onSelect={(event) => { const target = event.currentTarget; setSelectedRange({ start: target.selectionStart, end: target.selectionEnd }); socketRef.current?.send(JSON.stringify({ type: 'awareness', state: { from: target.selectionStart, to: target.selectionEnd } })); }} /><p className="hint">{editable ? '你可以直接编辑，变更会同步给其他窗口。' : `当前角色 ${role} 为只读，请通过建议修改参与协作。`}</p></article><aside className="review-panel"><nav><button className={tab === 'comments' ? 'selected' : ''} onClick={() => setTab('comments')}>评论 ({threads.length})</button><button className={tab === 'suggestions' ? 'selected' : ''} onClick={() => setTab('suggestions')}>建议 ({suggestions.length})</button><button className={tab === 'agents' ? 'selected' : ''} onClick={() => setTab('agents')}>Agent ({agents.length})</button></nav>{tab === 'comments' ? <><textarea className="small-input" placeholder={activeThread ? '回复当前线程' : '新建评论，可 @成员'} value={comment} onChange={(event) => setComment(event.target.value)} />{!activeThread ? <label className="task-toggle"><input type="checkbox" checked={asTask} onChange={(event) => setAsTask(event.target.checked)} />作为任务</label> : null}{!activeThread && asTask ? <select className="agent-select" value={assignedAgentId} onChange={(event) => setAssignedAgentId(event.target.value)}><option value="">选择 agent</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.displayName}</option>)}</select> : null}<button onClick={activeThread ? sendMessage : createComment}>{activeThread ? '回复' : '发布评论'}</button>{threads.map((thread) => <div className={`thread ${thread.id === activeThreadId ? 'active' : ''}`} key={thread.id} onClick={() => setActiveThreadId(thread.id)}><strong>{thread.kind === 'task' ? '任务' : '讨论'} · {thread.status}</strong>{thread.messages.map((message) => <p key={message.id}><b>{members.find((member) => member.id === message.authorId)?.displayName ?? message.authorId}：</b>{message.body}</p>)}</div>)}</> : tab === 'suggestions' ? <><input className="small-input" placeholder="选区替换文本" value={newText} onChange={(event) => setNewText(event.target.value)} /><button disabled={!selectedRange || !['suggester', 'editor', 'owner'].includes(role)} onClick={createSuggestion}>提交建议</button>{batchGroups.map((batch) => <div className="batch-card" key={batch.id}><strong>Batch</strong><span>{batch.items.filter((item) => item.status !== 'pending').length}/{batch.items.length} 已处理</span>{['editor', 'owner'].includes(role) ? <div><button onClick={() => decideBatch(batch.id, 'accept-remaining')}>接受剩余</button><button onClick={() => decideBatch(batch.id, 'reject-remaining')}>拒绝剩余</button></div> : null}</div>)}{suggestions.map((suggestion) => { const quote = (suggestion.anchor as AnchorPreview).quote; return <div className={`suggestion ${suggestion.status}`} key={suggestion.id}><strong>{suggestion.status}</strong>{quote ? <p className="diff"><del>{quote}</del><span aria-hidden="true"> → </span><ins>{suggestion.newText}</ins></p> : <p>替换为：{suggestion.newText}</p>}{suggestion.rationale ? <small>{suggestion.rationale}</small> : null}{suggestion.status === 'pending' && ['editor', 'owner'].includes(role) ? <div><button onClick={() => decide(suggestion.id, 'accept')}>接受</button><button onClick={() => decide(suggestion.id, 'reject')}>拒绝</button></div> : null}{suggestion.status === 'stale' && ['suggester', 'editor', 'owner'].includes(role) ? <div><button onClick={() => decide(suggestion.id, 'regenerate')}>重新生成</button></div> : null}</div>; })}</> : <>{agents.map((agent) => <div className="agent-card" key={agent.id}><span className="avatar agent">AI</span><div><strong>{agent.displayName}</strong><p>{agent.adapter} · {agent.contextStrategy}</p></div><span className={`agent-status ${agent.status}`}>{agent.status === 'working' ? '处理中' : agent.status === 'failed' ? '失败' : '空闲'}</span></div>)}</>}</aside></section></main>;
}
createRoot(document.getElementById('root')!).render(<App />);
