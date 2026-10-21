import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DocumentSummaryDto, MemberDto, OutlineEntryDto, PrincipalDto, ThreadDto } from '@collab/protocol';
import { buildOutline } from '@collab/protocol/outline';
import { useCollaboration } from './collab/useCollaboration.js';
import { DocumentHeader } from './components/DocumentHeader.js';
import { Icon } from './components/Icon.js';
import { Inspector, type InspectorTab } from './components/Inspector.js';
import { Sidebar } from './components/Sidebar.js';
import { TopBar } from './components/TopBar.js';
import { WorkbenchDialogs, type Dialog } from './dialogs/WorkbenchDialogs.js';
import { Editor, type CommentRange, type FocusRequest } from './editor/Editor.js';
import { MarkdownPreview } from './editor/MarkdownPreview.js';
import { useDocumentData } from './hooks/useDocumentData.js';
import { useFolderWriteBack } from './hooks/useFolderWriteBack.js';
import { useProjectSync } from './hooks/useProjectSync.js';
import { useReviewActions } from './hooks/useReviewActions.js';
import type { Session } from './hooks/useSession.js';
import { useWorkspaces } from './hooks/useWorkspaces.js';
import { can } from './lib/permissions.js';
import { editorMarks, previewMarks } from './lib/reviewMarks.js';
import { loadLastDocument, rememberLastDocument } from './lib/storage.js';

