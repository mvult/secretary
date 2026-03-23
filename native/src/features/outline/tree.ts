import { cycleStatus } from './keymap';
import { createJournalPage, formatPageDate, getDateKey } from './sampleData';
import type { CursorPlacement, OutlineNode, OutlinePage, OutlineSnapshot, OutlineState } from './types';

function buildIndexMap(nodes: OutlineNode[]) {
  return new Map(nodes.map((node, index) => [node.id, index]));
}

function cloneNodes(nodes: OutlineNode[]) {
  return nodes.map((node) => ({ ...node }));
}

function clonePages(pages: OutlinePage[]) {
  return pages.map((page) => ({ ...page, nodes: cloneNodes(page.nodes) }));
}

function getNodeMap(nodes: OutlineNode[]) {
  return new Map(nodes.map((node) => [node.id, node]));
}

function createNodeId() {
  return `node-${crypto.randomUUID()}`;
}

function createPageId() {
  return `note-${crypto.randomUUID()}`;
}

function createSiblingNode(parentId: string | null): OutlineNode {
  return {
    id: createNodeId(),
    parentId,
    text: '',
    status: 'note',
  };
}

function createBlankNotePage(): OutlinePage {
  return {
    id: createPageId(),
    kind: 'note',
    date: getDateKey(new Date()),
    title: '',
    nodes: [
      {
        id: createNodeId(),
        parentId: null,
        text: '',
        status: 'note',
      },
    ],
  };
}

function getPageById(pages: OutlinePage[], pageId: string) {
  return pages.find((page) => page.id === pageId) ?? pages[0] ?? null;
}

export function getCurrentPage(state: OutlineState) {
  return getPageById(state.pages, state.activePageId);
}

export function getPagesForPersistence(state: OutlineState) {
  const pages = clonePages(state.pages);
  if (!state.editingId) {
    return pages;
  }

  return pages.map((page) => ({
    ...page,
    nodes: page.nodes.map((node) =>
      node.id === state.editingId
        ? {
            ...node,
            text: state.draftText,
          }
        : node,
    ),
  }));
}

function getActiveNodes(state: OutlineState) {
  return getCurrentPage(state)?.nodes ?? [];
}

function replaceActivePage(state: OutlineState, updater: (page: OutlinePage) => OutlinePage): OutlineState {
  return {
    ...state,
    pages: state.pages.map((page) => (page.id === state.activePageId ? updater(page) : page)),
  };
}

function getSafeFocusedId(nodes: OutlineNode[], focusedId?: string) {
  if (nodes.length === 0) {
    return '';
  }

  if (focusedId && nodes.some((node) => node.id === focusedId)) {
    return focusedId;
  }

  return nodes[0].id;
}

function clampCursor(value: number, text: string) {
  return Math.max(0, Math.min(value, text.length));
}

function getFocusedNode(state: OutlineState) {
  return getActiveNodes(state).find((node) => node.id === state.focusedId) ?? null;
}

function getNormalCursor(state: OutlineState) {
  const text = getFocusedNode(state)?.text ?? '';
  return clampCursor(state.normalCursor, text);
}

function isWordChar(char: string | undefined) {
  return Boolean(char && /[A-Za-z0-9_]/.test(char));
}

function findWordForward(text: string, cursor: number) {
  let index = clampCursor(cursor, text);
  if (index >= text.length) {
    return text.length;
  }

  if (isWordChar(text[index])) {
    while (index < text.length && isWordChar(text[index])) {
      index += 1;
    }
  }

  while (index < text.length && !isWordChar(text[index])) {
    index += 1;
  }

  return index;
}

function findWordBackward(text: string, cursor: number) {
  let index = clampCursor(cursor, text);
  if (index <= 0) {
    return 0;
  }

  index -= 1;
  while (index > 0 && !isWordChar(text[index])) {
    index -= 1;
  }

  while (index > 0 && isWordChar(text[index - 1])) {
    index -= 1;
  }

  return index;
}

