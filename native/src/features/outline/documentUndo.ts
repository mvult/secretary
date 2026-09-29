import type { DocumentUndo, OutlinePage, OutlineState } from './types';
import { getPagesForPersistence } from './tree';

export function sameContent(a: OutlinePage, b: OutlinePage) {
  return a === b || (a.title === b.title && (a.nodes === b.nodes || (a.nodes.length === b.nodes.length
    && a.nodes.every((node, i) => node.id === b.nodes[i].id && node.parentId === b.nodes[i].parentId
      && node.text === b.nodes[i].text && (node.todoStatus || '') === (b.nodes[i].todoStatus || '')))));
}

export function rememberEdit(state: OutlineState, next: OutlineState): OutlineState {
  const before = state.pages.find(page => page.id === state.activePageId);
  const after = before && next.pages.find(page => page.id === before.id);
  if (!before || !after || sameContent(before, after)) return next;
  const snapshot: DocumentUndo = { title: before.title,
    nodes: before.nodes.map(({ id, parentId, text, todoStatus }) => ({ id, parentId, text, todoStatus })),
    focusedId: state.focusedId, normalCursor: state.normalCursor };
  return { ...next, documentHistory: { ...next.documentHistory,
    [before.id]: [...(state.documentHistory?.[before.id] ?? []).slice(-99), snapshot] } };
}

/** Transport identities outlive local deletion, but not acknowledged deletion. */
export function observeIdentities(state: OutlineState, next: OutlineState, acknowledged?: OutlinePage): OutlineState {
  let identities = state.blockIdentities ?? {};
  const previous = new Map(state.pages.map(page => [page.id, page]));
  for (const page of next.pages) {
    if (previous.get(page.id) === page && identities[page.id] && !acknowledged) continue;
    let mappings = { ...identities[page.id] };
    if (!acknowledged && previous.get(page.id)?.revision !== page.revision) mappings = {};
    if (acknowledged && page.backendId === acknowledged.backendId) {
      const byKey = new Map(acknowledged.nodes.map(node => [node.clientKey, node]));
      const byId = new Map(acknowledged.nodes.map(node => [node.backendId, node]));
      mappings = Object.fromEntries(Object.entries(mappings).flatMap(([logicalId, identity]) => {
        const live = byKey.get(identity.clientKey ?? logicalId) ?? (identity.backendId ? byId.get(identity.backendId) : undefined);
        if (!live) return [];
        const { backendId, clientKey, todoId, createdAt, updatedAt } = live;
        return [[logicalId, { backendId, clientKey, todoId, createdAt, updatedAt }]];
      }));
    }
    for (const node of page.nodes) {
      const { backendId, clientKey, todoId, createdAt, updatedAt } = node;
      mappings[node.id] = { backendId, clientKey, todoId, createdAt, updatedAt };
    }
    identities = { ...identities, [page.id]: mappings };
  }
  const ids = new Set(next.pages.map(page => page.id));
  identities = Object.fromEntries(Object.entries(identities).filter(([id]) => ids.has(id)));
  return { ...next, blockIdentities: identities };
}

export function undoDocument(state: OutlineState): OutlineState {
  const page = state.pages.find(page => page.id === state.activePageId);
  const history = state.documentHistory?.[state.activePageId] ?? [];
  const snapshot = history[history.length - 1];
  if (!page || !snapshot) return state;
  const identities = state.blockIdentities?.[page.id] ?? {};
  const nodes = snapshot.nodes.map(node => ({ ...node,
    ...(identities[node.id] ?? { clientKey: crypto.randomUUID() }) }));
  return { ...state, pages: state.pages.map(entry => entry === page ? { ...page, title: snapshot.title, nodes } : entry),
    focusedId: snapshot.focusedId, normalCursor: snapshot.normalCursor, editingId: null, draftText: '', mode: 'normal', anchorId: null,
    documentHistory: { ...state.documentHistory, [page.id]: history.slice(0, -1) } };
}

/** Only replaced documents lose history; unrelated pages retain their stacks. */
export function retainHistories(state: OutlineState, pages: OutlinePage[]) {
  const previous = new Map(getPagesForPersistence(state).map(page => [page.id, page]));
  return Object.fromEntries(pages.filter(page => {
    const old = previous.get(page.id);
    return old && old.revision === page.revision && sameContent(old, page);
  }).map(page => [page.id, state.documentHistory?.[page.id] ?? []]));
}
