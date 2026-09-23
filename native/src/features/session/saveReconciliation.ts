import { pageHash } from '../../app/pagePersistence';
import type { OutlinePage } from '../outline/types';

function mergeSavedIdentities(requestPage: OutlinePage, latestPage: OutlinePage, savedPage: OutlinePage): OutlinePage {
  const byBackendId = new Map(savedPage.nodes.filter((node) => node.backendId).map((node) => [node.backendId!, node]));
  const requestToSaved = new Map(requestPage.nodes.map((node, index) => [
    node.id,
    (node.backendId ? byBackendId.get(node.backendId) : null) ?? savedPage.nodes[index],
  ]));

  return {
    ...latestPage,
    backendId: savedPage.backendId,
    workspaceId: savedPage.workspaceId,
    createdAt: savedPage.createdAt,
    updatedAt: savedPage.updatedAt,
    nodes: latestPage.nodes.map((node) => {
      const savedNode = requestToSaved.get(node.id);
      return savedNode ? {
        ...node,
        backendId: savedNode.backendId,
        todoId: savedNode.todoId,
        createdAt: savedNode.createdAt,
        updatedAt: savedNode.updatedAt,
      } : node;
    }),
  };
}

export function reconcileSavedPage(requestPage: OutlinePage, latestPage: OutlinePage, savedPage: OutlinePage) {
  if (pageHash(latestPage) === pageHash(requestPage)) {
    return { page: savedPage, savedHash: pageHash(savedPage), needsSave: false };
  }

  // Only the request was persisted. Preserve newer edits, but never mark them saved.
  const page = mergeSavedIdentities(requestPage, latestPage, savedPage);
  const savedHash = pageHash(mergeSavedIdentities(requestPage, requestPage, savedPage));
  return { page, savedHash, needsSave: pageHash(page) !== savedHash };
}