function findWordEnd(text: string, cursor: number) {
  let index = clampCursor(cursor, text);
  if (text.length === 0) {
    return 0;
  }

  if (index >= text.length) {
    return text.length;
  }

  while (index < text.length && !isWordChar(text[index])) {
    index += 1;
  }

  while (index < text.length && isWordChar(text[index])) {
    index += 1;
  }

  return Math.max(0, index - 1);
}

function resolveEditCursor(text: string, placement: CursorPlacement) {
  if (placement === 'start') {
    return 0;
  }

  if (placement === 'end') {
    return text.length;
  }

  return clampCursor(placement, text);
}

export function getNodeDepth(nodes: OutlineNode[], nodeId: string): number {
  const byId = getNodeMap(nodes);
  let depth = 0;
  let current = byId.get(nodeId) ?? null;

  while (current?.parentId) {
    depth += 1;
    current = byId.get(current.parentId) ?? null;
  }

  return depth;
}

function getSelectionIds(state: OutlineState): string[] {
  const ids = getActiveNodes(state).map((node) => node.id);
  if (!state.anchorId) {
    return state.focusedId ? [state.focusedId] : [];
  }

  const anchorIndex = ids.indexOf(state.anchorId);
  const focusIndex = ids.indexOf(state.focusedId);
  if (anchorIndex === -1 || focusIndex === -1) {
    return state.focusedId ? [state.focusedId] : [];
  }

  const [start, end] = anchorIndex < focusIndex ? [anchorIndex, focusIndex] : [focusIndex, anchorIndex];
  return ids.slice(start, end + 1);
}

export function getSelectedInfo(state: OutlineState) {
  const nodes = getActiveNodes(state);
  const focusedNode = nodes.find((node) => node.id === state.focusedId) ?? nodes[0];
  return {
    focusedNode,
    selectedIds: getSelectionIds(state),
  };
}

export function getJournalPage(state: OutlineState) {
  const todayKey = getDateKey(new Date());
  return state.pages.find((page) => page.kind === 'journal' && page.date === todayKey) ?? null;
}

export function getJournalPages(state: OutlineState) {
  return state.pages
    .filter((page) => page.kind === 'journal')
    .sort((left, right) => right.date.localeCompare(left.date));
}

export function getNotePages(state: OutlineState) {
  return state.pages.filter((page) => page.kind === 'note');
}

export function findMatchingNotes(state: OutlineState, query: string) {
  const normalized = query.trim().toLowerCase();
  const notes = getNotePages(state);

  return notes
    .map((page) => {
      const title = getPageTitle(page).toLowerCase();
      const text = page.nodes.map((node) => node.text).join(' ').toLowerCase();
      const titleStarts = title.startsWith(normalized) ? 0 : 1;
      const titleIncludes = title.includes(normalized) ? 0 : 1;
      const textIncludes = text.includes(normalized) ? 0 : 1;
      return {
        page,
        rank: titleStarts * 100 + titleIncludes * 10 + textIncludes,
      };
    })
    .filter((entry) => !normalized || entry.rank < 111)
    .sort((left, right) => left.rank - right.rank || right.page.date.localeCompare(left.page.date));
}

export function getPageTitle(page: OutlinePage) {
  if (page.kind === 'journal') {
    return getPageDateLabel(page);
  }

  return page.title.trim() || 'Untitled note';
}

export function getPageDateLabel(page: OutlinePage) {
  return formatPageDate(new Date(`${page.date}T12:00:00`));
}

export function updatePageTitle(state: OutlineState, title: string): OutlineState {
  const page = getCurrentPage(state);
  if (!page || page.kind !== 'note' || page.title === title) {
    return state;
  }

  return replaceActivePage(state, (currentPage) => ({
    ...currentPage,
    title,
  }));
}

