import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Y from 'yjs';
import { AgentConfigPanel, type AgentSummary } from './AgentConfigPanel.js';
import { agentStatusCopy, type AgentFailureKind, type AgentStatus } from './agentStatus.js';
import { CodeMirrorEditor } from './CodeMirrorEditor.js';
import { ModelProvidersPanel } from './ModelProvidersPanel.js';
import './styles.css';

type Principal = { id: string; displayName: string; kind: 'human' | 'agent'; handle?: string; role?: string };
type AuthSession = { principal: Principal; session?: { principalId: string; transport?: string } };
type SavedAccount = { identifier: string; password: string; displayName: string; principalId?: string; handle?: string; lastUsedAt: number };
type Doc = { id: string; title: string; text: string; workspaceId?: string };
type FileTreeNode = {
  name: string;
  path: string;
  folders: FileTreeNode[];
  document?: Doc;
};
type LocalProjectFile = {
  documentId?: string;
  title: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
  status: 'imported' | 'unchanged' | 'synced' | 'updated' | 'conflict' | 'missing';
};
type LocalProjectStatus = {
  workspaceId: string;
  source: 'local' | 'imported' | 'managed';
  path?: string;
  files: LocalProjectFile[];
};
type LocalProjectFileInput = {
  relativePath: string;
  text: string;
  size: number;
  mtimeMs: number;
};
type LocalFileHandle = {
  kind: 'file';
  name: string;
  getFile: () => Promise<File>;
  createWritable?: () => Promise<{ write: (value: string) => Promise<void>; close: () => Promise<void> }>;
};
type LocalDirectoryHandle = {
  kind: 'directory';
  name: string;
  values: () => AsyncIterable<LocalFileHandle | LocalDirectoryHandle>;
  getFileHandle?: (name: string) => Promise<LocalFileHandle>;
  getDirectoryHandle?: (name: string) => Promise<LocalDirectoryHandle>;
};
type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: () => Promise<LocalDirectoryHandle>;
};
type OutlineEntry = { index: number; title: string; start: number; end: number; level?: number };
type Workspace = {
  id: string;
  title: string;
  createdBy: string;
  createdAt: number;
  role: string;
  documents: Doc[];
};
type WorkspaceMember = Principal & { role: string };
type WorkspaceDetail = Workspace & { members: WorkspaceMember[] };
type CollaboratorRole = 'viewer' | 'commenter' | 'suggester' | 'editor';
const collaboratorRoleOptions: Array<{ value: CollaboratorRole; label: string }> = [
  { value: 'viewer', label: '只读 · 查看文档' },
  { value: 'commenter', label: '评论 · 参与讨论' },
  { value: 'suggester', label: '建议 · 提交修改' },
  { value: 'editor', label: '编辑 · 直接修改' },
];
type WorkspaceInvitation = {
  id: string;
  workspaceId: string;
  workspaceTitle?: string;
  workspace?: { id: string; title: string };
  principalId: string;
  principalName?: string;
  invitee?: Principal;
  inviterId?: string;
  invitedBy?: string;
  inviterName?: string;
  inviter?: Principal;
  role: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: number;
};
type Thread = {
  id: string;
  docId: string;
  kind: 'discussion' | 'task';
  agentId?: string;
  status: 'open' | 'resolved';
  scope: { type: 'range'; anchor: unknown; resolved?: ReviewResolution } | { type: 'document' };
  messages: Message[];
};
type ReviewResolution = { status: 'exact' | 'relocated' | 'detached'; start?: number; end?: number };
type Message = {
  id: string;
  authorId: string;
  body: string;
  mentions: string[];
  createdAt: number;
  status?: 'visible' | 'withdrawn';
  withdrawnAt?: number;
};
type Suggestion = {
  id: string;
  threadId?: string;
  batchId?: string;
  authorId: string;
  anchor: unknown;
  newText: string;
  rationale?: string;
  status: 'pending' | 'accepted' | 'rejected' | 'stale';
  withdrawnAt?: number;
  withdrawnBy?: string;
  resolved?: ReviewResolution;
};
type ReviewMarker = { id: string; threadId?: string; start: number; end: number; kind: 'thread' | 'suggestion'; status: 'open' | 'resolved' | 'pending' | 'accepted' | 'rejected' | 'stale'; unread?: boolean };
type Selection = { start: number; end: number };
type MentionState = { start: number; end: number; index: number };
type AnchorPreview = { quote?: string };
type Agent = AgentSummary;
type AgentStatusUpdate = {
  agentId: string;
  threadId: string;
  state: AgentStatus;
  error?: string;
  errorKind?: AgentFailureKind;
};

const SUPPORTED_LOCAL_EXTENSIONS = ['.txt', '.md'] as const;
const SUPPORTED_LOCAL_DOCUMENT_LABEL = 'TXT / Markdown';
const SAVED_ACCOUNTS_STORAGE_KEY = 'collab-workbench-saved-accounts-v1';
const LAST_WORKSPACE_STORAGE_KEY = 'collab-workbench-last-workspace-v1';

function loadLastWorkspace(principalId: string): string | undefined {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(LAST_WORKSPACE_STORAGE_KEY) ?? '{}');
    if (!value || typeof value !== 'object') return undefined;
    const workspaceId = (value as Record<string, unknown>)[principalId];
    return typeof workspaceId === 'string' ? workspaceId : undefined;
  } catch {
    return undefined;
  }
}

function rememberLastWorkspace(principalId: string, workspaceId: string): void {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(LAST_WORKSPACE_STORAGE_KEY) ?? '{}');
    const entries = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    entries[principalId] = workspaceId;
    window.localStorage.setItem(LAST_WORKSPACE_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Local storage is a convenience; project selection still works without it.
  }
}

function loadSavedAccounts(): SavedAccount[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(SAVED_ACCOUNTS_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is SavedAccount => {
      if (!item || typeof item !== 'object') return false;
      const candidate = item as Partial<SavedAccount>;
      return typeof candidate.identifier === 'string' && typeof candidate.password === 'string' && typeof candidate.displayName === 'string' && typeof candidate.lastUsedAt === 'number'
        && (candidate.handle === undefined || typeof candidate.handle === 'string')
        && (candidate.principalId === undefined || typeof candidate.principalId === 'string');
    }).slice(0, 12);
  } catch {
    return [];
  }
}

function persistSavedAccounts(accounts: SavedAccount[]): void {
  try {
    if (accounts.length) window.localStorage.setItem(SAVED_ACCOUNTS_STORAGE_KEY, JSON.stringify(accounts));
    else window.localStorage.removeItem(SAVED_ACCOUNTS_STORAGE_KEY);
  } catch {
    // Private browsing or storage limits should not prevent authentication.
  }
}

function isSupportedLocalDocument(name: string): boolean {
  const lowerName = name.toLowerCase();
  return SUPPORTED_LOCAL_EXTENSIONS.some((extension) => lowerName.endsWith(extension));
}

function syncSummary(files: LocalProjectFile[]): string {
  const conflicts = files.filter((file) => file.status === 'conflict');
  const missing = files.filter((file) => file.status === 'missing');
  const changed = files.filter((file) => file.status === 'updated' || file.status === 'imported');
  const details: string[] = [];
  if (changed.length > 0) details.push(`更新 ${changed.length} 个`);
  if (conflicts.length > 0) {
    const names = conflicts.slice(0, 3).map((file) => file.relativePath).join('、');
    details.push(`冲突 ${conflicts.length} 个（${names}${conflicts.length > 3 ? ' 等' : ''}，未覆盖）`);
  }
  if (missing.length > 0) {
    const names = missing.slice(0, 3).map((file) => file.relativePath).join('、');
    details.push(`本地缺失 ${missing.length} 个（${names}${missing.length > 3 ? ' 等' : ''}，未删除云端文档）`);
  }
  if (details.length === 0) return `已检查 ${files.length} 个 TXT / Markdown 文档，内容已同步。`;
  return `已检查 ${files.length} 个 TXT / Markdown 文档：${details.join('；')}。`;
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T | null> {
  const response = await fetch(url, { credentials: 'include', ...options });
  const value = (await response.json()) as T | { error?: { message?: string } };
  if (!response.ok) {
    console.warn((value as { error?: { message?: string } }).error?.message ?? 'Request failed');
    return null;
  }
  return value as T;
}

async function readDirectoryFiles(
  directory: LocalDirectoryHandle,
  prefix = '',
  handles = new Map<string, LocalFileHandle>(),
): Promise<{ files: LocalProjectFileInput[]; handles: Map<string, LocalFileHandle> }> {
  const files: LocalProjectFileInput[] = [];
  for await (const entry of directory.values()) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === 'directory') {
      const nested = await readDirectoryFiles(entry, relativePath, handles);
      files.push(...nested.files);
      continue;
    }
    if (!isSupportedLocalDocument(entry.name)) continue;
    const file = await entry.getFile();
    handles.set(relativePath, entry);
    files.push({
      relativePath,
      text: await file.text(),
      size: file.size,
      mtimeMs: file.lastModified,
    });
  }
  return { files, handles };
}

function localProjectInputFromFile(file: File): LocalProjectFileInput | null {
  if (!isSupportedLocalDocument(file.name)) return null;
  const relativePath = file.webkitRelativePath || file.name;
  return { relativePath, text: '', size: file.size, mtimeMs: file.lastModified };
}

function buildFileTree(documents: Doc[], localProject: LocalProjectStatus | null): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  for (const document of documents) {
    const relativePath = localProject?.files.find((file) => file.documentId === document.id)?.relativePath ?? document.title;
    const segments = relativePath.split('/').filter(Boolean);
    let folders = root;
    let path = '';
    segments.forEach((segment, index) => {
      path = path ? `${path}/${segment}` : segment;
      const existing = folders.find((node) => node.name === segment);
      if (index === segments.length - 1) {
        if (existing) existing.document = document;
        else folders.push({ name: segment, path, folders: [], document });
        return;
      }
      const folder = existing ?? { name: segment, path, folders: [] };
      if (!existing) folders.push(folder);
      folders = folder.folders;
    });
  }
  const sortNodes = (nodes: FileTreeNode[]): FileTreeNode[] => {
    nodes.sort((left, right) => {
      if (left.document === undefined && right.document !== undefined) return -1;
      if (left.document !== undefined && right.document === undefined) return 1;
      return left.name.localeCompare(right.name, 'zh-CN');
    });
    nodes.forEach((node) => sortNodes(node.folders));
    return nodes;
  };
  return sortNodes(root);
}

type ModalProps = {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  variant?: 'dialog' | 'drawer';
  returnFocusRef?: React.RefObject<HTMLElement | null>;
};

