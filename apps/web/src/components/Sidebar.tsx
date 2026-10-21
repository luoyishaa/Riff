import { useMemo, useState } from 'react';
import type { DocumentSummaryDto, OutlineEntryDto, WorkspaceDetailDto } from '@collab/protocol';
import { buildFileTree, type FileTreeNode } from '../lib/fileTree.js';
import { can, ROLE_LABEL } from '../lib/permissions.js';
import { Icon } from './Icon.js';

export interface SidebarProps {
  workspace: WorkspaceDetailDto | undefined;
  documentId: string | undefined;
  outline: OutlineEntryDto[];
  outlineKind: 'text' | 'markdown';
  syncing: boolean;
  canSync: boolean;
  onOpenDocument: (document: DocumentSummaryDto) => void;
  onNewDocument: () => void;
  onDeleteDocument: (document: DocumentSummaryDto) => void;
  onOpenOutline: (entry: OutlineEntryDto) => void;
  onSync: () => void;
  onOpenSettings: () => void;
  onOpenMembers: () => void;
}

const SOURCE_LABEL = { managed: '项目存储', local: '本地文件夹', imported: '浏览器导入' } as const;

export function Sidebar(props: SidebarProps): React.ReactElement {
  const { workspace } = props;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildFileTree(workspace?.documents ?? []), [workspace?.documents]);
  const canEdit = can(workspace?.role, 'edit');
  const toggle = (path: string): void => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

  const renderNodes = (nodes: FileTreeNode[], depth: number): React.ReactNode => nodes.map((node) => {
    const indent = { paddingLeft: `${12 + depth * 14}px` };
    if (!node.document) {
      const open = !collapsed.has(node.path);
      return (
        <li key={node.path}>
          <button type="button" className="tree-row tree-folder" style={indent} aria-expanded={open} onClick={() => toggle(node.path)}>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
            <Icon name="folder" size={14} />
            <span className="tree-label">{node.name}</span>
          </button>
          {open ? <ul className="tree-children">{renderNodes(node.children, depth + 1)}</ul> : null}
        </li>
      );
    }
    const document = node.document;
    const selected = document.id === props.documentId;
    return (
      <li key={node.path} className="tree-file-item">
        <button type="button" className={`tree-row tree-file${selected ? ' is-selected' : ''}`} style={indent} aria-current={selected ? 'page' : undefined} onClick={() => props.onOpenDocument(document)} title={node.path}>
          <Icon name={document.kind === 'markdown' ? 'code' : 'file'} size={14} />
          <span className="tree-label">{node.name}</span>
        </button>
        {canEdit ? <button type="button" className="icon-button tree-action" aria-label={`删除 ${node.name}`} title="删除文件" onClick={() => props.onDeleteDocument(document)}><Icon name="trash" size={14} /></button> : null}
      </li>
    );
  });

  return (
    <aside className="sidebar" aria-label="项目导航">
      {workspace ? (
        <div className="sidebar-project">
          <div className="sidebar-project-title">
            <strong title={workspace.title}>{workspace.title}</strong>
            <span>{ROLE_LABEL[workspace.role]} · {SOURCE_LABEL[workspace.source]}</span>
          </div>
          <div className="sidebar-project-actions">
            <button type="button" className="icon-button" onClick={props.onOpenMembers} aria-label="项目成员" title="项目成员"><Icon name="users" /></button>
            {props.canSync ? <button type="button" className={`icon-button${props.syncing ? ' is-busy' : ''}`} onClick={props.onSync} disabled={props.syncing} aria-label="与本地文件夹同步" title="与本地文件夹同步"><Icon name="sync" /></button> : null}
            <button type="button" className="icon-button" onClick={props.onOpenSettings} aria-label="项目设置" title="项目设置"><Icon name="settings" /></button>
          </div>
        </div>
      ) : null}

      <section className="sidebar-section" aria-labelledby="files-heading">
        <div className="sidebar-heading">
          <h2 id="files-heading">文件</h2>
          {canEdit ? <button type="button" className="icon-button" onClick={props.onNewDocument} aria-label="新建文档" title="新建文档"><Icon name="plus" /></button> : null}
        </div>
        {tree.length ? <ul className="tree">{renderNodes(tree, 0)}</ul> : <p className="sidebar-empty">{workspace ? '这个项目还没有文档。' : '选择或新建一个项目。'}</p>}
      </section>

      <section className="sidebar-section sidebar-outline" aria-labelledby="outline-heading">
        <div className="sidebar-heading"><h2 id="outline-heading">大纲</h2></div>
        {props.outline.length ? (
          <ol className="outline">
            {props.outline.map((entry) => (
              <li key={`${entry.index}-${entry.start}`}>
                <button type="button" className="outline-row" style={{ paddingLeft: `${12 + Math.max(0, (entry.level ?? 1) - 1) * 12}px` }} onClick={() => props.onOpenOutline(entry)} title={entry.title}>
                  {entry.title}
                </button>
              </li>
            ))}
          </ol>
        ) : <p className="sidebar-empty">{props.outlineKind === 'markdown' ? '用 # 标题组织文档后会显示在这里。' : '正文分段后会显示在这里。'}</p>}
      </section>
    </aside>
  );
}