export function ensureTodayJournalPage(state: OutlineState): OutlineState {
  const todayKey = getDateKey(new Date());
  const existing = state.pages.find((page) => page.kind === 'journal' && page.date === todayKey);
  if (existing) {
    return state;
  }

  const journalPage = createJournalPage();
  return {
    ...state,
    pages: [journalPage, ...state.pages],
  };
}

export function createTodayJournalPage(state: OutlineState): OutlineState {
  const todayKey = getDateKey(new Date());
  const existing = state.pages.find((page) => page.kind === 'journal' && page.date === todayKey);
  if (existing) {
    return selectJournalPage(state, existing.id);
  }

  const journalPage = createJournalPage();
  return {
    ...state,
    pages: [journalPage, ...state.pages],
    activePageId: journalPage.id,
    activeView: 'journals',
    focusedId: getSafeFocusedId(journalPage.nodes),
    normalCursor: 0,
    anchorId: null,
    editingId: journalPage.nodes[0]?.id ?? null,
    draftText: journalPage.nodes[0]?.text ?? '',
    editCursor: 'start',
    mode: 'insert',
  };
}

export function makeSnapshot(state: OutlineState): OutlineSnapshot {
  return {
    pages: clonePages(state.pages),
    activePageId: state.activePageId,
    activeView: state.activeView,
    focusedId: state.focusedId,
    normalCursor: state.normalCursor,
    anchorId: state.anchorId,
    editingId: state.editingId,
    draftText: state.draftText,
    editCursor: state.editCursor,
    mode: state.mode,
    yankBuffer: state.yankBuffer,
  };
}

export function restoreSnapshot(state: OutlineState, snapshot: OutlineSnapshot): OutlineState {
  return {
    ...state,
    ...snapshot,
    pages: clonePages(snapshot.pages),
  };
}

export function hydratePages(state: OutlineState, pages: OutlinePage[]): OutlineState {
  const nextPages = clonePages(pages);
  const todayJournal = nextPages.find((page) => page.kind === 'journal' && page.date === getDateKey(new Date()));
  const activePage = todayJournal ?? nextPages[0] ?? null;

  return {
    ...state,
    pages: nextPages,
    activePageId: activePage?.id ?? '',
    activeView: activePage?.kind === 'note' ? 'note' : 'journals',
    focusedId: activePage ? getSafeFocusedId(activePage.nodes) : '',
    normalCursor: 0,
    anchorId: null,
    editingId: null,
    draftText: '',
    editCursor: 'end',
    mode: 'normal',
    history: [],
  };
}

export function mergeRemotePage(state: OutlineState, page: OutlinePage): OutlineState {
  const existing = state.pages.some((entry) => entry.id === page.id);
  const nextPages = existing
    ? state.pages.map((entry) => (entry.id === page.id ? page : entry))
    : [page, ...state.pages];
  const activePage = nextPages.find((entry) => entry.id === state.activePageId) ?? page;

  return {
    ...state,
    pages: nextPages,
    activePageId: activePage.id,
    focusedId: activePage.nodes.some((node) => node.id === state.focusedId) ? state.focusedId : getSafeFocusedId(activePage.nodes),
  };
}

function clearSelection(state: OutlineState, focusedId: string): OutlineState {
  const nextNode = getActiveNodes(state).find((node) => node.id === focusedId);
  return {
    ...state,
    focusedId,
    normalCursor: clampCursor(state.normalCursor, nextNode?.text ?? ''),
    anchorId: null,
  };
}

function selectJournalBoundary(state: OutlineState, pageId: string, position: 'start' | 'end'): OutlineState {
  const page = state.pages.find((entry) => entry.id === pageId && entry.kind === 'journal');
  if (!page || page.nodes.length === 0) {
    return state;
  }

  const targetNode = position === 'start' ? page.nodes[0] : page.nodes[page.nodes.length - 1];
  const cursor = position === 'start' ? 0 : targetNode.text.length;

  return {
    ...state,
    activePageId: page.id,
    activeView: 'journals',
    focusedId: targetNode.id,
    normalCursor: cursor,
    anchorId: null,
    editingId: null,
    draftText: '',
    editCursor: 'end',
    mode: 'normal',
  };
}