function Modal({ open, title, description, onClose, children, variant = 'dialog', returnFocusRef }: ModalProps): React.ReactElement | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    const activeElement = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const previous = returnFocusRef?.current ?? activeElement;
    const dialog = dialogRef.current;
    const focusableSelector = 'button:not([disabled]), input:not([disabled]):not(.visually-hidden), textarea:not([disabled]):not(.visually-hidden), select:not([disabled]):not(.visually-hidden), [href], [tabindex]:not([tabindex="-1"]):not(.visually-hidden)';
    const focusFirst = () => {
      const first = dialog?.querySelector<HTMLElement>('.modal-form input, .modal-form textarea, .modal-form select') ?? dialog?.querySelector<HTMLElement>(focusableSelector);
      (first ?? dialog)?.focus();
    };
    const frame = window.requestAnimationFrame(focusFirst);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector));
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [open, returnFocusRef]);
  if (!open) return null;
  const titleId = `modal-title-${title.replace(/\s+/gu, '-').toLowerCase()}`;
  return (
    <div className={`modal-layer ${variant === 'drawer' ? 'drawer-layer' : ''}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className={`modal-surface ${variant === 'drawer' ? 'drawer-surface' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="modal-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <button className="modal-close" type="button" aria-label="关闭" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

type PopoverOption = {
  id: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};
type PopoverMenuProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef?: React.MutableRefObject<HTMLButtonElement | null>;
  trigger: React.ReactNode;
  ariaLabel: string;
  heading: string;
  description?: string;
  options: PopoverOption[];
  actions?: Array<{ label: string; onSelect: () => void }>;
  disabled?: boolean;
  hideEmptyOptions?: boolean;
};

function PopoverMenu({ open, onOpenChange, triggerRef, trigger, ariaLabel, heading, description, options, actions, disabled = false, hideEmptyOptions = false }: PopoverMenuProps): React.ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const internalTriggerRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef(onOpenChange);
  closeRef.current = onOpenChange;
  useEffect(() => {
    if (!open) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const selected = menuRef.current?.querySelector<HTMLElement>('[data-popover-option][aria-checked="true"]');
      const first = selected ?? menuRef.current?.querySelector<HTMLElement>('[data-popover-option]:not([disabled])');
      first?.focus();
    });
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeRef.current(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current(false);
        (triggerRef?.current ?? internalTriggerRef.current)?.focus();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, triggerRef]);
  const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[data-popover-option]:not([disabled])') ?? []);
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  return (
    <div ref={rootRef} className="popover-root">
      <button
        ref={(node) => {
          internalTriggerRef.current = node;
          if (triggerRef) triggerRef.current = node;
        }}
        className="popover-trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpenChange(true);
          }
        }}
      >
        {trigger}
        <span className={`popover-chevron ${open ? 'open' : ''}`} aria-hidden="true" />
      </button>
      {open ? (
        <div ref={menuRef} className="popover-menu" role="menu" aria-label={heading} onKeyDown={moveFocus}>
          <div className="popover-menu-head">
            <strong>{heading}</strong>
            {description ? <small>{description}</small> : null}
          </div>
          {options.length || !hideEmptyOptions ? <div className="popover-options">
            {options.length ? options.map((option) => (
              <button
                key={option.id}
                className={`popover-option ${option.selected ? 'selected' : ''}`}
                type="button"
                role="menuitemradio"
                aria-checked={option.selected === true}
                data-popover-option="true"
                disabled={option.disabled}
                onClick={() => { option.onSelect(); onOpenChange(false); }}
              >
                <span className="popover-option-mark" aria-hidden="true">{option.selected ? '✓' : ''}</span>
                <span className="popover-option-copy"><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>
              </button>
            )) : <div className="popover-empty">暂时没有可选项</div>}
          </div> : null}
          {actions?.length ? <div className="popover-actions">{actions.map((action) => <button className="popover-action" key={action.label} type="button" role="menuitem" onClick={() => { action.onSelect(); onOpenChange(false); }}>{action.label}<span aria-hidden="true">↗</span></button>)}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function App(): React.ReactElement {
  const [authState, setAuthState] = useState<'loading' | 'unauthenticated' | 'authenticated'>('loading');
  const [principals, setPrincipals] = useState<Principal[]>([]);
  const [principalId, setPrincipalId] = useState('');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [workspaceDetail, setWorkspaceDetail] = useState<WorkspaceDetail | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [text, setText] = useState('');
  const [outlineEntries, setOutlineEntries] = useState<OutlineEntry[]>([]);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [members, setMembers] = useState<Principal[]>([]);
  const [online, setOnline] = useState<string[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [selectedRange, setSelectedRange] = useState<Selection | null>(null);
  const [outlineTarget, setOutlineTarget] = useState<Selection | null>(null);
  const [editorViewMode, setEditorViewMode] = useState<'source' | 'preview'>('source');
  const [comment, setComment] = useState('');
  const [mentionState, setMentionState] = useState<MentionState | null>(null);
  const [documentAction, setDocumentAction] = useState<'comment' | null>(null);
  const [editingSuggestionId, setEditingSuggestionId] = useState<string | null>(null);
  const [editingSuggestionText, setEditingSuggestionText] = useState('');
  const [suggestionMessage, setSuggestionMessage] = useState('');
  const [asTask, setAsTask] = useState(false);
  const [assignedAgentId, setAssignedAgentId] = useState('');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentStatusUpdates, setAgentStatusUpdates] = useState<Record<string, AgentStatusUpdate>>({});
  const [latestAgentStatus, setLatestAgentStatus] = useState<AgentStatusUpdate | null>(null);
  const [showNewDocument, setShowNewDocument] = useState(false);
  const [newDocumentTitle, setNewDocumentTitle] = useState('');
  const [newDocumentText, setNewDocumentText] = useState('');
  const [showNewWorkspace, setShowNewWorkspace] = useState(false);
  const [newWorkspaceTitle, setNewWorkspaceTitle] = useState('');
  const [showRenameWorkspace, setShowRenameWorkspace] = useState(false);
  const [renameWorkspaceTitle, setRenameWorkspaceTitle] = useState('');
  const [showDeleteWorkspace, setShowDeleteWorkspace] = useState(false);
  const [deleteWorkspaceConfirmation, setDeleteWorkspaceConfirmation] = useState('');
  const [workspaceActionMessage, setWorkspaceActionMessage] = useState('');
  const [showAccountRegistration, setShowAccountRegistration] = useState(false);
  const [newProjectPath, setNewProjectPath] = useState('');
  const [newProjectFiles, setNewProjectFiles] = useState<LocalProjectFileInput[]>([]);
  const [newProjectFolderName, setNewProjectFolderName] = useState('');
  const [newProjectBusy, setNewProjectBusy] = useState(false);
  const [workspaceMessage, setWorkspaceMessage] = useState('');
  const [localProject, setLocalProject] = useState<LocalProjectStatus | null>(null);
  const [localProjectFolderName, setLocalProjectFolderName] = useState('');
  const [localWritebackAvailable, setLocalWritebackAvailable] = useState(false);
  const [showLocalProject, setShowLocalProject] = useState(false);
  const [workspaceSyncing, setWorkspaceSyncing] = useState(false);
  const [showInviteMember, setShowInviteMember] = useState(false);
  const [memberDialogMode, setMemberDialogMode] = useState<'invite' | 'manage' | 'inbox'>('manage');
  const [inviteIdentifier, setInviteIdentifier] = useState('');
  const [accountMatches, setAccountMatches] = useState<Principal[]>([]);
  const [inviteRole, setInviteRole] = useState<CollaboratorRole>('commenter');
  const [newMemberDisplayName, setNewMemberDisplayName] = useState('');
  const [newMemberHandle, setNewMemberHandle] = useState('');
  const [inviteMessage, setInviteMessage] = useState('');
  const [accountMessage, setAccountMessage] = useState('');
  const [accountBusy, setAccountBusy] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authIdentifier, setAuthIdentifier] = useState('');
  const [authDisplayName, setAuthDisplayName] = useState('');
  const [authHandle, setAuthHandle] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authEmail, setAuthEmail] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState('');
  const [savedAccounts, setSavedAccounts] = useState<SavedAccount[]>(() => loadSavedAccounts());
  const [openPopover, setOpenPopover] = useState<'account' | 'workspace' | null>(null);
  const [memberBusy, setMemberBusy] = useState(false);
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  const [workspaceInvitations, setWorkspaceInvitations] = useState<WorkspaceInvitation[]>([]);
  const [tab, setTab] = useState<'members' | 'comments'>('comments');
  const [showAgentConfig, setShowAgentConfig] = useState(false);
  const [showModelProviders, setShowModelProviders] = useState(false);
  const [agentConfigFocusId, setAgentConfigFocusId] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'offline'>('connecting');
  const socketRef = useRef<WebSocket | null>(null);
  const ydocRef = useRef<Y.Doc | null>(null);
  const suppressRef = useRef(false);
  const newProjectFolderInputRef = useRef<HTMLInputElement | null>(null);
  const newWorkspaceTriggerRef = useRef<HTMLButtonElement | null>(null);
  const newDocumentTriggerRef = useRef<HTMLButtonElement | null>(null);
  const inviteMemberTriggerRef = useRef<HTMLButtonElement | null>(null);
  const accountTriggerRef = useRef<HTMLButtonElement | null>(null);
  const invitationInboxTriggerRef = useRef<HTMLButtonElement | null>(null);
  const agentConfigTriggerRef = useRef<HTMLButtonElement | null>(null);
  const projectSettingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const commentInputRef = useRef<HTMLTextAreaElement | null>(null);
  const previewSelectionRef = useRef<Selection | null>(null);
  const preservePreviewSelectionRef = useRef(false);
  const localDirectoryHandleRef = useRef<LocalDirectoryHandle | null>(null);
  const localFileHandlesRef = useRef<Map<string, LocalFileHandle>>(new Map());
  const localDocumentPathsRef = useRef<Map<string, string>>(new Map());
  const reviewLoadSequenceRef = useRef(0);
  const localBaselineRef = useRef<Map<string, number>>(new Map());
  const preserveLocalBindingRef = useRef(false);
  const localWriteTimerRef = useRef<number | null>(null);
  const headers = { 'Content-Type': 'application/json' };
  const pendingInvitations = invitations.filter((invitation) => invitation.status === 'pending');
  const pendingSuggestionCount = suggestions.filter((suggestion) => suggestion.status === 'pending').length;
  const reviewMarkers: ReviewMarker[] = [
    ...threads.flatMap((thread) => {
      if (thread.scope.type !== 'range' || !thread.scope.resolved || thread.scope.resolved.start === undefined || thread.scope.resolved.end === undefined) return [];
      return [{ id: `thread:${thread.id}`, threadId: thread.id, start: thread.scope.resolved.start, end: thread.scope.resolved.end, kind: 'thread' as const, status: thread.status }];
    }),
    ...suggestions.flatMap((suggestion) => {
      if (!suggestion.resolved || suggestion.resolved.start === undefined || suggestion.resolved.end === undefined) return [];
      return [{ id: `suggestion:${suggestion.id}`, ...(suggestion.threadId ? { threadId: suggestion.threadId } : {}), start: suggestion.resolved.start, end: suggestion.resolved.end, kind: 'suggestion' as const, status: suggestion.withdrawnAt !== undefined ? 'rejected' as const : suggestion.status }];
    }),
  ];
  const globalThreads = threads.filter((thread) => thread.scope.type === 'document');
  const activeRangeThread = activeThreadId ? threads.find((thread) => thread.id === activeThreadId && thread.scope.type === 'range') : undefined;
  const visibleThreads = [...(activeRangeThread ? [activeRangeThread] : []), ...globalThreads.filter((thread) => thread.id !== activeRangeThread?.id)];
  const unthreadedSuggestions = suggestions.filter((suggestion) => suggestion.threadId === undefined);
  const refreshInvitations = async () => {
    const next = await request<WorkspaceInvitation[]>('/api/invitations', { headers });
    if (next) setInvitations(next);
  };
  const refreshWorkspaceInvitations = async () => {
    if (!workspaceId || workspaceRole !== 'owner') return;
    const next = await request<WorkspaceInvitation[]>(`/api/workspaces/${workspaceId}/invitations`, { headers });
    if (next) setWorkspaceInvitations(next);
  };
  const reloadReview = async (docId: string) => {
    const sequence = ++reviewLoadSequenceRef.current;
    const [nextThreads, nextSuggestions] = await Promise.all([
      request<Thread[]>(`/api/docs/${docId}/threads`, { headers }),
      request<Suggestion[]>(`/api/docs/${docId}/suggestions`, { headers }),
    ]);
    if (sequence !== reviewLoadSequenceRef.current) return;
    if (nextThreads) setThreads(nextThreads);
    if (nextSuggestions) setSuggestions(nextSuggestions);
  };
  useEffect(() => {
    let active = true;
    void request<AuthSession>('/api/auth/session').then((value) => {
      if (!active) return;
      const principal = value?.principal;
      if (principal && principal.kind === 'human') {
        setPrincipalId(principal.id);
        setPrincipals([principal]);
        setAuthState('authenticated');
      } else {
        setPrincipalId('');
        setAuthState('unauthenticated');
      }
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!principalId || authState !== 'authenticated') return;
    void request<Principal[]>('/api/principals', { headers }).then((value) => {
      if (value) setPrincipals((current) => {
        const humans = value.filter((principal) => principal.kind === 'human');
        const currentPrincipal = current.find((principal) => principal.id === principalId);
        return humans.some((principal) => principal.id === principalId) ? humans : currentPrincipal ? [currentPrincipal, ...humans] : humans;
      });
    });
  }, [principalId, authState]);
  useEffect(() => {
    if (!principalId || authState !== 'authenticated') return;
    void refreshInvitations();
  }, [principalId, authState]);
  useEffect(() => {
    if (!principalId || authState !== 'authenticated') return;
    void request<Workspace[]>('/api/workspaces', { headers }).then((next) => {
      if (next === null) return;
      setWorkspaces(next);
      setMembers([]);
      setOnline([]);
      const preferredWorkspaceId = loadLastWorkspace(principalId);
      const current = next.find((item) => item.id === workspaceId) ?? next.find((item) => item.id === preferredWorkspaceId) ?? next[0];
      setWorkspaceId(current?.id ?? '');
      setDocs(current?.documents ?? []);
      setDoc((selected) =>
        selected && current?.documents.some((item) => item.id === selected.id)
          ? selected
          : (current?.documents[0] ?? null),
      );
      if (!current) {
        void request<Doc[]>('/api/docs', { headers }).then((items) => {
          if (items) {
            setDocs(items);
            setDoc((selected) => selected && items.some((item) => item.id === selected.id) ? selected : (items[0] ?? null));
          }
        });
      }
    });
  }, [principalId, authState]);
  useEffect(() => {
    if (principalId && workspaceId) rememberLastWorkspace(principalId, workspaceId);
  }, [principalId, workspaceId]);
  useEffect(() => {
    if (!principalId || authState !== 'authenticated') return;
    if (!workspaceId) {
      setWorkspaceDetail(null);
      return;
    }
    void request<WorkspaceDetail>(`/api/workspaces/${workspaceId}`, { headers }).then((detail) => {
      if (!detail) return;
      setWorkspaceDetail(detail);
      setDocs(detail.documents);
      setDoc((selected) => selected && detail.documents.some((item) => item.id === selected.id) ? selected : (detail.documents[0] ?? null));
    });
  }, [workspaceId, principalId, authState]);
  useEffect(() => {
    newProjectFolderInputRef.current?.setAttribute('webkitdirectory', '');
  }, [showNewWorkspace]);
  useEffect(() => {
    if (!principalId || authState !== 'authenticated') return;
    const preserveLocalBinding = preserveLocalBindingRef.current;
    preserveLocalBindingRef.current = false;
    if (!preserveLocalBinding) {
      localDirectoryHandleRef.current = null;
      localFileHandlesRef.current = new Map();
      localDocumentPathsRef.current = new Map();
      localBaselineRef.current = new Map();
      setLocalProjectFolderName('');
      setLocalWritebackAvailable(false);
    }
    setLocalProject(null);
    if (!workspaceId) return;
    void fetch(`/api/workspaces/${workspaceId}/local-project`, { credentials: 'include', headers }).then(async (response) => {
      if (response.status === 404) return null;
      if (!response.ok) return null;
      return (await response.json()) as LocalProjectStatus;
    }).then((status) => {
      if (!status || (status.source === 'managed' && !status.path && status.files.length === 0)) return;
      setLocalProject(status);
      for (const file of status.files) {
        if (file.documentId) localDocumentPathsRef.current.set(file.documentId, file.relativePath);
      }
    });
  }, [workspaceId, principalId, authState]);
  useEffect(() => {
    if (authState !== 'authenticated') return;
    if (!doc) {
      setOutlineEntries([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void request<OutlineEntry[]>(`/api/docs/${doc.id}/outline`, { headers }).then((next) => {
        if (next) setOutlineEntries(next);
      });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [doc?.id, principalId, authState, text]);
  useEffect(() => {
    setOutlineTarget(null);
    previewSelectionRef.current = null;
    preservePreviewSelectionRef.current = false;
    setSelectedRange(null);
    setActiveThreadId(null);
    setDocumentAction(null);
    setComment('');
    setMentionState(null);
    setEditingSuggestionId(null);
    setEditingSuggestionText('');
    setSuggestionMessage('');
  }, [doc?.id]);
  useEffect(() => {
    if (authState !== 'authenticated') return;
    if (doc) void reloadReview(doc.id);
  }, [doc?.id, principalId, authState]);
  useEffect(() => {
    setAgentStatusUpdates({});
    setLatestAgentStatus(null);
  }, [doc?.id]);
  useEffect(() => {
    if (authState !== 'authenticated') return;
    if (doc)
      void request<Agent[]>(`/api/docs/${doc.id}/agents`, { headers }).then((value) => {
        if (value) setAgents(value);
      });
  }, [doc?.id, principalId, authState]);
  useEffect(() => {
    if (authState !== 'authenticated' || !principalId) return;
    if (!doc) return;
    const source = new EventSource(`/api/docs/${doc.id}/events`);
    const reload = () => {
      void reloadReview(doc.id);
    };
    for (const name of [
      'thread.created',
      'thread.resolved',
      'message.created',
      'message.updated',
      'suggestion.created',
      'suggestion.updated',
      'document.changed',
      'agent.status',
    ])
      source.addEventListener(name, reload);
    source.addEventListener('agent.status', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { data?: AgentStatusUpdate };
        const update = payload.data;
        if (update && typeof update.agentId === 'string' && typeof update.threadId === 'string' && (update.state === 'working' || update.state === 'idle' || update.state === 'failed')) {
          setAgentStatusUpdates((current) => ({ ...current, [update.threadId]: update }));
          setLatestAgentStatus(update);
        }
      } catch {
        // The follow-up request still refreshes the durable agent state.
      }
      void request<Agent[]>(`/api/docs/${doc.id}/agents`, { headers }).then((value) => {
        if (value) setAgents(value);
      });
    });
    return () => source.close();
  }, [doc?.id, principalId, authState]);
  useEffect(() => {
    if (authState !== 'authenticated' || !principalId) return;
    if (!doc) return;
    setConnectionState('connecting');
    const ydoc = new Y.Doc();
    ydocRef.current = ydoc;
    setText(doc.text);
    const socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/docs/${doc.id}`,
    );
    socketRef.current = socket;
    socket.onopen = () => {
      if (socketRef.current !== socket) return;
      setConnectionState('connected');
      const update = Y.encodeStateAsUpdate(ydoc);
      socket.send(JSON.stringify({ type: 'sync', update: btoa(String.fromCharCode(...update)) }));
    };
    socket.onerror = () => setConnectionState('offline');
    socket.onclose = () => {
      if (socketRef.current === socket) setConnectionState('offline');
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        update?: string;
        members?: Principal[];
        principalId?: string;
        state?: unknown;
      };
      if (message.type === 'sync' && message.update) {
        Y.applyUpdate(
          ydoc,
          Uint8Array.from(atob(message.update), (char) => char.charCodeAt(0)),
        );
        suppressRef.current = true;
        setText(ydoc.getText('content').toString());
        suppressRef.current = false;
      } else if (message.type === 'members' && message.members) {
        setMembers(message.members);
        setOnline(message.members.map((member) => member.id));
      } else if (message.type === 'awareness' && message.principalId)
        setOnline((current) =>
          current.includes(message.principalId as string)
            ? current
            : [...current, message.principalId as string],
        );
    };
    return () => {
      socket.close();
      ydoc.destroy();
      socketRef.current = null;
    };
  }, [doc?.id, principalId, authState]);
  const refreshWorkspace = async () => {
    if (!workspaceId) return;
    const detail = await request<WorkspaceDetail>(`/api/workspaces/${workspaceId}`, { headers });
    if (!detail) return;
    setWorkspaceDetail(detail);
    setMembers(detail.members);
    setDocs(detail.documents);
    setWorkspaces((current) => current.map((item) => item.id === detail.id ? { ...item, documents: detail.documents } : item));
    setDoc((selected) => selected && detail.documents.some((item) => item.id === selected.id) ? selected : (detail.documents[0] ?? null));
  };
  const attachLocalProject = async (
    files: LocalProjectFileInput[],
    targetWorkspaceId = workspaceId,
    pathOverride = '',
    allowEmptySelection = false,
  ): Promise<LocalProjectStatus | null> => {
    if (!targetWorkspaceId) return null;
    const path = pathOverride.trim();
    const hasBrowserDirectory = localDirectoryHandleRef.current !== null;
    if (!path && !files.length && !hasBrowserDirectory && !allowEmptySelection) {
      setWorkspaceMessage('请先选择文件夹，或填写服务端可访问的绝对路径。');
      return null;
    }
    setWorkspaceMessage(`正在扫描 ${SUPPORTED_LOCAL_DOCUMENT_LABEL} 文档…`);
    const body = {
      ...(path ? { path } : {}),
      ...(path ? {} : { files }),
    };
    const status = await request<LocalProjectStatus>(`/api/workspaces/${targetWorkspaceId}/local-project`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!status) {
      setWorkspaceMessage(`连接失败。请确认服务端能访问这个目录，并检查其中是否有 ${SUPPORTED_LOCAL_DOCUMENT_LABEL} 文档。`);
      return null;
    }
    setLocalProject(status);
    const browserWriteback = localWritebackAvailable || localDirectoryHandleRef.current !== null;
    const writebackMessage = status.source === 'local' && status.path
      ? '服务端已绑定目录，编辑结果会写回本地文件。'
      : browserWriteback
        ? '已映射文件；当前页面会把编辑结果写回原文件。'
        : '已导入文件清单；如需持续写回，请填写服务端可访问路径。';
    setWorkspaceMessage(`已映射 ${status.files.length} 个 ${SUPPORTED_LOCAL_DOCUMENT_LABEL} 文档。${writebackMessage}`);
    localDocumentPathsRef.current = new Map(status.files.filter((file) => file.documentId).map((file) => [file.documentId as string, file.relativePath]));
    if (targetWorkspaceId === workspaceId) {
      await refreshWorkspace();
      return status;
    }
    const detail = await request<WorkspaceDetail>(`/api/workspaces/${targetWorkspaceId}`, { headers });
    if (detail) {
      setWorkspaceDetail(detail);
      setDocs(detail.documents);
      setDoc(detail.documents[0] ?? null);
      setWorkspaces((current) => current.map((item) => item.id === detail.id ? { ...item, documents: detail.documents } : item));
    }
    return status;
  };
  const handleNewProjectFolderInput = async (event: React.ChangeEvent<HTMLInputElement>) => {
    localDirectoryHandleRef.current = null;
    localFileHandlesRef.current = new Map();
    localBaselineRef.current = new Map();
    const selected = Array.from(event.target.files ?? []);
    const txtFiles = await Promise.all(selected.map(async (file) => {
      const input = localProjectInputFromFile(file);
      if (!input) return null;
      return { ...input, text: await file.text() };
    }));
    const files = txtFiles.filter((file): file is LocalProjectFileInput => file !== null);
    setNewProjectFiles(files);
    setNewProjectFolderName(files[0]?.relativePath.split('/')[0] ?? '已选择文件夹');
    setLocalProjectFolderName(files[0]?.relativePath.split('/')[0] ?? '已选择文件夹');
    setLocalWritebackAvailable(false);
    setWorkspaceMessage('');
    event.target.value = '';
  };
  const chooseNewProjectFolder = async () => {
    const pickerWindow = window as DirectoryPickerWindow;
    if (pickerWindow.showDirectoryPicker) {
      try {
        const directory = await pickerWindow.showDirectoryPicker();
        const result = await readDirectoryFiles(directory);
        localDirectoryHandleRef.current = directory;
        localFileHandlesRef.current = result.handles;
        localBaselineRef.current = new Map(result.files.map((file) => [file.relativePath, file.mtimeMs]));
        setNewProjectFiles(result.files);
        setNewProjectFolderName(directory.name);
        setLocalProjectFolderName(directory.name);
        setLocalWritebackAvailable(true);
        setWorkspaceMessage(result.files.length ? '' : `文件夹已选择，里面暂时没有 ${SUPPORTED_LOCAL_DOCUMENT_LABEL} 文档。创建后仍可继续绑定。`);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setWorkspaceMessage('无法读取这个文件夹，请改用服务端路径。');
      }
      return;
    }
    const input = newProjectFolderInputRef.current;
    if (!input) return;
    try {
      if (typeof input.showPicker === 'function') input.showPicker();
      else input.click();
    } catch {
      input.click();
    }
  };
  const syncWorkspaceWithLocal = async () => {
    if (!workspaceId || !localProject) {
      setWorkspaceMessage('这个项目还没有本地文件夹连接。');
      return;
    }
    setWorkspaceSyncing(true);
    setWorkspaceMessage('正在同步云端和本地文件…');
    try {
      if (localDirectoryHandleRef.current) {
        const result = await readDirectoryFiles(localDirectoryHandleRef.current);
        localFileHandlesRef.current = result.handles;
        localBaselineRef.current = new Map(result.files.map((file) => [file.relativePath, file.mtimeMs]));
        const status = await attachLocalProject(result.files, workspaceId, '');
        if (!status) {
          setWorkspaceMessage('同步失败，请检查本地文件夹权限。');
          return;
        }
        setWorkspaceMessage(syncSummary(status.files));
        return;
      }
      const status = await request<LocalProjectStatus>(`/api/workspaces/${workspaceId}/local-project/scan`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      if (!status) {
        setWorkspaceMessage('同步失败，请检查服务端目录是否仍然可访问。');
        return;
      }
      setLocalProject(status);
      await refreshWorkspace();
      setWorkspaceMessage(syncSummary(status.files));
    } finally {
      setWorkspaceSyncing(false);
    }
  };
  const writeToBrowserFile = (documentId: string, value: string) => {
    const relativePath = localDocumentPathsRef.current.get(documentId);
    const fileHandle = relativePath ? localFileHandlesRef.current.get(relativePath) : undefined;
    if (!relativePath || !fileHandle?.createWritable) return;
    if (localWriteTimerRef.current !== null) window.clearTimeout(localWriteTimerRef.current);
    localWriteTimerRef.current = window.setTimeout(() => {
      void (async () => {
        const file = await fileHandle.getFile();
        const baseline = localBaselineRef.current.get(relativePath);
        if (baseline !== undefined && file.lastModified > baseline + 1000) {
          setWorkspaceMessage(`检测到 ${relativePath} 已在外部修改，暂未覆盖。`);
          setLocalProject((current) => current ? {
            ...current,
            files: current.files.map((item) => item.relativePath === relativePath ? { ...item, status: 'conflict' } : item),
          } : current);
          return;
        }
        const writable = await fileHandle.createWritable?.();
        if (!writable) return;
        await writable.write(value);
        await writable.close();
        localBaselineRef.current.set(relativePath, Date.now());
        setWorkspaceMessage(`已写回 ${relativePath}`);
      })().catch(() => setWorkspaceMessage(`写回 ${relativePath} 失败，请重新选择文件夹。`));
    }, 450);
  };
  const updateText = (next: string) => {
    setText(next);
    if (suppressRef.current || !ydocRef.current) return;
    const ydoc = ydocRef.current;
    const ytext = ydoc.getText('content');
    const previous = ytext.toString();
    let start = 0;
    while (start < previous.length && start < next.length && previous[start] === next[start])
      start += 1;
    let oldEnd = previous.length;
    let newEnd = next.length;
    while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) {
      oldEnd -= 1;
      newEnd -= 1;
    }
    ydoc.transact(() => {
      ytext.delete(start, oldEnd - start);
      if (newEnd > start) ytext.insert(start, next.slice(start, newEnd));
    });
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      const update = Y.encodeStateAsUpdate(ydoc);
      socket.send(JSON.stringify({ type: 'sync', update: btoa(String.fromCharCode(...update)) }));
    }
    if (doc && localDirectoryHandleRef.current) writeToBrowserFile(doc.id, next);
  };
  const role =
    members.find((member) => member.id === principalId)?.role ??
    workspaceDetail?.members.find((member) => member.id === principalId)?.role ??
    workspaceDetail?.role ??
    'viewer';
  const editable = ['editor', 'owner'].includes(role);
  const workspaceRole = workspaceDetail?.role ?? workspaces.find((item) => item.id === workspaceId)?.role ?? role;
  const canSyncLocalProject = Boolean(localProject) && (localProject?.source === 'local' ? ['editor', 'owner'].includes(workspaceRole) : workspaceRole === 'owner');
  const workspaceMembers = workspaceDetail?.members ?? members;
  const mentionCandidates = mentionState ? workspaceMembers.filter((member) => {
    const input = comment.slice(mentionState.start + 1, mentionState.end).trim().toLocaleLowerCase();
    if (!input) return true;
    return member.displayName.toLocaleLowerCase().startsWith(input)
      || member.handle?.toLocaleLowerCase().startsWith(input);
  }).slice(0, 8) : [];
  const currentPrincipal = principals.find((principal) => principal.id === principalId);
  const canCreateWorkspace = currentPrincipal?.kind === 'human';
  const fileTree = buildFileTree(docs, localProject);
  const currentDocumentPath = doc ? localProject?.files.find((file) => file.documentId === doc.id)?.relativePath ?? doc.title : undefined;
  const currentDocumentKind: 'text' | 'markdown' = currentDocumentPath?.toLowerCase().endsWith('.md') ? 'markdown' : 'text';
  const renderFileTree = (nodes: FileTreeNode[], depth = 0): React.ReactNode => nodes.map((node) => (
    <React.Fragment key={node.path}>
      {node.document ? (
        <button
          className={`file-tree-item ${node.document.id === doc?.id ? 'selected' : ''}`}
          type="button"
          style={{ paddingLeft: `${10 + depth * 14}px` }}
          onClick={() => { if (node.document) setDoc(node.document); }}
          title={node.path}
        >
          <span className="file-tree-glyph file" aria-hidden="true" />
          <span>{node.name}</span>
        </button>
      ) : (
        <button
          className="file-tree-folder"
          type="button"
          aria-expanded={!collapsedFolders.has(node.path)}
          style={{ paddingLeft: `${10 + depth * 14}px` }}
          onClick={() => setCollapsedFolders((current) => {
            const next = new Set(current);
            if (next.has(node.path)) next.delete(node.path);
            else next.add(node.path);
            return next;
          })}
        >
          <span className="file-tree-glyph folder" aria-hidden="true" />
          <strong>{node.name}</strong>
          <span className={`file-tree-chevron ${collapsedFolders.has(node.path) ? 'collapsed' : ''}`} aria-hidden="true" />
        </button>
      )}
      {node.folders.length && !collapsedFolders.has(node.path) ? <div className="file-tree-children">{renderFileTree(node.folders, depth + 1)}</div> : null}
    </React.Fragment>
  ));
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const activeAgentStatusUpdate = activeThread?.id === undefined ? latestAgentStatus : agentStatusUpdates[activeThread.id];
  const activeAgent = activeAgentStatusUpdate ? agents.find((agent) => agent.id === activeAgentStatusUpdate.agentId) : undefined;
  const activeAgentFeedback = activeAgentStatusUpdate && activeAgent
    ? agentStatusCopy(activeAgent.displayName, activeAgentStatusUpdate.state, activeAgentStatusUpdate.error, activeAgentStatusUpdate.errorKind)
    : null;
  const updateMentionState = (value: string, caret: number) => {
    const beforeCaret = value.slice(0, caret);
    const match = beforeCaret.match(/(?:^|[^\p{L}\p{N}_])@([^\n]*)$/u);
    if (!match) {
      setMentionState(null);
      return;
    }
    const query = match[1] ?? '';
    const start = caret - query.length - 1;
    const previous = value[start - 1];
    if (previous && /[\p{L}\p{N}_]/u.test(previous)) {
      setMentionState(null);
      return;
    }
    setMentionState({ start, end: caret, index: 0 });
  };
  const insertMention = (member: Principal) => {
    if (!mentionState) return;
    const inserted = `@${member.displayName} `;
    const next = `${comment.slice(0, mentionState.start)}${inserted}${comment.slice(mentionState.end)}`;
    const caret = mentionState.start + inserted.length;
    setComment(next);
    setMentionState(null);
    window.requestAnimationFrame(() => {
      const input = commentInputRef.current;
      input?.focus();
      input?.setSelectionRange(caret, caret);
    });
  };
  const handleCommentChange = (value: string, caret: number) => {
    setComment(value);
    updateMentionState(value, caret);
  };
  const handleCommentKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!mentionState || mentionCandidates.length === 0) {
      if (event.key === 'Escape') setMentionState(null);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setMentionState((current) => {
        if (!current) return current;
        const offset = event.key === 'ArrowDown' ? 1 : -1;
        const index = (current.index + offset + mentionCandidates.length) % mentionCandidates.length;
        return { ...current, index };
      });
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      const candidate = mentionCandidates[mentionState.index] ?? mentionCandidates[0];
      if (candidate) insertMention(candidate);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setMentionState(null);
    }
  };
  const createComment = async (body = comment) => {
    if (!doc || !body.trim()) return;
    const scope = documentAction === 'comment'
      ? { type: 'document' as const }
      : selectedRange
      ? { type: 'range', start: selectedRange.start, end: selectedRange.end }
      : { type: 'document' };
    const thread = await request<Thread>(`/api/docs/${doc.id}/threads`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: asTask ? 'task' : 'discussion',
        ...(asTask && assignedAgentId ? { agentId: assignedAgentId } : {}),
        scope,
      }),
    });
    if (!thread) return;
    await request(`/api/threads/${thread.id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body }),
    });
    setComment('');
    setMentionState(null);
    setDocumentAction(null);
    setActiveThreadId(thread.id);
    setTab('comments');
    await reloadReview(doc.id);
  };
  const sendMessage = async () => {
    if (!activeThread || !comment.trim()) return;
    await request(`/api/threads/${activeThread.id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: comment }),
    });
    setComment('');
    setMentionState(null);
    await reloadReview(activeThread.docId);
  };
  const withdrawMessage = async (messageId: string) => {
    if (!window.confirm('撤回后其他成员只会看到“已撤回”，确定继续吗？')) return;
    const result = await request<Message>(`/api/messages/${messageId}/withdraw`, { method: 'POST', headers, body: '{}' });
    if (result && doc) await reloadReview(doc.id);
  };
  const openDocumentAction = () => {
    if (!doc) return;
    setActiveThreadId(null);
    setDocumentAction('comment');
    setSelectedRange(null);
    setTab('comments');
  };
  const decide = async (id: string, action: 'accept' | 'reject' | 'regenerate') => {
    if (!doc) return;
    await request(`/api/suggestions/${id}/${action}`, { method: 'POST', headers, body: '{}' });
    await reloadReview(doc.id);
  };
  const withdrawSuggestion = async (suggestionId: string) => {
    if (!window.confirm('撤回后这条建议将不再进入审批，确定继续吗？')) return;
    const result = await request<Suggestion>(`/api/suggestions/${suggestionId}/withdraw`, { method: 'POST', headers, body: '{}' });
    if (result && doc) await reloadReview(doc.id);
  };
  const beginSuggestionEdit = (suggestion: Suggestion) => {
    setEditingSuggestionId(suggestion.id);
    setEditingSuggestionText(suggestion.newText);
    setSuggestionMessage('');
  };
  const cancelSuggestionEdit = () => {
    setEditingSuggestionId(null);
    setEditingSuggestionText('');
    setSuggestionMessage('');
  };
  const saveSuggestionEdit = async (suggestion: Suggestion) => {
    if (!doc || suggestion.status !== 'pending' || !['editor', 'owner'].includes(role)) return;
    const updated = await request<Suggestion>(`/api/suggestions/${suggestion.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ newText: editingSuggestionText }),
    });
    if (!updated) {
      setSuggestionMessage('修改建议失败，可能已被处理或选区已经失效。');
      return;
    }
    setEditingSuggestionId(null);
    setEditingSuggestionText('');
    setSuggestionMessage('建议文本已更新，确认无误后再接受。');
    await reloadReview(doc.id);
  };
  const renderSuggestionCard = (suggestion: Suggestion, legacy = false) => {
    const quote = (suggestion.anchor as AnchorPreview).quote;
    const withdrawn = suggestion.withdrawnAt !== undefined;
    return <div className={`thread-suggestion ${legacy ? 'legacy' : ''} ${withdrawn ? 'withdrawn' : suggestion.status}`} key={suggestion.id} onClick={(event) => event.stopPropagation()}>
      <div className="suggestion-row-head"><span className={`state-chip ${withdrawn ? 'withdrawn' : suggestion.status}`}>{withdrawn ? '已撤回' : suggestion.status === 'pending' ? '待审批' : suggestion.status === 'accepted' ? '已接受' : suggestion.status === 'rejected' ? '已拒绝' : '已过期'}</span><span className="suggestion-author">{workspaceMembers.find((member) => member.id === suggestion.authorId)?.displayName ?? 'Agent'} 提出的修改</span></div>
      {editingSuggestionId === suggestion.id ? (
        <div className="suggestion-edit-form">
          <label htmlFor={`thread-suggestion-edit-${suggestion.id}`}>接受前修改文本</label>
          <textarea id={`thread-suggestion-edit-${suggestion.id}`} value={editingSuggestionText} onChange={(event) => setEditingSuggestionText(event.target.value)} />
          <div className="row-actions"><button className="action-button primary" type="button" onClick={() => void saveSuggestionEdit(suggestion)}>保存修改</button><button className="subtle-button" type="button" onClick={cancelSuggestionEdit}>取消</button></div>
        </div>
      ) : quote ? <p className="diff"><del>{quote}</del><span aria-hidden="true">→</span><ins>{suggestion.newText}</ins></p> : <p className="diff">替换为：{suggestion.newText}</p>}
      {suggestion.rationale ? <small>{suggestion.rationale}</small> : null}
      {suggestion.status === 'pending' && !withdrawn && suggestion.authorId === principalId && role !== 'viewer' ? <div className="row-actions"><button className="subtle-button danger" type="button" onClick={() => void withdrawSuggestion(suggestion.id)}>撤回</button></div> : null}
      {suggestion.status === 'pending' && !withdrawn && ['editor', 'owner'].includes(role) && editingSuggestionId !== suggestion.id ? <div className="row-actions"><button className="subtle-button" type="button" onClick={() => beginSuggestionEdit(suggestion)}>编辑修改</button><button className="subtle-button" type="button" onClick={() => void decide(suggestion.id, 'accept')}>接受</button><button className="subtle-button danger" type="button" onClick={() => void decide(suggestion.id, 'reject')}>拒绝</button></div> : null}
      {suggestion.status === 'stale' && ['suggester', 'editor', 'owner'].includes(role) ? <div className="row-actions"><button className="subtle-button" type="button" onClick={() => void decide(suggestion.id, 'regenerate')}>重新生成</button></div> : null}
    </div>;
  };
  const resetNewWorkspaceDraft = () => {
    setNewWorkspaceTitle('');
    setNewProjectPath('');
    setNewProjectFiles([]);
    setNewProjectFolderName('');
    setWorkspaceMessage('');
  };
  const openRenameWorkspace = () => {
    const current = workspaces.find((workspace) => workspace.id === workspaceId);
    if (!current || workspaceRole !== 'owner') return;
    setRenameWorkspaceTitle(current.title);
    setWorkspaceActionMessage('');
    setShowRenameWorkspace(true);
  };
  const renameWorkspace = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!workspaceId || workspaceRole !== 'owner' || !renameWorkspaceTitle.trim()) return;
    const updated = await request<Workspace>(`/api/workspaces/${workspaceId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ title: renameWorkspaceTitle.trim() }),
    });
    if (!updated) {
      setWorkspaceActionMessage('项目重命名失败，请稍后重试。');
      return;
    }
    setWorkspaces((current) => current.map((workspace) => workspace.id === updated.id ? { ...workspace, title: updated.title } : workspace));
    setWorkspaceDetail((current) => current && current.id === updated.id ? { ...current, title: updated.title } : current);
    setWorkspaceMessage(`项目已重命名为“${updated.title}”。`);
    setShowRenameWorkspace(false);
    setRenameWorkspaceTitle('');
  };
  const deleteWorkspace = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const current = workspaces.find((workspace) => workspace.id === workspaceId);
    if (!current || workspaceRole !== 'owner' || deleteWorkspaceConfirmation !== current.title) return;
    const result = await request<{ ok: boolean }>(`/api/workspaces/${current.id}`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ confirmTitle: deleteWorkspaceConfirmation }),
    });
    if (!result?.ok) {
      setWorkspaceActionMessage('项目删除失败，请稍后重试。');
      return;
    }
    const remaining = workspaces.filter((workspace) => workspace.id !== current.id);
    const next = remaining[0];
    setWorkspaces(remaining);
    setWorkspaceId(next?.id ?? '');
    setWorkspaceDetail(null);
    setDocs(next?.documents ?? []);
    setDoc(next?.documents[0] ?? null);
    setMembers([]);
    setOnline([]);
    setActiveThreadId(null);
    setOutlineEntries([]);
    setCollapsedFolders(new Set());
    setShowDeleteWorkspace(false);
    setDeleteWorkspaceConfirmation('');
    setShowLocalProject(false);
    resetLocalProjectView();
    setWorkspaceMessage(`项目“${current.title}”已删除。`);
  };
  const resetLocalProjectView = () => {
    localDirectoryHandleRef.current = null;
    localFileHandlesRef.current = new Map();
    localDocumentPathsRef.current = new Map();
    localBaselineRef.current = new Map();
    setLocalProject(null);
    setLocalProjectFolderName('');
    setLocalWritebackAvailable(false);
  };
  const selectWorkspace = (nextId: string) => {
    const next = workspaces.find((item) => item.id === nextId);
    setWorkspaceId(nextId);
    setWorkspaceDetail(null);
    setDocs(next?.documents ?? []);
    setDoc(next?.documents[0] ?? null);
    setMembers([]);
    setOnline([]);
    setActiveThreadId(null);
    setOutlineEntries([]);
    setCollapsedFolders(new Set());
    setShowNewWorkspace(false);
    setShowNewDocument(false);
    setShowInviteMember(false);
    setWorkspaceInvitations([]);
    setShowLocalProject(false);
    setWorkspaceMessage('');
    setInviteMessage('');
    resetLocalProjectView();
  };
  const workspaceMenuActions = [
    ...(canCreateWorkspace ? [{ label: '新建项目', onSelect: () => { resetNewWorkspaceDraft(); setShowNewWorkspace(true); } }] : []),
    ...(workspaceId ? [{ label: '项目设置', onSelect: () => setShowLocalProject(true) }] : []),
    ...(workspaceId && workspaceRole === 'owner' ? [
      { label: '重命名项目', onSelect: openRenameWorkspace },
      { label: '删除项目', onSelect: () => { setDeleteWorkspaceConfirmation(''); setWorkspaceActionMessage(''); setShowDeleteWorkspace(true); } },
    ] : []),
  ];
  const createDocument = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!workspaceId || !newDocumentTitle.trim()) return;
    const created = await request<Doc>(`/api/workspaces/${workspaceId}/documents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: newDocumentTitle.trim(), text: newDocumentText }),
    });
    if (!created) return;
    setNewDocumentTitle('');
    setNewDocumentText('');
    setShowNewDocument(false);
    setDocs((current) => [...current, created]);
    setDoc(created);
    void request<WorkspaceDetail>(`/api/workspaces/${workspaceId}`, { headers }).then((detail) => {
      if (detail) {
        setWorkspaceDetail(detail);
        setWorkspaces((current) => current.map((item) => item.id === detail.id ? { ...item, documents: detail.documents } : item));
      }
    });
  };
  const createWorkspace = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!newWorkspaceTitle.trim()) return;
    if (!newProjectPath.trim() && !newProjectFiles.length && !newProjectFolderName.trim()) {
      setWorkspaceMessage('请选择项目文件夹，项目创建后会立即与本地目录建立连接。');
      return;
    }
    setNewProjectBusy(true);
    const created = await request<Workspace>('/api/workspaces', {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: newWorkspaceTitle.trim() }),
    });
    if (!created) {
      setWorkspaceMessage('项目创建失败，请检查当前身份权限');
      setNewProjectBusy(false);
      return;
    }
    const selectedFiles = newProjectFiles;
    const selectedPath = newProjectPath;
    const selectedFolderWasChosen = Boolean(newProjectFolderName.trim());
    const selectedDirectory = selectedFolderWasChosen ? localDirectoryHandleRef.current : null;
    setNewWorkspaceTitle('');
    setWorkspaceMessage('项目已创建，正在绑定本地文件夹…');
    setShowNewWorkspace(false);
    setNewProjectBusy(false);
    const createdWorkspace = { ...created, role: 'owner' as const, documents: [] };
    setWorkspaces((current) => [...current, createdWorkspace]);
    setWorkspaceId(created.id);
    if (selectedDirectory) preserveLocalBindingRef.current = true;
    setWorkspaceDetail(null);
    setDocs([]);
    setDoc(null);
    setMembers([]);
    setOnline([]);
    setActiveThreadId(null);
    setOutlineEntries([]);
    setCollapsedFolders(new Set());
    const attached = await attachLocalProject(selectedFiles, created.id, selectedPath, selectedFolderWasChosen);
    if (!attached) setWorkspaceMessage('项目已创建，但本地文件夹绑定失败，请检查目录后重试。');
    else setWorkspaceMessage('项目已创建，本地文件夹已绑定。');
    setNewProjectPath('');
    setNewProjectFiles([]);
    setNewProjectFolderName('');
  };
  const updateWorkspaceMemberState = (updated: WorkspaceMember) => {
    setWorkspaceDetail((current) => current ? { ...current, members: [...current.members.filter((member) => member.id !== updated.id), updated] } : current);
    setMembers((current) => [...current.filter((member) => member.id !== updated.id), updated]);
  };
  const rememberLocalAccount = (principal: Principal, identifier: string, password: string) => {
    const normalizedIdentifier = identifier.trim();
    if (!normalizedIdentifier || !password) return;
    const next: SavedAccount[] = [
      {
        identifier: normalizedIdentifier,
        password,
        displayName: principal.displayName,
        ...(principal.id ? { principalId: principal.id } : {}),
        ...(principal.handle ? { handle: principal.handle } : {}),
        lastUsedAt: Date.now(),
      },
      ...savedAccounts.filter((account) => account.identifier.toLowerCase() !== normalizedIdentifier.toLowerCase()),
    ].slice(0, 12);
    setSavedAccounts(next);
    persistSavedAccounts(next);
  };
  const removeSavedAccount = (identifier: string) => {
    const next = savedAccounts.filter((account) => account.identifier.toLowerCase() !== identifier.toLowerCase());
    setSavedAccounts(next);
    persistSavedAccounts(next);
  };
  const clearSavedAccounts = () => {
    setSavedAccounts([]);
    persistSavedAccounts([]);
  };
  const completeAuthentication = (value: AuthSession | Principal | null): Principal | null => {
    if (!value) return null;
    const principal = 'principal' in value ? value.principal : value;
    if (!principal || principal.kind !== 'human') return null;
    setPrincipalId(principal.id);
    setPrincipals([principal]);
    setAuthState('authenticated');
    setAuthIdentifier('');
    setAuthDisplayName('');
    setAuthHandle('');
    setAuthEmail('');
    setAuthPassword('');
    setAuthMessage('');
    return principal;
  };
  const submitAuthentication = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthBusy(true);
    setAuthMessage('');
    const body = authMode === 'login'
      ? { identifier: authIdentifier.trim(), password: authPassword }
      : {
          displayName: authDisplayName.trim(),
          handle: authHandle.trim().toLowerCase(),
          email: authEmail.trim() || undefined,
          password: authPassword,
        };
    const result = await request<AuthSession | Principal>(`/api/auth/${authMode}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const principal = completeAuthentication(result);
    if (!principal) {
      setAuthMessage(authMode === 'login' ? '登录失败，请检查账号和密码。' : '注册失败，请检查资料或更换账号标识。');
      setAuthBusy(false);
      return;
    }
    const identifier = authMode === 'login' ? authIdentifier.trim() : authHandle.trim() || authEmail.trim();
    rememberLocalAccount(principal, identifier, authPassword);
    setAuthBusy(false);
  };
  const loginWithSavedAccount = async (account: SavedAccount, switchSession = false) => {
    setAuthBusy(true);
    setAuthMessage('');
    const result = await request<AuthSession | Principal>(switchSession ? '/api/auth/switch' : '/api/auth/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({ identifier: account.identifier, password: account.password }),
    });
    const principal = completeAuthentication(result);
    if (!principal) {
      setAuthMessage(`“${account.displayName}”登录失败，请重新输入密码。`);
      setAuthBusy(false);
      return;
    }
    rememberLocalAccount(principal, account.identifier, account.password);
    setAuthBusy(false);
    setOpenPopover(null);
  };
  const registerAccount = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const displayName = newMemberDisplayName.trim();
    if (!displayName) return;
    setAccountBusy(true);
    const updated = await request<Principal>('/api/account', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ displayName, handle: newMemberHandle.trim().toLowerCase() }),
    });
    if (!updated) {
      setAccountMessage('保存失败，请稍后重试');
      setAccountBusy(false);
      return;
    }
    setPrincipals([updated]);
    const updatedSavedAccounts = savedAccounts.map((account) => account.principalId === updated.id ? {
      ...account,
      displayName: updated.displayName,
      ...(updated.handle ? { handle: updated.handle } : {}),
    } : account);
    setSavedAccounts(updatedSavedAccounts);
    persistSavedAccounts(updatedSavedAccounts);
    setNewMemberDisplayName('');
    setNewMemberHandle('');
    setAccountMessage('个人资料已更新。');
    setShowAccountRegistration(false);
    setAccountBusy(false);
  };
  const logoutAccount = async () => {
    const result = await request<{ ok: boolean }>('/api/auth/logout', { method: 'POST', headers, body: '{}' });
    if (!result) {
      setAccountMessage('退出失败，请稍后重试。');
      return;
    }
    setPrincipalId('');
    setAuthState('unauthenticated');
    setPrincipals([]);
    setWorkspaces([]);
    setWorkspaceId('');
    setWorkspaceDetail(null);
    setDocs([]);
    setDoc(null);
    setOpenPopover(null);
    setShowAccountRegistration(false);
    setShowInviteMember(false);
    setShowAgentConfig(false);
    setShowNewWorkspace(false);
    setShowNewDocument(false);
    setWorkspaceInvitations([]);
    setInvitations([]);
    setAccountMessage('已退出当前账号。');
    setAuthMessage('已退出当前账号，可选择本机保存的账号重新登录。');
  };
  const searchAccountMatches = async (value: string) => {
    const query = value.trim();
    if (query.length < 2) {
      setAccountMatches([]);
      return;
    }
    const found = await request<Principal[]>(`/api/accounts/search?q=${encodeURIComponent(query)}`, { headers });
    setAccountMatches((found ?? []).filter((candidate) => !workspaceMembers.some((member) => member.id === candidate.id)));
  };
  const inviteMember = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const identifier = inviteIdentifier.trim();
    if (!workspaceId || !identifier) return;
    setMemberBusy(true);
    const invitation = await request<WorkspaceInvitation>(`/api/workspaces/${workspaceId}/invitations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ identifier, role: inviteRole }),
    });
    if (invitation) {
      setInvitations((current) => [invitation, ...current.filter((item) => item.id !== invitation.id)]);
      await refreshWorkspaceInvitations();
      setInviteIdentifier('');
      setAccountMatches([]);
      setInviteMessage('邀请已发送，等待对方接受。');
      setMemberBusy(false);
      return;
    }
    setInviteMessage('邀请失败，请检查账号标识或项目权限。');
    setMemberBusy(false);
  };
  const updateMemberRole = async (member: Principal, nextRole: CollaboratorRole) => {
    if (!workspaceId || member.role === 'owner' || member.role === nextRole) return;
    setMemberBusy(true);
    const updated = await request<WorkspaceMember>(`/api/workspaces/${workspaceId}/members/${member.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ role: nextRole }),
    });
    if (!updated) setInviteMessage('权限更新失败，请稍后重试');
    else {
      updateWorkspaceMemberState(updated);
      setInviteMessage(`${member.displayName} 的权限已更新为${nextRole}。`);
    }
    setMemberBusy(false);
  };
  const removeMember = async (member: Principal) => {
    if (!workspaceId || member.id === principalId || member.role === 'owner') return;
    if (!window.confirm(`确定要移除 ${member.displayName} 吗？`)) return;
    setMemberBusy(true);
    const removed = await request<{ ok: boolean }>(`/api/workspaces/${workspaceId}/members/${member.id}`, { method: 'DELETE', headers });
    if (!removed) setInviteMessage('移除失败，请稍后重试');
    else {
      setWorkspaceDetail((current) => current ? { ...current, members: current.members.filter((item) => item.id !== member.id) } : current);
      setMembers((current) => current.filter((item) => item.id !== member.id));
      setInviteMessage(`${member.displayName} 已从项目移除。`);
    }
    setMemberBusy(false);
  };
  const refreshWorkspaceAfterInvitation = async (nextWorkspaceId?: string) => {
    await refreshInvitations();
    const nextWorkspaces = await request<Workspace[]>('/api/workspaces', { headers });
    if (!nextWorkspaces) return;
    setWorkspaces(nextWorkspaces);
    if (nextWorkspaceId) selectWorkspace(nextWorkspaceId);
  };
  const respondToInvitation = async (invitation: WorkspaceInvitation, action: 'accept' | 'reject') => {
    setMemberBusy(true);
    const result = await request<WorkspaceInvitation>(`/api/invitations/${invitation.id}/${action}`, { method: 'POST', headers, body: '{}' });
    if (!result) setInviteMessage(action === 'accept' ? '接受邀请失败，请稍后重试' : '拒绝邀请失败，请稍后重试');
    else {
      setInviteMessage(action === 'accept' ? `已加入“${invitation.workspace?.title ?? invitation.workspaceTitle ?? '项目'}”。` : '已拒绝这条邀请。');
      await refreshWorkspaceAfterInvitation(action === 'accept' ? invitation.workspaceId : undefined);
    }
    setMemberBusy(false);
  };
  const openAgentConfiguration = (agentId?: string) => {
    setAgentConfigFocusId(agentId ?? null);
    setShowAgentConfig(true);
  };
  const openReviewMarker = (markerId: string) => {
    const marker = reviewMarkers.find((item) => item.id === markerId);
    const threadId = marker?.threadId ?? (markerId.startsWith('thread:') ? markerId.slice('thread:'.length) : undefined);
    if (!threadId) return;
    setActiveThreadId(threadId);
    setDocumentAction(null);
    setSelectedRange(marker ? { start: marker.start, end: marker.end } : null);
    setTab('comments');
  };
  if (authState === 'loading') {
    return <main className="auth-shell"><section className="auth-card auth-loading"><span className="route-mark" aria-hidden="true"><i /><i /><i /></span><strong>正在检查登录状态</strong><small>正在连接你的协作账户…</small></section></main>;
  }
  if (authState === 'unauthenticated') {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <div className="auth-brand"><span className="route-mark" aria-hidden="true"><i /><i /><i /></span><div><strong>Riff</strong><small>Make every draft better.</small></div></div>
          <div className="auth-heading"><p className="eyebrow">个人账户</p><h1>{authMode === 'login' ? '登录你的工作台' : '创建协作账户'}</h1><p>{authMode === 'login' ? '登录后打开属于你的项目、文档和邀请。' : '注册一个账号，之后可以接受项目邀请并管理自己的 Agent。'}</p></div>
          <div className="auth-mode-switch" role="tablist" aria-label="账户操作">
            <button type="button" className={authMode === 'login' ? 'selected' : ''} onClick={() => { setAuthMode('login'); setAuthMessage(''); }}>登录</button>
            <button type="button" className={authMode === 'register' ? 'selected' : ''} onClick={() => { setAuthMode('register'); setAuthMessage(''); }}>注册</button>
          </div>
          {authMode === 'login' && savedAccounts.length ? (
            <section className="saved-account-section" aria-label="本机已保存账号">
              <div className="saved-account-heading"><strong>本机已保存账号</strong><small>点击即可登录</small></div>
              <div className="saved-account-list">
                {savedAccounts.map((account) => (
                  <div className="saved-account-row" key={account.identifier}>
                    <button className="saved-account-login" type="button" onClick={() => void loginWithSavedAccount(account)} disabled={authBusy}>
                      <span className="avatar" aria-hidden="true">{account.displayName.trim().slice(0, 1) || '我'}</span>
                      <span><strong>{account.displayName}</strong><small>{account.handle ? `@${account.handle}` : account.identifier}</small></span>
                      <em>登录</em>
                    </button>
                    <button className="saved-account-remove" type="button" aria-label={`删除本机账号 ${account.displayName}`} title="删除本机保存记录" onClick={() => removeSavedAccount(account.identifier)} disabled={authBusy}>×</button>
                  </div>
                ))}
              </div>
              <small className="saved-account-note">账号和密码仅保存在此浏览器的本机存储中；使用共享电脑前请删除保存记录。</small>
            </section>
          ) : null}
          <form className="auth-form" onSubmit={(event) => void submitAuthentication(event)}>
            {authMode === 'login' ? <>
              <label htmlFor="auth-identifier">账号标识或邮箱</label>
              <input id="auth-identifier" autoFocus value={authIdentifier} placeholder="例如：zhangsan 或 name@example.com" onChange={(event) => setAuthIdentifier(event.target.value)} autoComplete="username" />
            </> : <>
              <label htmlFor="auth-display-name">显示名称</label>
              <input id="auth-display-name" autoFocus value={authDisplayName} placeholder="例如：张三" onChange={(event) => setAuthDisplayName(event.target.value)} autoComplete="name" />
              <label htmlFor="auth-handle">账号标识</label>
              <input id="auth-handle" value={authHandle} placeholder="例如：zhangsan" onChange={(event) => setAuthHandle(event.target.value.replace(/\s+/gu, '').toLowerCase())} autoComplete="username" />
              <label htmlFor="auth-email">邮箱 <span>可选</span></label>
              <input id="auth-email" type="email" value={authEmail} placeholder="name@example.com" onChange={(event) => setAuthEmail(event.target.value)} autoComplete="email" />
            </>}
            <label htmlFor="auth-password">密码</label>
            <input id="auth-password" type="password" value={authPassword} placeholder="至少 8 个字符" onChange={(event) => setAuthPassword(event.target.value)} autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} />
            {authMessage ? <small className="auth-message" role="alert">{authMessage}</small> : null}
            <button className="action-button primary auth-submit" type="submit" disabled={authBusy || (authMode === 'login' ? !authIdentifier.trim() || !authPassword : !authDisplayName.trim() || !authHandle.trim() || !authPassword)}>{authBusy ? (authMode === 'login' ? '登录中…' : '创建中…') : authMode === 'login' ? '登录' : '创建账户'}</button>
          </form>
          <small className="auth-footnote">账户、项目和邀请由服务端数据库管理。本机保存账号后可快速登录；凭据只写入此浏览器的本地存储。</small>
        </section>
      </main>
    );
  }
  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="route-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <div>
            <div className="brand-name">Riff</div>
            <div className="brand-subtitle">Make every draft better.</div>
          </div>
        </div>
        <div className="topbar-route" aria-hidden="true">
          <span className="route-dot active" />
          <span className="route-line" />
          <span className="route-dot" />
          <span className="route-line" />
          <span className="route-dot" />
        </div>
        <div className="topbar-project-nav">
          <span className="topbar-project-label">项目</span>
          <PopoverMenu
            open={openPopover === 'workspace'}
            onOpenChange={(open) => setOpenPopover(open ? 'workspace' : null)}
            ariaLabel="切换当前项目"
            heading="切换项目"
            description="项目是文档、成员和 Agent 的协作边界。"
            disabled={!workspaces.length && !canCreateWorkspace}
            options={workspaces.map((workspace) => ({
              id: workspace.id,
              label: workspace.title,
              description: `${workspace.documents.length} 份文档 · ${workspace.role}`,
              selected: workspace.id === workspaceId,
              onSelect: () => selectWorkspace(workspace.id),
            }))}
            actions={workspaceMenuActions}
            trigger={<span className="workspace-trigger-copy"><strong>{workspaces.find((workspace) => workspace.id === workspaceId)?.title ?? '还没有项目'}</strong><small>{workspaceId ? `${workspaceDetail?.documents.length ?? docs.length} 份文档` : '先创建一个项目'}</small></span>}
          />
        </div>
        {pendingInvitations.length ? (
          <button
            ref={invitationInboxTriggerRef}
            className="invitation-inbox-button"
            type="button"
            aria-haspopup="dialog"
            aria-expanded={showInviteMember && memberDialogMode === 'inbox'}
            onClick={() => { setMemberDialogMode('inbox'); setInviteMessage(''); setShowInviteMember((current) => !current); }}
          >
            待处理邀请 <span>{pendingInvitations.length}</span>
          </button>
        ) : null}
        <button className="topbar-provider-button" type="button" onClick={() => setShowModelProviders(true)}>模型</button>
        <PopoverMenu
          open={openPopover === 'account'}
          onOpenChange={(open) => setOpenPopover(open ? 'account' : null)}
          triggerRef={accountTriggerRef}
          ariaLabel="打开个人账户菜单"
          heading="个人账户"
          description={accountMessage || (savedAccounts.length ? `${currentPrincipal?.handle ? `@${currentPrincipal.handle} · ` : ''}本机已保存 ${savedAccounts.length} 个账号` : '管理你的个人资料和登录会话。')}
          options={savedAccounts.map((account) => ({
            id: `saved-${account.identifier}`,
            label: account.displayName,
            description: account.handle ? `@${account.handle} · 点击切换` : `${account.identifier} · 点击切换`,
            selected: account.principalId === currentPrincipal?.id || account.identifier.toLowerCase() === (currentPrincipal?.handle ?? '').toLowerCase(),
            onSelect: () => { void loginWithSavedAccount(account, true); },
          }))}
          hideEmptyOptions={!savedAccounts.length}
          actions={[
            { label: '模型提供商', onSelect: () => setShowModelProviders(true) },
            { label: '编辑个人资料', onSelect: () => { const current = principals.find((principal) => principal.id === principalId); setNewMemberDisplayName(current?.displayName ?? ''); setNewMemberHandle(current?.handle ?? ''); setAccountMessage(''); setShowAccountRegistration(true); } },
            { label: '清除本机保存记录', onSelect: () => clearSavedAccounts() },
            { label: '退出当前账号', onSelect: () => void logoutAccount() },
          ]}
          trigger={(() => {
            const current = principals.find((principal) => principal.id === principalId);
            const initials = current?.displayName.trim().slice(0, 1) || '我';
            return <span className="account-avatar-trigger" title={current?.displayName ?? '个人账户'}>{initials}</span>;
          })()}
        />
      </header>
      <section className="workbench">
        <aside className="sidebar" aria-label="项目文件、目录和成员">
          <div className="sidebar-project-context">
            <span className="eyebrow">当前项目</span>
            <strong>{workspaces.find((workspace) => workspace.id === workspaceId)?.title ?? '还没有项目'}</strong>
            <small>{workspaceId ? `${workspaceRole} · ${docs.length} 份文档` : '从顶部导航新建或切换项目'}</small>
            {workspaceId ? <div className="workspace-context-actions">
              {canSyncLocalProject ? <button className="workspace-sync-button" type="button" onClick={() => void syncWorkspaceWithLocal()} disabled={workspaceSyncing}>
                {workspaceSyncing ? '同步中…' : '同步'}
              </button> : null}
              <button ref={projectSettingsTriggerRef} className="workspace-settings-link" type="button" aria-haspopup="dialog" aria-expanded={showLocalProject} onClick={() => setShowLocalProject((current) => !current)}>
                {showLocalProject ? '关闭项目设置' : '项目设置'}
              </button>
            </div> : null}
            {workspaceMessage ? <small className="workspace-message">{workspaceMessage}</small> : null}
          </div>
          <div className="sidebar-section document-section">
            <div className="section-heading">
              <h2>文件</h2>
              <div className="section-heading-actions">
                <span className="section-count">{docs.length}</span>
                <button
                  ref={newDocumentTriggerRef}
                  className="new-document-button"
                  type="button"
                  aria-label="新建文档"
                  title="新建文档"
                  aria-haspopup="dialog"
                  aria-expanded={showNewDocument}
                  disabled={!workspaceId || !['editor', 'owner'].includes(workspaceRole)}
                  onClick={() => setShowNewDocument((current) => !current)}
                >+
                </button>
              </div>
            </div>
            <div className="file-tree" aria-label="项目文件树">
              {fileTree.length ? renderFileTree(fileTree) : <div className="empty-state compact">还没有可用文件</div>}
            </div>
          </div>
          <div className="sidebar-section outline-section">
            <div className="section-heading">
              <h2>文档大纲</h2>
              <span className="section-count">{outlineEntries.length}</span>
            </div>
            {outlineEntries.length ? (
              <nav className="outline-list" aria-label="文档大纲">
                {outlineEntries.map((entry) => (
                  <button className="outline-item" key={`${entry.index}-${entry.start}`} type="button" title={currentDocumentKind === 'markdown' && entry.level ? `定位到第 ${entry.level} 级标题` : `定位到第 ${entry.index + 1} 段`} style={entry.level ? { paddingLeft: `${8 + Math.max(0, entry.level - 1) * 12}px` } : undefined} onClick={() => {
                    const target = { start: entry.start, end: entry.end };
                    previewSelectionRef.current = currentDocumentKind === 'markdown' && editorViewMode === 'preview' ? target : null;
                    setOutlineTarget(target);
                    setSelectedRange(target);
                  }}>
                    <span>{String(entry.index).padStart(2, '0')}</span>
                    <strong>{entry.title}</strong>
                  </button>
                ))}
              </nav>
            ) : <div className="empty-state compact">{currentDocumentKind === 'markdown' ? '正文中还没有分级标题' : '正文中还没有可识别的段落'}</div>}
          </div>
          <div className="sidebar-footer">
            <div className="legend-row">
              <span className="legend-line cyan" />
              <span>实时同步</span>
            </div>
            <div className="legend-row">
              <span className="legend-line violet" />
              <span>线程内待处理</span>
            </div>
          </div>
        </aside>
        <section className="editor-panel" aria-label="文档编辑器">
          <div className="editor-panel-head">
            <div className="doc-heading">
              <span className="doc-file-mark" aria-hidden="true" />
              <div>
                <h1>{doc?.title ?? '选择一个文档'}</h1>
                <p>
                  {workspaceDetail?.title ?? '未归属项目'} · {localProject?.files.find((file) => file.documentId === doc?.id)?.relativePath ?? '项目文档'} · {editable ? '可直接编辑 · 变更会同步给所有协作者' : `只读模式 · 当前角色 ${role}`}
                </p>
              </div>
            </div>
            <div className="editor-head-meta">
              <span className={`sync-state ${connectionState}`}>
                <span className="presence-dot" />
                {connectionState === 'connected' ? '已连接' : connectionState === 'connecting' ? '连接中' : '连接断开'}
              </span>
              <span className="member-avatar-stack" aria-label={`${online.length} 位协作者在线`}>
                {online.slice(0, 4).map((id) => {
                  const person = principals.find((principal) => principal.id === id);
                  return (
                    <span className="mini-avatar" key={id} title={person?.displayName ?? id}>
                      {person?.kind === 'agent' ? 'AI' : person?.displayName?.[0] ?? '?'}
                    </span>
                  );
                })}
              </span>
            </div>
          </div>
          <div className="editor-toolbar">
            {currentDocumentKind === 'markdown' && editorViewMode === 'preview' ? (
              <span className="toolbar-context">在预览中选中文字后，使用选区浮窗开始协作</span>
            ) : (
              <div className="toolbar-actions">
                <span className="toolbar-context">选中文字后，在正文旁发起讨论；Agent 会在同一线程中回复或提出修改。</span>
              </div>
            )}
            <div className={`selection-status ${selectedRange ? 'has-selection' : ''}`}>
              <span className="selection-pip" aria-hidden="true" />
              {selectedRange ? (
                <>
                  已选中 <strong>{selectedRange.end - selectedRange.start}</strong> 个字符
                  <span className="selection-range">{selectedRange.start}–{selectedRange.end}</span>
                </>
              ) : (
                '拖动选择文字后开始协作'
              )}
            </div>
          </div>
          <div className="editor-stage">
            <CodeMirrorEditor
              value={text}
              editable={editable}
              documentKind={currentDocumentKind}
              outlineTarget={outlineTarget}
              onChange={updateText}
              onSelectionChange={(selection) => {
                setDocumentAction(null);
                previewSelectionRef.current = null;
                setSelectedRange(
                  selection.start < selection.end
                    ? { start: selection.start, end: selection.end }
                    : null,
                );
                socketRef.current?.send(
                  JSON.stringify({
                    type: 'awareness',
                    state: { from: selection.start, to: selection.end },
                  }),
                );
              }}
              onPreviewSelectionChange={(selection) => {
                setDocumentAction(null);
                if (selection && selection.start < selection.end) {
                  previewSelectionRef.current = selection;
                  setSelectedRange(selection);
                } else if (!preservePreviewSelectionRef.current) {
                  previewSelectionRef.current = null;
                  setSelectedRange(null);
                }
              }}
              onPreviewAction={() => {
                setTab('comments');
              }}
              reviewMarkers={reviewMarkers}
              onReviewMarkerClick={openReviewMarker}
              members={workspaceMembers}
              onInlineActionSubmit={(_action, body) => void createComment(body)}
              onViewModeChange={setEditorViewMode}
            />
          </div>
          <div className="editor-statusbar">
            <span className="status-route"><span className="status-node" />正文</span>
            <span>{text.length.toLocaleString()} 字符</span>
            <span className="status-divider" />
            <span>{editable ? '编辑权限已开启' : '可通过线程审批修改'}</span>
            <span className="status-spacer" />
            <span className="shortcut-hint">选择文本 · 评论</span>
          </div>
        </section>
        <aside className="inspector" aria-label="协作面板">
          <div className="inspector-head">
            <div>
              <h2>协作面板</h2>
              <p>围绕正文处理讨论与变更</p>
            </div>
            <span className="inspector-route" aria-hidden="true"><i /><i /><i /></span>
          </div>
          <nav className="panel-tabs" aria-label="协作面板导航">
            <button className={tab === 'members' ? 'selected' : ''} onClick={() => setTab('members')}>
              成员 <span>{workspaceMembers.length}</span>
            </button>
            <button className={tab === 'comments' ? 'selected' : ''} onClick={() => setTab('comments')}>
              评论 <span>{threads.length}</span>
            </button>
          </nav>
          <div className="inspector-body">
            {tab === 'members' ? (
              <>
                <div className="panel-intro">
                  <div><h3>项目成员</h3><p>查看在线状态、权限和 Agent 配置。</p></div>
                  <span className="panel-route-pin" aria-hidden="true" />
                </div>
                <div className="member-panel-summary">
                  <span>{online.length} 人在线</span>
                  {workspaceRole === 'owner' ? (
                    <button ref={inviteMemberTriggerRef} className="member-manage-button" type="button" aria-haspopup="dialog" aria-expanded={showInviteMember && memberDialogMode === 'manage'} onClick={() => { setMemberDialogMode('manage'); setInviteMessage(''); void refreshWorkspaceInvitations(); setShowInviteMember((current) => !current); }}>管理成员</button>
                  ) : null}
                </div>
                <div className="member-list inspector-member-list">
                  {workspaceMembers.length ? workspaceMembers.map((member) => (
                    <div className="member-row" key={member.id}>
                      <span className={member.kind === 'agent' ? 'avatar agent' : 'avatar'}>{member.kind === 'agent' ? 'AI' : member.displayName[0]}</span>
                      <span className="member-copy"><strong>{member.displayName}</strong><small>{member.kind === 'agent' ? `Agent · ${member.role}` : member.role}</small></span>
                      {member.kind === 'agent' && workspaceRole === 'owner' ? <button ref={agentConfigTriggerRef} className="member-config-button" type="button" aria-label={`编辑 ${member.displayName} 的 Agent 配置`} onClick={() => openAgentConfiguration(member.id)}>配置</button> : null}
                      <span className={`member-presence ${online.includes(member.id) ? 'online' : ''}`} aria-label={online.includes(member.id) ? '在线' : '离线'} />
                    </div>
                  )) : <div className="empty-state compact">连接文档后显示成员</div>}
                </div>
              </>
            ) : tab === 'comments' ? (
              <>
                <div className="panel-intro">
                  <div>
                    <h3>{activeThread ? '回复线程' : '发起讨论'}</h3>
                    <p>{activeThread ? '继续补充上下文，让协作者知道下一步。' : '选中文字后，评论会自动关联对应范围；@成员或 Agent 可以继续讨论和处理。'}</p>
                  </div>
                  <span className="panel-route-pin" aria-hidden="true" />
                </div>
                {activeAgentStatusUpdate && activeAgentFeedback && activeAgentStatusUpdate.state !== 'idle' ? (
                  <div className={`agent-feedback ${activeAgentStatusUpdate.state}`} role="status">
                    <span className="agent-feedback-mark" aria-hidden="true" />
                    <div><strong>{activeAgentFeedback.label}</strong><small>{activeAgentFeedback.detail}</small></div>
                  </div>
                ) : null}
                {selectedRange && !activeThread && documentAction === null ? (
                  <div className="selection-note">
                    <span className="selection-pip" />评论将关联当前选区 · {selectedRange.end - selectedRange.start} 个字符
                  </div>
                ) : null}
                {activeThread || documentAction === 'comment' ? <div className="composer">
                  <textarea
                    ref={commentInputRef}
                    className="composer-input"
                    placeholder={activeThread ? '回复当前线程，可 @成员' : '写下整篇文档评论，可 @成员'}
                    value={comment}
                    onFocus={() => {
                      preservePreviewSelectionRef.current = true;
                      if (previewSelectionRef.current) setSelectedRange(previewSelectionRef.current);
                    }}
                    onChange={(event) => handleCommentChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
                    onKeyDown={handleCommentKeyDown}
                    onBlur={() => {
                      preservePreviewSelectionRef.current = false;
                      window.setTimeout(() => { if (document.activeElement !== commentInputRef.current) setMentionState(null); }, 0);
                    }}
                  />
                  {mentionCandidates.length > 0 ? (
                    <div className="mention-menu" role="listbox" aria-label="选择要提及的成员">
                      {mentionCandidates.map((member, index) => (
                        <button
                          key={member.id}
                          className={`mention-option ${index === mentionState?.index ? 'selected' : ''}`}
                          type="button"
                          role="option"
                          aria-selected={index === mentionState?.index}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => insertMention(member)}
                        >
                          <span className="avatar">{member.displayName.slice(0, 1)}</span>
                          <span className="mention-option-copy">
                            <strong>{member.displayName}</strong>
                            <small>{member.kind === 'agent' ? 'Agent' : member.handle ? `@${member.handle}` : '成员'}</small>
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <div className="composer-footer">
                    {!activeThread ? (
                      <label className="task-toggle">
                        <input
                          type="checkbox"
                          checked={asTask}
                          onChange={(event) => setAsTask(event.target.checked)}
                        />
                        <span className="checkbox-ui" />
                        作为任务交给 Agent
                      </label>
                    ) : (
                      <button className="subtle-button" onClick={() => setActiveThreadId(null)}>返回新评论</button>
                    )}
                    <button className="action-button primary send-button" onClick={activeThread ? sendMessage : () => void createComment()} disabled={!comment.trim()}>
                      {activeThread ? '回复' : '发布评论'}<span className="send-arrow" aria-hidden="true">↗</span>
                    </button>
                  </div>
                </div> : (
                  <div className="document-action-card">
                    <strong>从正文开始协作</strong>
                    <p>选中文字后会在原文旁出现操作浮窗。没有选区时，可以从这里发起整篇文档的讨论。</p>
                    <div className="document-action-buttons">
                      <button className="subtle-button" type="button" disabled={!['commenter', 'suggester', 'editor', 'owner'].includes(role)} onClick={openDocumentAction}>评论整篇文档</button>
                    </div>
                  </div>
                )}
                {!activeThread && documentAction === 'comment' && asTask ? (
                  <select className="agent-select" value={assignedAgentId} onChange={(event) => setAssignedAgentId(event.target.value)}>
                    <option value="">选择负责的 Agent</option>
                    {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.displayName}</option>)}
                  </select>
                ) : null}
                <div className="panel-list-heading"><span>{activeRangeThread ? '当前段落与全局讨论' : '全局讨论'}</span><span>{globalThreads.length} 个全局线程 · 待审 {pendingSuggestionCount}</span></div>
                <div className="thread-list">
                  {visibleThreads.length ? visibleThreads.map((thread) => (
                    <div className={`thread-row ${thread.id === activeThreadId ? 'active' : ''}`} key={thread.id} onClick={() => setActiveThreadId(thread.id)}>
                      <div className="thread-row-head">
                        <span className={`state-chip ${thread.status}`}>{thread.status === 'open' ? '进行中' : '已解决'}</span>
                        <span className="thread-type">{thread.kind === 'task' ? '任务' : '讨论'}</span>
                        {thread.scope.type === 'range' ? <span className="thread-anchor">范围评论</span> : null}
                      </div>
                      {thread.messages.slice(0, 2).map((message) => (
                        <p key={message.id}>
                          <b>{workspaceMembers.find((member) => member.id === message.authorId)?.displayName ?? message.authorId}</b>
                          {message.status === 'withdrawn' ? <span className="withdrawn-copy">已撤回</span> : <span>{message.body}</span>}
                          {message.authorId === principalId && message.status !== 'withdrawn' ? <button className="inline-withdraw-button" type="button" onClick={(event) => { event.stopPropagation(); void withdrawMessage(message.id); }}>撤回</button> : null}
                        </p>
                      ))}
                      {thread.messages.length > 2 ? <small className="thread-more">还有 {thread.messages.length - 2} 条回复</small> : null}
                      {suggestions.filter((suggestion) => suggestion.threadId === thread.id).map((suggestion) => renderSuggestionCard(suggestion))}
                    </div>
                  )) : <div className="empty-state"><span className="empty-route" aria-hidden="true" />还没有全局讨论<br /><small>从正文中选一段文字开始，讨论会显示在对应段落标记中。</small></div>}
                </div>
                {suggestionMessage ? <small className="suggestion-message" role="status">{suggestionMessage}</small> : null}
                {unthreadedSuggestions.length ? (
                  <div className="legacy-suggestion-group">
                    <div className="panel-list-heading"><span>历史修改记录</span><span>{unthreadedSuggestions.length} 条</span></div>
                    <p className="panel-help">这些记录来自旧版独立建议入口，后续新的 Agent 修改都会自动归入对应讨论线程。</p>
                    <div className="suggestion-list">{unthreadedSuggestions.map((suggestion) => renderSuggestionCard(suggestion, true))}</div>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </aside>
      </section>
      <Modal
        open={showNewWorkspace}
        title="新建项目"
        description="选择一个本地文件夹，项目会立即与它建立连接。"
        onClose={() => { setShowNewWorkspace(false); resetNewWorkspaceDraft(); }}
        returnFocusRef={newWorkspaceTriggerRef}
      >
        <form className="modal-form" onSubmit={(event) => void createWorkspace(event)}>
          <label htmlFor="new-workspace-title">项目名称</label>
          <input
            id="new-workspace-title"
            autoFocus
            value={newWorkspaceTitle}
            placeholder="例如：产品说明书"
            onChange={(event) => setNewWorkspaceTitle(event.target.value)}
          />
          <div className="project-folder-picker">
            <div className="project-folder-row">
              <div className="folder-input-control">
                <input
                  id="new-project-folder-input"
                  ref={newProjectFolderInputRef}
                  className="folder-input-native"
                  type="file"
                  multiple
                  accept=".txt,.md,text/plain,text/markdown"
                  aria-label="选择项目文件夹"
                  disabled={newProjectBusy}
                  onClick={(event) => {
                    if (newProjectBusy) {
                      event.preventDefault();
                      return;
                    }
                    if ((window as DirectoryPickerWindow).showDirectoryPicker) {
                      event.preventDefault();
                      void chooseNewProjectFolder();
                    }
                  }}
                  onChange={(event) => void handleNewProjectFolderInput(event)}
                />
                <span className={`action-button folder-input-trigger ${newProjectBusy ? 'disabled' : ''}`} aria-hidden="true">选择本地文件夹</span>
              </div>
              <span>{newProjectFolderName || '尚未选择文件夹'}</span>
            </div>
            <label htmlFor="new-project-path">服务端目录路径 <span>可选</span></label>
            <input id="new-project-path" value={newProjectPath} placeholder="D:\\Projects\\my-docs" onChange={(event) => setNewProjectPath(event.target.value)} />
            <small>选择文件夹会扫描 TXT / Markdown，并在本地与项目之间同步。若服务端无法读取浏览器选择的目录，可填写本机绝对路径。</small>
          </div>
          {workspaceMessage && showNewWorkspace ? <small className="modal-message">{workspaceMessage}</small> : null}
          <div className="modal-actions">
            <button className="subtle-button" type="button" onClick={() => { setShowNewWorkspace(false); resetNewWorkspaceDraft(); }}>取消</button>
            <button className="action-button primary" type="submit" disabled={newProjectBusy || !newWorkspaceTitle.trim()}>{newProjectBusy ? '创建中…' : '创建并打开'}</button>
          </div>
        </form>
      </Modal>
      <Modal
        open={showNewDocument}
        title="新建文档"
        description="在当前项目中创建一个 TXT 或 Markdown 文档。"
        onClose={() => { setShowNewDocument(false); setNewDocumentTitle(''); setNewDocumentText(''); }}
        returnFocusRef={newDocumentTriggerRef}
      >
        <form className="modal-form" onSubmit={(event) => void createDocument(event)}>
          <label htmlFor="new-document-title">文档名称</label>
          <input
            id="new-document-title"
            autoFocus
            value={newDocumentTitle}
            placeholder="例如：会议纪要.md 或会议纪要.txt"
            onChange={(event) => setNewDocumentTitle(event.target.value)}
          />
          <label htmlFor="new-document-text">初始正文 <span>可选</span></label>
          <textarea
            id="new-document-text"
            value={newDocumentText}
            placeholder="先写一段正文（可选）"
            onChange={(event) => setNewDocumentText(event.target.value)}
          />
          <div className="modal-actions">
            <button className="subtle-button" type="button" onClick={() => { setShowNewDocument(false); setNewDocumentTitle(''); setNewDocumentText(''); }}>取消</button>
            <button className="action-button primary" type="submit" disabled={!newDocumentTitle.trim()}>创建文档</button>
          </div>
        </form>
      </Modal>
      <Modal
        open={showRenameWorkspace}
        title="重命名项目"
        description="项目名称会同步显示给所有成员。"
        onClose={() => { setShowRenameWorkspace(false); setRenameWorkspaceTitle(''); setWorkspaceActionMessage(''); }}
      >
        <form className="modal-form" onSubmit={(event) => void renameWorkspace(event)}>
          <label htmlFor="rename-workspace-title">项目名称</label>
          <input id="rename-workspace-title" autoFocus value={renameWorkspaceTitle} onChange={(event) => setRenameWorkspaceTitle(event.target.value)} />
          {workspaceActionMessage ? <small className="modal-message" role="alert">{workspaceActionMessage}</small> : null}
          <div className="modal-actions">
            <button className="subtle-button" type="button" onClick={() => setShowRenameWorkspace(false)}>取消</button>
            <button className="action-button primary" type="submit" disabled={!renameWorkspaceTitle.trim()}>保存名称</button>
          </div>
        </form>
      </Modal>
      <Modal
        open={showDeleteWorkspace}
        title="删除项目"
        description="这会删除项目中的文档、成员关系、邀请和协作记录，无法撤销。"
        onClose={() => { setShowDeleteWorkspace(false); setDeleteWorkspaceConfirmation(''); setWorkspaceActionMessage(''); }}
      >
        <form className="modal-form" onSubmit={(event) => void deleteWorkspace(event)}>
          <p className="modal-warning">请输入项目名称 <strong>{workspaces.find((workspace) => workspace.id === workspaceId)?.title ?? ''}</strong> 以确认删除。</p>
          <label htmlFor="delete-workspace-confirmation">确认项目名称</label>
          <input id="delete-workspace-confirmation" autoFocus value={deleteWorkspaceConfirmation} onChange={(event) => setDeleteWorkspaceConfirmation(event.target.value)} />
          {workspaceActionMessage ? <small className="modal-message" role="alert">{workspaceActionMessage}</small> : null}
          <div className="modal-actions">
            <button className="subtle-button" type="button" onClick={() => setShowDeleteWorkspace(false)}>取消</button>
            <button className="action-button danger" type="submit" disabled={deleteWorkspaceConfirmation !== (workspaces.find((workspace) => workspace.id === workspaceId)?.title ?? '')}>删除项目</button>
          </div>
        </form>
      </Modal>
      <Modal
        open={showAccountRegistration}
        title="编辑个人资料"
        description="更新当前账户的显示名称和账号标识。"
        onClose={() => { setShowAccountRegistration(false); setNewMemberDisplayName(''); setNewMemberHandle(''); setAccountMessage(''); }}
        returnFocusRef={accountTriggerRef}
      >
        <form className="modal-form" onSubmit={(event) => void registerAccount(event)}>
          <label htmlFor="account-display-name">显示名称</label>
          <input id="account-display-name" autoFocus value={newMemberDisplayName} placeholder="例如：张三" onChange={(event) => setNewMemberDisplayName(event.target.value)} />
          <label htmlFor="account-handle">账号标识</label>
          <input id="account-handle" value={newMemberHandle} placeholder="例如：zhangsan" onChange={(event) => setNewMemberHandle(event.target.value.replace(/\s+/gu, '').toLowerCase())} />
          <small className="modal-note">账号标识用于项目邀请和成员搜索。它不会改变当前登录会话。</small>
          {accountMessage ? <small className="modal-message">{accountMessage}</small> : null}
          <div className="modal-actions">
            <button className="subtle-button" type="button" onClick={() => setShowAccountRegistration(false)}>取消</button>
            <button className="action-button primary" type="submit" disabled={accountBusy || !newMemberDisplayName.trim() || !newMemberHandle.trim()}>{accountBusy ? '保存中…' : '保存资料'}</button>
          </div>
        </form>
      </Modal>
      <Modal
        open={showModelProviders}
        title="模型提供商"
        description="统一管理模型连接，再把已连接的提供商绑定给具体 Agent。"
        variant="drawer"
        onClose={() => setShowModelProviders(false)}
      >
        <ModelProvidersPanel onChanged={() => { if (doc) void request<Agent[]>(`/api/docs/${doc.id}/agents`, { headers }).then((value) => { if (value) setAgents(value); }); }} />
      </Modal>
      <Modal
        open={showAgentConfig}
        title={agentConfigFocusId ? `${agents.find((agent) => agent.id === agentConfigFocusId)?.displayName ?? 'Agent'} · 配置` : 'Agent 成员'}
        description={agentConfigFocusId ? '在项目成员中管理这个 Agent 的连接方式、权限和上下文。' : '把 Agent 当作项目成员管理；配置会作用于当前文档。'}
        variant="drawer"
        onClose={() => { setShowAgentConfig(false); setAgentConfigFocusId(null); }}
        returnFocusRef={agentConfigTriggerRef}
      >
        <AgentConfigPanel
          docId={doc?.id ?? ''}
          agents={agentConfigFocusId ? agents.filter((agent) => agent.id === agentConfigFocusId) : agents}
          owner={role === 'owner'}
          allowCreate={!agentConfigFocusId}
          onOpenProviders={() => setShowModelProviders(true)}
          onUpdated={() => {
            void Promise.all([
              refreshWorkspace(),
              doc ? request<Agent[]>(`/api/docs/${doc.id}/agents`, { headers }) : Promise.resolve(null),
            ]).then(([, value]) => {
              if (value) setAgents(value);
            });
          }}
        />
        {!agents.length ? <div className="empty-state compact"><span className="empty-route orange" aria-hidden="true" />还没有 Agent<br /><small>在这里注册第一个项目 Agent。</small></div> : null}
      </Modal>
      <Modal
        open={showInviteMember}
        title={memberDialogMode === 'inbox' ? '待处理邀请' : memberDialogMode === 'invite' ? '邀请成员' : '项目成员'}
        description={memberDialogMode === 'inbox' ? '这是当前身份收到的项目邀请。接受后才会加入对应项目。' : memberDialogMode === 'invite' ? '输入对方的账号标识，发送后由对方决定是否加入项目。' : '查看当前成员、调整项目权限，或进入 Agent 配置。'}
        onClose={() => { setShowInviteMember(false); setInviteIdentifier(''); setAccountMatches([]); setInviteMessage(''); }}
        returnFocusRef={memberDialogMode === 'inbox' ? invitationInboxTriggerRef : inviteMemberTriggerRef}
      >
        {memberDialogMode === 'inbox' ? (
          <div className="member-inbox">
            {pendingInvitations.length ? pendingInvitations.map((invitation) => (
              <article className="invitation-card" key={invitation.id}>
                <div className="invitation-card-copy">
                  <strong>{invitation.workspace?.title ?? invitation.workspaceTitle ?? '未命名项目'}</strong>
                  <span>{invitation.inviter?.displayName ?? invitation.inviterName ?? invitation.inviterId ?? invitation.invitedBy ?? '项目成员'} 邀请你加入 · {invitation.role}</span>
                </div>
                <div className="row-actions">
                  <button className="subtle-button" type="button" onClick={() => void respondToInvitation(invitation, 'reject')} disabled={memberBusy}>拒绝</button>
                  <button className="action-button primary" type="button" onClick={() => void respondToInvitation(invitation, 'accept')} disabled={memberBusy}>接受</button>
                </div>
              </article>
            )) : <div className="empty-state compact">暂时没有待处理邀请</div>}
            {inviteMessage ? <small className="modal-message">{inviteMessage}</small> : null}
          </div>
        ) : memberDialogMode === 'invite' ? (
          <form className="modal-form" onSubmit={(event) => void inviteMember(event)}>
                <div className="invite-flow-note"><span className="invite-flow-step">1</span><div><strong>找到账号</strong><small>输入对方的账号标识或显示名称，系统会从数据库查找。</small></div></div>
                <label htmlFor="invite-identifier">账号标识</label>
                <div className="account-lookup-field">
                  <input id="invite-identifier" value={inviteIdentifier} placeholder="例如：@zhangsan 或 张三" onChange={(event) => { const value = event.target.value; setInviteIdentifier(value); void searchAccountMatches(value); }} />
                  {accountMatches.length ? <div className="account-match-list" role="listbox" aria-label="账号搜索结果">
                    {accountMatches.map((candidate) => <button key={candidate.id} className="account-match" type="button" onClick={() => { setInviteIdentifier(candidate.handle ? `@${candidate.handle}` : candidate.displayName); setAccountMatches([]); }}><span className="avatar">{candidate.displayName[0]}</span><span><strong>{candidate.displayName}</strong><small>{candidate.handle ? `@${candidate.handle}` : '数据库账户'}</small></span></button>)}
                  </div> : null}
                </div>
                <small className="field-hint">邀请只会发给这个账号，不会直接把对方加入项目。</small>
                <label htmlFor="invite-role">项目权限</label>
                <select id="invite-role" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as CollaboratorRole)}>
                  {collaboratorRoleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                {inviteMessage ? <small className="modal-message">{inviteMessage}</small> : null}
                <div className="modal-actions">
                  <button className="subtle-button" type="button" onClick={() => { setMemberDialogMode('manage'); setInviteIdentifier(''); setAccountMatches([]); setInviteMessage(''); }}>返回成员</button>
                  <button className="action-button primary" type="submit" disabled={memberBusy || !inviteIdentifier.trim()}>{memberBusy ? '发送中…' : '发送邀请'}</button>
                </div>
          </form>
        ) : (
          <div className="member-manage-view">
            <div className="member-view-toolbar">
              <div><strong>当前成员</strong><small>{workspaceMembers.length} 人 · 权限变更会立即生效</small></div>
              <div className="member-view-actions">
                <button className="subtle-button" type="button" onClick={() => { setMemberDialogMode('invite'); setInviteMessage(''); }}>邀请成员</button>
                {workspaceRole === 'owner' ? <button className="subtle-button" type="button" onClick={() => { setShowInviteMember(false); openAgentConfiguration(); }}>添加 Agent</button> : null}
              </div>
            </div>
            {workspaceRole === 'owner' && workspaceInvitations.filter((invitation) => invitation.status === 'pending').length ? (
              <div className="pending-invitation-summary"><strong>待对方接受</strong>{workspaceInvitations.filter((invitation) => invitation.status === 'pending').map((invitation) => <span key={invitation.id}>{invitation.invitee?.displayName ?? invitation.principalName ?? invitation.principalId} · {invitation.role}</span>)}</div>
            ) : null}
            <div className="member-manage-list">
              {workspaceMembers.map((member) => (
                <div className="member-manage-row" key={member.id}>
                  <div className="member-manage-copy"><strong>{member.displayName}</strong><small>{member.id === principalId ? '当前身份' : member.kind === 'agent' ? 'Agent' : '人类'}{member.kind === 'human' && member.handle ? ` · @${member.handle}` : ''}</small></div>
                  {member.role === 'owner' ? <span className="member-owner-label">所有者</span> : (
                    <>
                      <select aria-label={`${member.displayName} 的权限`} value={member.role ?? 'viewer'} onChange={(event) => void updateMemberRole(member, event.target.value as CollaboratorRole)} disabled={memberBusy}>
                        {collaboratorRoleOptions.map((option) => <option key={option.value} value={option.value}>{option.label.split(' · ')[0]}</option>)}
                      </select>
                      {member.kind === 'agent' && workspaceRole === 'owner' ? <button className="subtle-button" type="button" onClick={() => { setShowInviteMember(false); openAgentConfiguration(member.id); }}>配置</button> : null}
                      <button className="subtle-button danger" type="button" onClick={() => void removeMember(member)} disabled={memberBusy || member.id === principalId}>移除</button>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>
      <Modal
        open={showLocalProject}
        title="项目设置"
        description="管理项目名称和本地连接状态。"
        variant="drawer"
        onClose={() => setShowLocalProject(false)}
        returnFocusRef={projectSettingsTriggerRef}
      >
        <div className="project-metadata-section">
          <div className="project-metadata-heading">
            <div>
              <span className="eyebrow">当前项目</span>
              <strong>{workspaceDetail?.title ?? workspaces.find((workspace) => workspace.id === workspaceId)?.title ?? '当前项目'}</strong>
              <small>项目名称和本地连接状态分别显示。</small>
            </div>
            {workspaceRole === 'owner' ? <div className="project-settings-actions">
              <button className="subtle-button" type="button" onClick={openRenameWorkspace}>重命名</button>
              <button className="subtle-button danger" type="button" onClick={() => { setDeleteWorkspaceConfirmation(''); setWorkspaceActionMessage(''); setShowDeleteWorkspace(true); }}>删除项目</button>
            </div> : null}
          </div>
        </div>
        <div className="project-connection-summary">
          <div>
            <span className="eyebrow">本地连接</span>
            <strong>{localProject ? (localProjectFolderName || (localProject.path ? '服务端目录' : localProject.source === 'imported' ? '浏览器导入' : '项目存储')) : '尚未连接'}</strong>
            <small>{localProject ? `${localProject.files.length} 个 TXT / Markdown 文档 · 使用侧栏“同步”保持一致` : '新建项目时选择本地文件夹即可建立连接。'}</small>
          </div>
          <span className={`source-chip ${localProject ? 'active' : ''}`}>{localProject ? '已连接' : '未连接'}</span>
        </div>
      </Modal>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
