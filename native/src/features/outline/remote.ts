import type { BackendBlock, BackendDocument } from '../../lib/backend';
import type { OutlineNode, OutlinePage } from './types';

function todayDateKey() {
  return new Date().toISOString().slice(0, 10);
}

export function documentToOutlinePage(document: BackendDocument): OutlinePage {
  const clientKeyByBackendId = new Map<number, string>();
  const sortedBlocks = [...document.blocks].sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id);

  for (const block of sortedBlocks) {
    clientKeyByBackendId.set(block.id, block.clientKey || `block-${block.id}`);
  }

  const nodes: OutlineNode[] = sortedBlocks.map((block) => ({
    id: block.clientKey || `block-${block.id}`,
    backendId: block.id,
    parentId: block.parentClientKey || (block.parentBlockId ? clientKeyByBackendId.get(block.parentBlockId) ?? `block-${block.parentBlockId}` : null),
    text: block.text,
    status: block.status,
    todoId: block.todoId || null,
    createdAt: block.createdAt,
    updatedAt: block.updatedAt,
  }));

  const date = document.kind === 'journal'
    ? document.journalDate || todayDateKey()
    : (document.createdAt || todayDateKey()).slice(0, 10);

  return {
    id: document.clientKey || `document-${document.id}`,
    backendId: document.id,
    workspaceId: document.workspaceId,
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
    clientKey: page.id,
    workspaceId: page.workspaceId ?? workspaceId,
    kind: page.kind,
    title: page.kind === 'journal' ? (page.title || page.date) : page.title,
    journalDate: page.kind === 'journal' ? page.date : '',
    createdAt: page.createdAt ?? '',
    updatedAt: page.updatedAt ?? '',
    blocks: page.nodes.map<BackendBlock>((node, index) => {
      const parent = node.parentId ? nodeById.get(node.parentId) ?? null : null;
      return {
        id: node.backendId ?? 0,
        clientKey: node.id,
        documentId: page.backendId ?? 0,
        parentBlockId: parent?.backendId ?? 0,
        parentClientKey: parent?.id ?? '',
        sortOrder: index + 1,
        text: node.text,
        status: node.status,
        todoId: node.todoId ?? 0,
        createdAt: node.createdAt ?? '',
        updatedAt: node.updatedAt ?? '',
      };
    }),
  };
}