export function selectJournal(state: OutlineState): OutlineState {
  const nextState = commitEdit(state);
  const journalPage = getJournalPage(nextState);
  if (!journalPage) {
    return createTodayJournalPage(nextState);
  }

  return {
    ...nextState,
    activePageId: journalPage.id,
    activeView: 'journals',
    focusedId: getSafeFocusedId(journalPage.nodes),
    normalCursor: 0,
    anchorId: null,
    editingId: null,
    draftText: '',
    editCursor: 'end',
    mode: 'normal',
  };
}

export function selectJournalPage(state: OutlineState, pageId: string): OutlineState {
  const committed = commitEdit(state);
  const page = committed.pages.find((entry) => entry.id === pageId && entry.kind === 'journal');
  if (!page) {
    return committed;
  }

  return {
    ...committed,
    activePageId: page.id,
    activeView: 'journals',
    focusedId: getSafeFocusedId(page.nodes),
    normalCursor: 0,
    anchorId: null,
    editingId: null,
    draftText: '',
    editCursor: 'end',
    mode: 'normal',
  };
}

export function selectNote(state: OutlineState, pageId: string): OutlineState {
  const committed = commitEdit(state);
  const page = committed.pages.find((entry) => entry.id === pageId && entry.kind === 'note');
  if (!page) {
    return committed;
  }

  return {
    ...committed,
    activePageId: page.id,
    activeView: 'note',
    focusedId: getSafeFocusedId(page.nodes),
    normalCursor: 0,
    anchorId: null,
    editingId: null,
    draftText: '',
    editCursor: 'end',
    mode: 'normal',
  };
}

export function openSearchView(state: OutlineState): OutlineState {
  return {
    ...commitEdit(state),
    activeView: 'search',
    anchorId: null,
  };
}

export function openSettingsView(state: OutlineState): OutlineState {
  return {
    ...commitEdit(state),
    activeView: 'settings',
    anchorId: null,
  };
}

export function yankLine(state: OutlineState): OutlineState {
  const focusedNode = getFocusedNode(state);
  if (!focusedNode) {
    return state;
  }

  return {
    ...state,
    yankBuffer: {
      text: focusedNode.text,
      status: focusedNode.status,
    },
  };
}

export function pasteBelow(state: OutlineState, text?: string): OutlineState {
  const pastedText = text ?? state.yankBuffer?.text;
  if (!pastedText) {
    return state;
  }

  const nodes = getActiveNodes(state);
  const focusedIndex = nodes.findIndex((node) => node.id === state.focusedId);
  if (focusedIndex === -1) {
    return state;
  }

  const focusedNode = nodes[focusedIndex];
  const insertAt = getSubtreeEnd(nodes, focusedIndex);
  const newNode: OutlineNode = {
    id: createNodeId(),
    parentId: focusedNode.parentId,
    text: pastedText,
    status: text && text !== state.yankBuffer?.text ? 'note' : (state.yankBuffer?.status ?? 'note'),
  };
  const nextState = replaceActivePage(state, (page) => ({
    ...page,
    nodes: [...page.nodes.slice(0, insertAt), newNode, ...page.nodes.slice(insertAt)],
  }));

  return {
    ...nextState,
    focusedId: newNode.id,
    normalCursor: clampCursor(state.normalCursor, newNode.text),
    anchorId: null,
    editingId: null,
    draftText: '',
    editCursor: 'end',
    mode: 'normal',
  };
}

export function createNotePage(state: OutlineState, title = ''): OutlineState {
  const committed = commitEdit(state);
  const page = createBlankNotePage();
  const nextTitle = title.trim();
  const nextPage = {
    ...page,
    title: nextTitle,
  };

  return {
    ...committed,
    pages: [nextPage, ...committed.pages],
    activePageId: nextPage.id,
    activeView: 'note',
    focusedId: nextPage.nodes[0].id,
    normalCursor: 0,
    anchorId: null,
    editingId: nextPage.nodes[0].id,
    draftText: '',
    editCursor: 'start',
    mode: 'insert',
  };
}

