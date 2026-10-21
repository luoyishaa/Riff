import type { DocumentSummaryDto } from '@collab/protocol';

export interface FileTreeNode {
  name: string;
  path: string;
  children: FileTreeNode[];
  document?: DocumentSummaryDto;
}

/** Folders first, then files, each alphabetical; paths come from the local project mapping. */
export function buildFileTree(documents: DocumentSummaryDto[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  for (const document of documents) {
    const segments = (document.relativePath ?? document.title).split('/').filter(Boolean);
    let level = root;
    let path = '';
    segments.forEach((segment, index) => {
      path = path ? `${path}/${segment}` : segment;
      const isFile = index === segments.length - 1;
      let node = level.find((candidate) => candidate.name === segment && (candidate.document !== undefined) === isFile);
      if (!node) {
        node = { name: segment, path, children: [] };
        level.push(node);
      }
      if (isFile) node.document = document;
      level = node.children;
    });
  }
  const sort = (nodes: FileTreeNode[]): FileTreeNode[] => {
    nodes.sort((left, right) => Number(left.document !== undefined) - Number(right.document !== undefined) || left.name.localeCompare(right.name, 'zh-CN'));
    nodes.forEach((node) => sort(node.children));
    return nodes;
  };
  return sort(root);
}
