import type { BackendBlock, BackendDocument } from '../../lib/backend';
import { getDateKey } from './sampleData';
import type { OutlineNode, OutlinePage } from './types';

function todayDateKey() {
  return getDateKey(new Date());
}

export function documentToOutlinePage(document: BackendDocument): OutlinePage {
  const sortedBlocks = [...document.blocks].sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id);

  const nodes: OutlineNode[] = sortedBlocks.map((block) => ({
    id: `block-${block.id}`,
    backendId: block.id,
    parentId: block.parentBlockId ? `block-${block.parentBlockId}` : null,
    text: block.text,
    todoStatus: block.todoStatus || null,
    todoId: block.todoId || null,
    createdAt: block.createdAt,
    updatedAt: block.updatedAt,
  }));

  const date = document.kind === 'journal'
    ? document.journalDate || todayDateKey()
    : (document.createdAt || todayDateKey()).slice(0, 10);

  return {
    id: `document-${document.id}`,
    backendId: document.id,
    workspaceId: document.workspaceId,
    directoryId: document.directoryId || null,
    kind: document.kind,
    date,
    title: document.title,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    nodes,
  };
}

export function outlinePageToDocument(page: OutlinePage, workspaceId: number): BackendDocument {
  const nodeById = new Map(page.nodes.map((node) => [node.id, node]));

  return {
    id: page.backendId ?? 0,
    clientKey: page.backendId ? '' : page.id,
    workspaceId: page.workspaceId ?? workspaceId,
    directoryId: page.kind === 'note' ? (page.directoryId ?? 0) : 0,
    kind: page.kind,
    title: page.kind === 'journal' ? (page.title || page.date) : page.title,
    journalDate: page.kind === 'journal' ? page.date : '',
    createdAt: page.createdAt ?? '',
    updatedAt: page.updatedAt ?? '',
    blocks: page.nodes.map<BackendBlock>((node, index) => {
      const parent = node.parentId ? nodeById.get(node.parentId) ?? null : null;
      return {
        id: node.backendId ?? 0,
        clientKey: node.backendId ? '' : node.id,
        documentId: page.backendId ?? 0,
        parentBlockId: parent?.backendId ?? 0,
        parentClientKey: parent && !parent.backendId ? parent.id : '',
        sortOrder: index + 1,
        text: node.text,
        ...(node.todoStatus ? { todoStatus: node.todoStatus } : {}),
        todoId: node.todoId ?? 0,
        createdAt: node.createdAt ?? '',
        updatedAt: node.updatedAt ?? '',
      };
    }),
  };
}