export function moveFocus(state: OutlineState, direction: 1 | -1, extendSelection: boolean): OutlineState {
  const nodes = getActiveNodes(state);
  const currentIndex = nodes.findIndex((node) => node.id === state.focusedId);
  if (currentIndex === -1) {
    return state;
  }

  const nextIndex = Math.max(0, Math.min(nodes.length - 1, currentIndex + direction));
  if (nextIndex === currentIndex) {
    if (!extendSelection && state.activeView === 'journals' && (direction === 1 || direction === -1)) {
      const journals = getJournalPages(state);
      const journalIndex = journals.findIndex((page) => page.id === state.activePageId);
      const adjacentPage = journals[journalIndex + direction];
      if (adjacentPage) {
        return selectJournalBoundary(state, adjacentPage.id, direction === 1 ? 'start' : 'end');
      }
    }

    return state;
  }

  const nextId = nodes[nextIndex].id;
  const nextCursor = clampCursor(state.normalCursor, nodes[nextIndex].text);
  if (!extendSelection) {
    return clearSelection({ ...state, mode: 'normal', editingId: null, normalCursor: nextCursor }, nextId);
  }

  return {
    ...state,
    mode: 'normal',
    editingId: null,
    focusedId: nextId,
    normalCursor: nextCursor,
    anchorId: state.anchorId ?? state.focusedId,
  };
}

export function jumpFocusInPage(state: OutlineState, position: 'start' | 'end'): OutlineState {
  const nodes = getActiveNodes(state);
  if (nodes.length === 0) {
    return state;
  }

  const targetNode = position === 'start' ? nodes[0] : nodes[nodes.length - 1];
  const nextCursor = position === 'start' ? 0 : targetNode.text.length;
  return clearSelection({ ...state, mode: 'normal', editingId: null, normalCursor: nextCursor }, targetNode.id);
}

export function focusNode(state: OutlineState, nodeId: string): OutlineState {
  return clearSelection({ ...state, mode: 'normal', editingId: null, normalCursor: 0 }, nodeId);
}

export function moveCaret(
  state: OutlineState,
  motion: 'left' | 'right' | 'wordForward' | 'wordBackward' | 'wordEnd' | 'lineStart' | 'lineEnd',
): OutlineState {
  if (state.editingId) {
    return state;
  }

  const target = getFocusedNode(state);
  if (!target) {
    return state;
  }

  const cursor = getNormalCursor(state);
  let nextCursor = cursor;

  switch (motion) {
    case 'left':
      nextCursor = clampCursor(cursor - 1, target.text);
      break;
    case 'right':
      nextCursor = clampCursor(cursor + 1, target.text);
      break;
    case 'wordForward':
      nextCursor = findWordForward(target.text, cursor);
      break;
    case 'wordBackward':
      nextCursor = findWordBackward(target.text, cursor);
      break;
    case 'wordEnd':
      nextCursor = findWordEnd(target.text, cursor);
      break;
    case 'lineStart':
      nextCursor = 0;
      break;
    case 'lineEnd':
      nextCursor = target.text.length;
      break;
  }

  if (nextCursor === cursor) {
    return state;
  }

  return {
    ...state,
    normalCursor: nextCursor,
  };
}

export function startEditing(state: OutlineState, placement: 'current' | 'after' | 'start' | 'end' = 'current'): OutlineState {
  const target = getActiveNodes(state).find((node) => node.id === state.focusedId);
  if (!target) {
    return state;
  }

  const normalCursor = getNormalCursor(state);
  const editCursor = (() => {
    if (placement === 'start') {
      return 0;
    }

    if (placement === 'end') {
      return target.text.length;
    }

    if (placement === 'after') {
      return clampCursor(normalCursor + 1, target.text);
    }

    return normalCursor;
  })();

  return {
    ...state,
    editingId: target.id,
    draftText: target.text,
    editCursor,
    mode: 'insert',
  };
}

