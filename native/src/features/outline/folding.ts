import type { OutlineNode, OutlineState } from './types';

export function getVisibleNodes(nodes: OutlineNode[], collapsedNodeIds: string[] = []) {
  const collapsed = new Set(collapsedNodeIds);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.filter((node) => {
    let parentId = node.parentId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      if (collapsed.has(parentId)) return false;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    return true;
  });
}

// Editing, undo, and links can move focus into a folded subtree.
export function revealFocusedNode(state: OutlineState): OutlineState {
  if (!state.collapsedNodeIds?.length) return state;
  const nodes = state.pages.find((page) => page.id === state.activePageId)?.nodes ?? [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ancestors = new Set<string>();
  let parentId = byId.get(state.editingId ?? state.focusedId)?.parentId;
  while (parentId && !ancestors.has(parentId)) {
    ancestors.add(parentId);
    parentId = byId.get(parentId)?.parentId;
  }
  const collapsedNodeIds = state.collapsedNodeIds.filter((id) => !ancestors.has(id));
  return collapsedNodeIds.length === state.collapsedNodeIds.length ? state : { ...state, collapsedNodeIds };
}
