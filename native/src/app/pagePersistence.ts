import { getPageTitle } from '../features/outline/tree';
import type { OutlinePage } from '../features/outline/types';

type InvalidBlockTreeInfo = {
  nodeId: string;
  parentId: string;
  backendId: number | null;
  parentBackendId: number | null;
  index: number;
  parentIndex: number;
  text: string;
  nearbyNodes: {
    index: number;
    id: string;
    backendId: number | null;
    parentId: string | null;
    parentBackendId: number | null;
    text: string;
  }[];
};

export function pageHash(page: OutlinePage) {
  return JSON.stringify({
    id: page.id,
    backendId: page.backendId ?? 0,
    workspaceId: page.workspaceId ?? 0,
    directoryId: page.directoryId ?? 0,
    kind: page.kind,
    date: page.date,
    title: page.title,
    nodes: page.nodes.map((node) => ({
      id: node.id,
      backendId: node.backendId ?? 0,
      parentId: node.parentId,
      text: node.text,
      todoStatus: node.todoStatus ?? '',
      todoId: node.todoId ?? 0,
    })),
  });
}

export function pagePersistenceKey(page: OutlinePage) {
  if (page.backendId) {
    return `document:${page.backendId}`;
  }
  if (page.kind === 'journal') {
    return `journal:${page.date}`;
  }
  return `local:${page.id}`;
}

export function findPageForPersistence(pages: OutlinePage[], target: OutlinePage) {
  return pages.find((page) => page.id === target.id)
    ?? (target.backendId ? pages.find((page) => page.backendId === target.backendId) : null)
    ?? (target.kind === 'journal' ? pages.find((page) => page.kind === 'journal' && page.date === target.date) : null)
    ?? null;
}

export function describeSaveFailure(page: OutlinePage, error: unknown) {
  return {
    pageId: page.id,
    backendId: page.backendId ?? null,
    title: getPageTitle(page),
    error,
  };
}

export function normalizePageForSave(page: OutlinePage): OutlinePage {
  const clones = page.nodes.map((node) => ({ ...node }));
  const nodeById = new Map(clones.map((node) => [node.id, node]));
  const childrenByParent = new Map<string, typeof clones>();
  const roots: typeof clones = [];

  for (const node of clones) {
    if (!node.parentId || node.parentId === node.id || !nodeById.has(node.parentId)) {
      node.parentId = null;
      roots.push(node);
      continue;
    }

    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }

  const ordered: typeof clones = [];
  const emitted = new Set<string>();

  function visit(node: (typeof clones)[number]) {
    if (emitted.has(node.id)) {
      return;
    }

    emitted.add(node.id);
    ordered.push(node);

    for (const child of childrenByParent.get(node.id) ?? []) {
      visit(child);
    }
  }

  for (const root of roots) {
    visit(root);
  }

  // Any leftovers are cyclic references; promote them to roots to recover a valid outline.
  for (const node of clones) {
    if (emitted.has(node.id)) {
      continue;
    }
    node.parentId = null;
    visit(node);
  }

  return {
    ...page,
    nodes: ordered,
  };
}

export function describeInvalidBlockTree(page: OutlinePage): InvalidBlockTreeInfo | null {
  const seenNodeIds = new Set<string>();
  const nodeById = new Map(page.nodes.map((node) => [node.id, node]));

  for (const [index, node] of page.nodes.entries()) {
    if (node.parentId && !seenNodeIds.has(node.parentId)) {
      const parent = nodeById.get(node.parentId) ?? null;
      const start = Math.max(0, index - 2);
      const end = Math.min(page.nodes.length, index + 3);
      return {
        nodeId: node.id,
        parentId: node.parentId,
        backendId: node.backendId ?? null,
        parentBackendId: parent?.backendId ?? null,
        index,
        parentIndex: page.nodes.findIndex((entry) => entry.id === node.parentId),
        text: node.text.trim() || '(blank block)',
        nearbyNodes: page.nodes.slice(start, end).map((entry, offset) => ({
          index: start + offset,
          id: entry.id,
          backendId: entry.backendId ?? null,
          parentId: entry.parentId,
          parentBackendId: entry.parentId ? (nodeById.get(entry.parentId)?.backendId ?? null) : null,
          text: entry.text.trim() || '(blank block)',
        })),
      };
    }

    seenNodeIds.add(node.id);
  }

  return null;
}

export function validatePageForSave(page: OutlinePage) {
  const seenNodeIds = new Set<string>();

  for (const node of page.nodes) {
    if (node.parentId && !seenNodeIds.has(node.parentId)) {
      return `Block tree is invalid near "${node.text.trim() || '(blank block)'}".`;
    }

    if (node.todoStatus && !node.text.trim()) {
      return 'Blank todo blocks cannot be saved. Add text or clear the status chip.';
    }

    seenNodeIds.add(node.id);
  }

  return null;
}