export function updateDraft(state: OutlineState, text: string): OutlineState {
  if (!state.editingId) {
    return state;
  }

  return {
    ...state,
    draftText: text,
  };
}

export function commitEdit(state: OutlineState, nextText?: string, nextCursor?: number): OutlineState {
  if (!state.editingId) {
    return { ...state, mode: 'normal' };
  }

  const text = nextText ?? state.draftText;
  const nextState = replaceActivePage(state, (page) => ({
    ...page,
    nodes: page.nodes.map((node) =>
      node.id === state.editingId
        ? {
            ...node,
            text,
          }
        : node,
    ),
  }));

  return {
    ...nextState,
    normalCursor: clampCursor(nextCursor ?? resolveEditCursor(text, state.editCursor), text),
    editingId: null,
    draftText: '',
    editCursor: 'end',
    mode: 'normal',
  };
}

function getSubtreeEnd(nodes: OutlineNode[], startIndex: number): number {
  const startDepth = getNodeDepth(nodes, nodes[startIndex].id);
  let endIndex = startIndex + 1;

  while (endIndex < nodes.length && getNodeDepth(nodes, nodes[endIndex].id) > startDepth) {
    endIndex += 1;
  }

  return endIndex;
}

function getSelectedRoots(nodes: OutlineNode[], selectedIds: string[]) {
  const selectedSet = new Set(selectedIds);
  return nodes.filter((node) => selectedSet.has(node.id) && (!node.parentId || !selectedSet.has(node.parentId)));
}

export function openBelow(state: OutlineState): OutlineState {
  const nodes = getActiveNodes(state);
  const focusedIndex = nodes.findIndex((node) => node.id === state.focusedId);
  if (focusedIndex === -1) {
    return state;
  }

  const focusedNode = nodes[focusedIndex];
  const insertAt = getSubtreeEnd(nodes, focusedIndex);
  const newNode = createSiblingNode(focusedNode.parentId);
  const nextState = replaceActivePage(state, (page) => ({
    ...page,
    nodes: [...page.nodes.slice(0, insertAt), newNode, ...page.nodes.slice(insertAt)],
  }));

  return {
    ...nextState,
    focusedId: newNode.id,
    normalCursor: 0,
    anchorId: null,
    editingId: newNode.id,
    draftText: '',
    editCursor: 'start',
    mode: 'insert',
  };
}

export function openAbove(state: OutlineState): OutlineState {
  const nodes = getActiveNodes(state);
  const focusedIndex = nodes.findIndex((node) => node.id === state.focusedId);
  if (focusedIndex === -1) {
    return state;
  }

  const focusedNode = nodes[focusedIndex];
  const newNode = createSiblingNode(focusedNode.parentId);
  const nextState = replaceActivePage(state, (page) => ({
    ...page,
    nodes: [...page.nodes.slice(0, focusedIndex), newNode, ...page.nodes.slice(focusedIndex)],
  }));

  return {
    ...nextState,
    focusedId: newNode.id,
    normalCursor: 0,
    anchorId: null,
    editingId: newNode.id,
    draftText: '',
    editCursor: 'start',
    mode: 'insert',
  };
}

export function splitNodeAtCursor(state: OutlineState, selectionStart: number, selectionEnd: number): OutlineState {
  if (!state.editingId) {
    return state;
  }

  const nodes = getActiveNodes(state);
  const focusedIndex = nodes.findIndex((node) => node.id === state.editingId);
  if (focusedIndex === -1) {
    return state;
  }

  const currentNode = nodes[focusedIndex];
  const draft = state.draftText;
  const start = Math.max(0, Math.min(selectionStart, draft.length));
  const end = Math.max(start, Math.min(selectionEnd, draft.length));
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const newNode = createSiblingNode(currentNode.parentId);
  const insertAt = getSubtreeEnd(nodes, focusedIndex);
  const nextState = replaceActivePage(state, (page) => {
    const nextNodes = [...page.nodes];

    nextNodes[focusedIndex] = {
      ...currentNode,
      text: before,
    };
    nextNodes.splice(insertAt, 0, {
      ...newNode,
      status: currentNode.status,
      text: after,
    });

    return {
      ...page,
      nodes: nextNodes,
    };
  });

  return {
    ...nextState,
    focusedId: newNode.id,
    normalCursor: 0,
    anchorId: null,
    editingId: newNode.id,
    draftText: after,
    editCursor: 'start',
    mode: 'insert',
  };
}

