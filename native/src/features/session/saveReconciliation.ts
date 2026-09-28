import { pageHash } from '../../app/pagePersistence';
import type { OutlinePage } from '../outline/types';
import { serverContent } from './draftReconciliation';

function mergeSavedIdentities(requestPage: OutlinePage, latestPage: OutlinePage, savedPage: OutlinePage): OutlinePage {
  const byBackendId = new Map(savedPage.nodes.filter((node) => node.backendId).map((node) => [node.backendId!, node]));
  const byClientKey = new Map(savedPage.nodes.filter((node) => node.clientKey).map((node) => [node.clientKey!, node]));
  const byId = new Map(savedPage.nodes.map((node) => [node.id, node]));
  const requestToSaved = new Map(requestPage.nodes.map((node) => [
    node.id,
    node.backendId ? byBackendId.get(node.backendId) : byClientKey.get(node.clientKey ?? node.id) ?? byId.get(node.id),
  ]));
  for (const [id, saved] of requestToSaved) {
    if (!saved?.backendId) throw new Error(`Save response is missing the identity for block ${id}. Retain the draft and compare the server copy.`);
  }

  return {
    ...latestPage,
    backendId: savedPage.backendId,
    clientKey: savedPage.clientKey,
    revision: savedPage.revision,
    workspaceId: savedPage.workspaceId,
    createdAt: savedPage.createdAt,
    updatedAt: savedPage.updatedAt,
    nodes: latestPage.nodes.map((node) => {
      const savedNode = requestToSaved.get(node.id) ?? (node.backendId ? byBackendId.get(node.backendId) : byClientKey.get(node.clientKey ?? node.id));
      return savedNode ? {
        ...node,
        backendId: savedNode.backendId,
        clientKey: savedNode.clientKey,
        todoId: savedNode.todoId,
        createdAt: savedNode.createdAt,
        updatedAt: savedNode.updatedAt,
      } : node;
    }),
  };
}

export function reconcileSavedPage(requestPage: OutlinePage, latestPage: OutlinePage, savedPage: OutlinePage) {
  // Validate mappings even when no newer edits exist; never silently accept a
  // response whose new block identities would have to be guessed by position.
  const submitted = mergeSavedIdentities(requestPage, requestPage, savedPage);
  if (pageHash(latestPage) === pageHash(requestPage)) {
    return { page: savedPage, savedHash: pageHash(savedPage), needsSave: false };
  }

  // Only the request was persisted. Preserve newer edits, but never mark them saved.
  const page = mergeSavedIdentities(requestPage, latestPage, savedPage);
  // A replay after failed local acknowledgment may already have the allocated
  // identities in memory. Identity-only differences are not newer user edits.
  if (serverContent(page) === serverContent(submitted)) {
    return { page, savedHash: pageHash(page), needsSave: false };
  }
  const savedHash = pageHash(submitted);
  return { page, savedHash, needsSave: pageHash(page) !== savedHash };
}