export function Workbench({ session, principal }: { session: Session; principal: PrincipalDto }): React.ReactElement {
  const workspaces = useWorkspaces(principal.id);
  const { detail, workspaceId } = workspaces;
  const [docId, setDocId] = useState<string>();
  // A membership change can alter this viewer's role in the project list, the project and the document.
  const data = useDocumentData(docId, () => { Promise.all([workspaces.reload(), workspaces.reloadDetail()]).catch(() => undefined); });
  const collab = useCollaboration(docId, { id: principal.id, name: principal.displayName });
  const actions = useReviewActions(docId, data);
  const sync = useProjectSync(detail, workspaces.reloadDetail);
  const [tab, setTab] = useState<InspectorTab>('discussion');
  const [openThreadId, setOpenThreadId] = useState<string>();
  const [composing, setComposing] = useState(false);
  const [viewMode, setViewMode] = useState<'source' | 'preview'>('source');
  const [focus, setFocus] = useState<FocusRequest>();
  const [selectionLength, setSelectionLength] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const document = data.document?.id === docId ? data.document : undefined;
  useFolderWriteBack(workspaceId, docId, collab.text, collab.synced);

  // Keep a valid document open: the remembered one, else the first in the project.
  useEffect(() => {
    if (!detail) return;
    if (docId !== undefined && detail.documents.some((item) => item.id === docId)) return;
    const remembered = loadLastDocument(detail.id);
    setDocId((detail.documents.find((item) => item.id === remembered) ?? detail.documents[0])?.id);
  }, [detail, docId]);

  useEffect(() => {
    setOpenThreadId(undefined);
    setComposing(false);
    setSelectionLength(0);
    setFocus(undefined);
    if (workspaceId !== undefined && docId !== undefined) rememberLastDocument(workspaceId, docId);
  }, [docId, workspaceId]);

  const people = useMemo(() => {
    const map = new Map<string, { name: string; kind: 'human' | 'agent' }>();
    for (const member of detail?.members ?? []) map.set(member.id, { name: member.displayName, kind: member.kind });
    for (const member of document?.members ?? []) map.set(member.id, { name: member.displayName, kind: member.kind });
    for (const agent of data.agents) map.set(agent.id, { name: agent.displayName, kind: 'agent' });
    map.set(principal.id, { name: principal.displayName, kind: 'human' });
    return map;
  }, [detail?.members, document?.members, data.agents, principal]);
  const identify = useCallback((id: string) => people.get(id) ?? { name: '已离开的成员', kind: 'human' as const }, [people]);
  const mentionable: MemberDto[] = useMemo(() => (document?.members ?? []).filter((member) => member.id !== principal.id), [document?.members, principal.id]);
  const role = document?.role ?? 'viewer';
  const openThread = data.threads.find((thread) => thread.id === openThreadId);
  // Replies that arrive while a discussion is open are read as they appear.
  useEffect(() => { if (openThread?.unread) actions.markRead(openThread); }, [openThread, actions]);

  const markInput = useMemo(() => ({
    threads: data.threads, suggestions: data.suggestions, activity: data.activity, agents: data.agents,
    activeThreadId: openThreadId, canDecide: can(role, 'approve'), nameOf: (id: string) => identify(id).name,
  }), [data.threads, data.suggestions, data.activity, data.agents, openThreadId, role, identify]);
  const marks = useMemo(() => editorMarks(markInput), [markInput]);
  const markdownMarks = useMemo(() => previewMarks(markInput), [markInput]);
  const outline: OutlineEntryDto[] = useMemo(() => (document && collab.synced ? buildOutline(collab.text, document.kind) : document?.outline ?? []), [document, collab.synced, collab.text]);

  const openThreadPanel = useCallback((thread: ThreadDto) => {
    setTab('discussion');
    setComposing(false);
    setOpenThreadId(thread.id);
    actions.markRead(thread);
  }, [actions]);
  const openThreadById = useCallback((threadId: string) => {
    const thread = data.threads.find((item) => item.id === threadId);
    if (thread) openThreadPanel(thread);
  }, [data.threads, openThreadPanel]);
  const locate = useCallback((start: number, end: number) => setFocus({ start, end, nonce: Date.now() }), []);

  const comment = async (range: CommentRange, body: string): Promise<boolean> => {
    const thread = await actions.createThread({ scope: { type: 'range', ...range }, body });
    if (thread) openThreadPanel({ ...thread, unread: false });
    return thread !== undefined;
  };
  const decideInline = (suggestionId: string, action: 'accept' | 'reject'): void => {
    const suggestion = data.suggestions.find((item) => item.id === suggestionId);
    if (suggestion) void actions.suggestion(suggestion, action);
  };
  const openDocument = (item: DocumentSummaryDto): void => setDocId(item.id);
  const changeViewMode = (mode: 'source' | 'preview'): void => {
    setViewMode(mode);
    // An old outline jump must not replay in the view that appears.
    setFocus(undefined);
    // The hidden source editor keeps its selection; collaborators should not keep seeing it.
    if (mode === 'preview') collab.connection?.awareness.setLocalStateField('cursor', null);
  };
  const previewing = document?.kind === 'markdown' && viewMode === 'preview';

  return (
    <div className="app">
      <TopBar
        principal={principal}
        workspaces={workspaces.workspaces}
        workspaceId={workspaceId}
        invitationCount={workspaces.invitations.length}
        savedAccounts={session.savedAccounts}
        onSelectWorkspace={(id) => { setDocId(undefined); workspaces.select(id); }}
        onNewProject={() => setDialog({ kind: 'new-project' })}
        onOpenInvitations={() => setDialog({ kind: 'invitations' })}
        onOpenProviders={() => setDialog({ kind: 'providers' })}
        onEditProfile={() => setDialog({ kind: 'profile' })}
        onSwitchAccount={(account) => void session.switchTo(account)}
        onForgetAccounts={session.forgetAllAccounts}
        onSignOut={() => void session.signOut()}
      />
      <div className="workbench">
        <Sidebar
          workspace={detail}
          documentId={docId}
          outline={outline}
          outlineKind={document?.kind ?? 'text'}
          syncing={sync.syncing}
          canSync={sync.canSync}
          onOpenDocument={openDocument}
          onNewDocument={() => setDialog({ kind: 'new-document' })}
          onDeleteDocument={(item) => setDialog({ kind: 'delete-document', document: item })}
          onOpenOutline={(entry) => setFocus({ start: entry.start, end: entry.end, nonce: Date.now(), select: !previewing })}
          onSync={() => void sync.run()}
          onOpenSettings={() => setDialog({ kind: 'project-settings' })}
          onOpenMembers={() => setTab('members')}
        />
        <main className="doc-pane">
          {document && collab.connection ? (
            <>
              <DocumentHeader document={document} status={collab.status} online={collab.online} agents={data.agents} viewMode={viewMode} versionCount={data.versions.length} onViewMode={changeViewMode} onOpenVersions={() => setDialog({ kind: 'versions' })} onOpenAgent={(agentId) => setDialog({ kind: 'agent', mode: { kind: 'configure', agentId } })} />
              <div className={`sheet${previewing ? ' is-preview' : ''}`}>
                <Editor connection={collab.connection} synced={collab.synced} editable={can(role, 'edit')} kind={document.kind} marks={marks} focus={previewing ? undefined : focus} canComment={can(role, 'comment')} members={mentionable} onOpenThread={openThreadById} onDecide={decideInline} onComment={comment} onSelectionLength={setSelectionLength} />
                {previewing ? (
                  <div className="preview-scroll"><MarkdownPreview text={collab.text} connection={collab.connection} marks={markdownMarks} focus={focus} canComment={can(role, 'comment')} members={mentionable} onOpenThread={openThreadById} onComment={comment} /></div>
                ) : null}
              </div>
              <footer className="statusbar">
                <span>{collab.text.length.toLocaleString()} 字符</span>
                {selectionLength > 0 && !previewing ? <span>已选 {selectionLength}</span> : null}
                <span className="statusbar-spacer" />
                <span>{can(role, 'edit') ? 'Ctrl + Z 只撤销你自己的修改' : can(role, 'comment') ? '只读 · 选中文字即可评论' : '只读'}</span>
              </footer>
            </>
          ) : (
            <div className="doc-empty">
              <Icon name="file" size={28} />
              {!workspaces.loaded ? <p>正在载入…</p> : !detail ? (
                <><h2>{workspaces.workspaces.length ? '选择一个项目' : '创建你的第一个项目'}</h2><p>项目把文档、成员和 Agent 放在一起。</p><button type="button" className="button primary" onClick={() => setDialog({ kind: 'new-project' })}>新建项目</button></>
              ) : detail.documents.length === 0 ? (
                <><h2>这个项目还没有文档</h2>{can(detail.role, 'edit') ? <button type="button" className="button primary" onClick={() => setDialog({ kind: 'new-document' })}>新建文档</button> : <p>等待编辑者添加文档。</p>}</>
              ) : data.missing ? <p>这份文档已被删除。</p> : <p>正在打开文档…</p>}
            </div>
          )}
        </main>
        {document ? (
          <Inspector
            tab={tab}
            onTab={setTab}
            openThread={openThread}
            composing={composing}
            threads={data.threads}
            suggestions={data.suggestions}
            versions={data.versions}
            activity={data.activity}
            agents={data.agents}
            members={document.members}
            mentionable={mentionable}
            onlineIds={new Set(collab.online.map((member) => member.id))}
            viewerId={principal.id}
            role={role}
            workspaceRole={detail?.role}
            identify={identify}
            actions={actions}
            onOpenThread={openThreadPanel}
            onCloseThread={() => setOpenThreadId(undefined)}
            onCompose={setComposing}
            onCreateDiscussion={async (body, agentId) => {
              const thread = await actions.createThread({ scope: { type: 'document' }, body, ...(agentId ? { agentId } : {}) });
              if (thread) { setComposing(false); openThreadPanel({ ...thread, unread: false }); }
              return thread !== undefined;
            }}
            onLocate={locate}
            onManageMembers={() => { workspaces.reloadDetail().catch(() => undefined); setDialog({ kind: 'members' }); }}
            onConfigureAgent={(agentId) => setDialog({ kind: 'agent', mode: { kind: 'configure', agentId } })}
            onAddAgent={() => setDialog({ kind: 'agent', mode: { kind: 'create' } })}
          />
        ) : <aside className="inspector is-empty" aria-hidden="true" />}
      </div>
      <WorkbenchDialogs
        dialog={dialog}
        onClose={() => setDialog(null)}
        session={session}
        principal={principal}
        workspaces={workspaces}
        document={document}
        data={data}
        actions={actions}
        identify={identify}
        onOpenDocument={(id) => setDocId(id)}
        onOpenDialog={setDialog}
      />
    </div>
  );
}