export function deleteSelection(state: OutlineState): OutlineState {
  const nodes = getActiveNodes(state);
  const selectedRoots = getSelectedRoots(nodes, getSelectionIds(state));
  if (selectedRoots.length === 0 || nodes.length === 0) {
    return state;
  }

  const removalIds = new Set<string>();
  for (const root of selectedRoots) {
    const startIndex = nodes.findIndex((node) => node.id === root.id);
    if (startIndex === -1) {
      continue;
    }

    const endIndex = getSubtreeEnd(nodes, startIndex);
    for (const node of nodes.slice(startIndex, endIndex)) {
      removalIds.add(node.id);
    }
  }

  if (removalIds.size === 0 || removalIds.size === nodes.length) {
    return state;
  }

  const focusedNode = nodes.find((node) => node.id === state.focusedId) ?? selectedRoots[0] ?? null;

  const nextNodes = nodes.filter((node) => !removalIds.has(node.id));
  const focusedIndex = nodes.findIndex((node) => node.id === state.focusedId);
  const fallbackIndex = Math.min(focusedIndex, nextNodes.length - 1);
  const nextFocusedId = nextNodes[Math.max(0, fallbackIndex)].id;
  const nextState = replaceActivePage(state, (page) => ({
    ...page,
    nodes: nextNodes,
  }));

  return {
    ...nextState,
    focusedId: nextFocusedId,
    normalCursor: clampCursor(state.normalCursor, nextNodes[Math.max(0, fallbackIndex)].text),
    anchorId: null,
    editingId: null,
    draftText: '',
    editCursor: 'end',
    mode: 'normal',
    yankBuffer: focusedNode
      ? {
          text: focusedNode.text,
          status: focusedNode.status,
        }
      : state.yankBuffer,
  };
}

export function cycleSelectedStatuses(state: OutlineState): OutlineState {
  const selectedIds = new Set(getSelectionIds(state));
  return replaceActivePage(state, (page) => ({
    ...page,
    nodes: page.nodes.map((node) =>
      selectedIds.has(node.id)
        ? {
            ...node,
            status: cycleStatus(node.status),
          }
        : node,
    ),
  }));
}

export function toggleNodeStatus(state: OutlineState, nodeId: string): OutlineState {
  const page = getCurrentPage(state);
  const node = page?.nodes.find((entry) => entry.id === nodeId);
  if (!page || !node || (node.status !== 'todo' && node.status !== 'done')) {
    return state;
  }

  const nextStatus = node.status === 'todo' ? 'done' : 'todo';
  return {
    ...replaceActivePage(state, (currentPage) => ({
      ...currentPage,
      nodes: currentPage.nodes.map((entry) => (entry.id === nodeId ? { ...entry, status: nextStatus } : entry)),
    })),
    focusedId: nodeId,
    anchorId: null,
    editingId: null,
    mode: 'normal',
  };
}

