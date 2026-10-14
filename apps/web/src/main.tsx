import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Y from 'yjs';
import './styles.css';

type Principal = { id: string; displayName: string; kind: 'human' | 'agent'; role?: string };
type Doc = { id: string; title: string; text: string };
function App(): React.ReactElement {
  const [principals, setPrincipals] = useState<Principal[]>([]);
  const [principalId, setPrincipalId] = useState('alice');
  const [docs, setDocs] = useState<Doc[]>([]);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [text, setText] = useState('');
  const [members, setMembers] = useState<Principal[]>([]);
  const [online, setOnline] = useState<string[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const ydocRef = useRef<Y.Doc | null>(null);
  const suppressRef = useRef(false);
  useEffect(() => { void fetch('/api/principals').then((r) => r.json()).then(setPrincipals); }, []);
  useEffect(() => {
    void fetch('/api/docs', { headers: { 'x-principal-id': principalId } }).then((r) => r.json()).then((items: Doc[]) => { setDocs(items); setDoc((current) => current && items.find((item) => item.id === current.id) ? current : items[0] ?? null); });
  }, [principalId]);
  useEffect(() => {
    if (!doc) return;
    const ydoc = new Y.Doc(); ydocRef.current = ydoc; setText(doc.text);
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/docs/${doc.id}?principal=${principalId}`); socketRef.current = socket;
    socket.onmessage = (event) => { const message = JSON.parse(String(event.data)) as { type: string; update?: string; members?: Principal[]; principalId?: string; state?: { from?: number; to?: number } }; if (message.type === 'sync' && message.update) { Y.applyUpdate(ydoc, Uint8Array.from(atob(message.update), (char) => char.charCodeAt(0))); suppressRef.current = true; setText(ydoc.getText('content').toString()); suppressRef.current = false; } else if (message.type === 'members' && message.members) { setMembers(message.members); setOnline(message.members.map((member) => member.id)); } else if (message.type === 'awareness' && message.principalId) setOnline((current) => current.includes(message.principalId as string) ? current : [...current, message.principalId as string]); };
    return () => { socket.close(); ydoc.destroy(); socketRef.current = null; };
  }, [doc?.id, principalId]);
  const updateText = (next: string) => {
    setText(next); if (suppressRef.current || !ydocRef.current || socketRef.current?.readyState !== WebSocket.OPEN) return;
    const ytext = ydocRef.current.getText('content'); const previous = ytext.toString(); let start = 0; while (start < previous.length && start < next.length && previous[start] === next[start]) start += 1; let oldEnd = previous.length; let newEnd = next.length; while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) { oldEnd -= 1; newEnd -= 1; }
    ydocRef.current.transact(() => { ytext.delete(start, oldEnd - start); if (newEnd > start) ytext.insert(start, next.slice(start, newEnd)); });
    const update = Y.encodeStateAsUpdate(ydocRef.current); socketRef.current.send(JSON.stringify({ type: 'sync', update: btoa(String.fromCharCode(...update)) }));
  };
  const role = members.find((member) => member.id === principalId)?.role ?? (principalId === 'alice' ? 'owner' : 'viewer'); const editable = ['editor', 'owner'].includes(role);
  return <main><header><h1>协作写作</h1><label>当前身份 <select value={principalId} onChange={(event) => setPrincipalId(event.target.value)}>{principals.map((principal) => <option key={principal.id} value={principal.id}>{principal.displayName} · {principal.kind === 'agent' ? 'AI' : '人'}</option>)}</select></label><span className="presence">在线：{online.map((id) => principals.find((principal) => principal.id === id)?.displayName ?? id).join('、')}</span></header><section className="layout"><aside><h2>文档</h2>{docs.map((item) => <button className={item.id === doc?.id ? 'selected' : ''} key={item.id} onClick={() => setDoc(item)}>{item.title}</button>)}<h2>成员</h2>{members.map((member) => <div className="member" key={member.id}><span className={member.kind === 'agent' ? 'avatar agent' : 'avatar'}>{member.kind === 'agent' ? 'AI' : member.displayName[0]}</span>{member.displayName}<small>{member.role}</small></div>)}</aside><article><h2>{doc?.title ?? '没有文档'}</h2><textarea value={text} readOnly={!editable} onChange={(event) => updateText(event.target.value)} onSelect={(event) => socketRef.current?.send(JSON.stringify({ type: 'awareness', state: { from: event.currentTarget.selectionStart, to: event.currentTarget.selectionEnd } }))} /><p className="hint">{editable ? '你可以直接编辑，变更会同步给其他窗口。' : `当前角色 ${role} 为只读，请通过建议修改参与协作。`}</p></article></section></main>;
}
createRoot(document.getElementById('root')!).render(<App />);
