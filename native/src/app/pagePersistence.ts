import { getPageTitle } from '../features/outline/tree';
import type { OutlinePage } from '../features/outline/types';

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