export function indentSelection(state: OutlineState): OutlineState {
  const nodes = getActiveNodes(state);
  const selectedRoots = getSelectedRoots(nodes, getSelectionIds(state));
  if (selectedRoots.length === 0) {
    return state;
  }

  const indexMap = buildIndexMap(nodes);
  const nodeMap = getNodeMap(nodes);
  const updates = new Map<string, string | null>();

  for (const root of selectedRoots) {
    const index = indexMap.get(root.id);
    if (index === undefined || index === 0) {
      continue;
    }

    const previousNode = nodes[index - 1];
    const previousDepth = getNodeDepth(nodes, previousNode.id);
    const currentDepth = getNodeDepth(nodes, root.id);
    if (previousDepth < currentDepth) {
      continue;
    }

    let candidateId: string | null = previousNode.id;
    while (candidateId) {
      const candidate = nodeMap.get(candidateId);
      if (!candidate) {
        candidateId = null;
        break;
      }

      if (getNodeDepth(nodes, candidate.id) === currentDepth) {
        break;
      }

      candidateId = candidate.parentId;
    }

    if (candidateId) {
      updates.set(root.id, candidateId);
    }
  }

  if (updates.size === 0) {
    return state;
  }

  return replaceActivePage(state, (page) => ({
    ...page,
    nodes: page.nodes.map((node) =>
      updates.has(node.id)
        ? {
            ...node,
            parentId: updates.get(node.id) ?? null,
          }
        : node,
    ),
  }));
}

export function outdentSelection(state: OutlineState): OutlineState {
  const nodes = getActiveNodes(state);
  const selectedRoots = getSelectedRoots(nodes, getSelectionIds(state));
  if (selectedRoots.length === 0) {
    return state;
  }

  const nodeMap = getNodeMap(nodes);
  const updates = new Map<string, string | null>();

  for (const root of selectedRoots) {
    if (!root.parentId) {
      continue;
    }

    const parent = nodeMap.get(root.parentId);
    updates.set(root.id, parent?.parentId ?? null);
  }

  if (updates.size === 0) {
    return state;
  }

  return replaceActivePage(state, (page) => ({
    ...page,
    nodes: page.nodes.map((node) =>
      updates.has(node.id)
        ? {
            ...node,
            parentId: updates.get(node.id) ?? null,
          }
        : node,
    ),
  }));
}

function moveSegments(nodes: OutlineNode[], segmentStarts: string[], direction: 1 | -1) {
  const indexMap = buildIndexMap(nodes);
  const segments = segmentStarts
    .map((id) => indexMap.get(id))
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b)
    .map((start) => ({ start, end: getSubtreeEnd(nodes, start) }));

  if (segments.length === 0) {
    return nodes;
  }

  if (direction === -1) {
    const first = segments[0];
    if (first.start === 0) {
      return nodes;
    }

    const previousStart = (() => {
      let cursor = first.start - 1;
      const firstDepth = getNodeDepth(nodes, nodes[first.start].id);
      while (cursor > 0 && getNodeDepth(nodes, nodes[cursor].id) > firstDepth) {
        cursor -= 1;
      }
      return cursor;
    })();

    const before = nodes.slice(0, previousStart);
    const swap = nodes.slice(previousStart, first.start);
    const moving = nodes.slice(first.start, segments[segments.length - 1].end);
    const after = nodes.slice(segments[segments.length - 1].end);
    return [...before, ...moving, ...swap, ...after];
  }

  const last = segments[segments.length - 1];
  if (last.end >= nodes.length) {
    return nodes;
  }

  const nextEnd = getSubtreeEnd(nodes, last.end);
  const before = nodes.slice(0, segments[0].start);
  const moving = nodes.slice(segments[0].start, last.end);
  const swap = nodes.slice(last.end, nextEnd);
  const after = nodes.slice(nextEnd);
  return [...before, ...swap, ...moving, ...after];
}

export function moveSelection(state: OutlineState, direction: 1 | -1): OutlineState {
  const nodes = getActiveNodes(state);
  const selectedRoots = getSelectedRoots(nodes, getSelectionIds(state)).map((node) => node.id);
  const nextNodes = moveSegments(nodes, selectedRoots, direction);
  if (nextNodes === nodes) {
    return state;
  }

  return replaceActivePage(state, (page) => ({
    ...page,
    nodes: nextNodes,
  }));
}
