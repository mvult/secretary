import { useReducer } from 'react';
import { revealFocusedNode } from './folding';
import {
  commitEdit,
  createNotePage,
  createTodayJournalPage,
  cycleSelectedStatuses,
  deleteWordForward,
  deleteSelection,
  deleteNotePage,
  focusNode,
  indentSelection,
  insertTextAtCursor,
  jumpFocusInPage,
  hydratePages,
  mergeRemotePage,
  getPageBackendBlockIds,
  syncRemoteTodoToPage,
  moveCaret,
  moveFocus,
  mergeWithPreviousAtCursorStart,
  moveSelection,
  pasteBelow,
  openSearchView,
  openTodosView,
  openSettingsView,
  openAIView,
  openDirectoryView,
  openPomodoroView,
  openAbove,
  openBelow,
  outdentSelection,
  selectJournal,
  selectJournalPage,
  selectNote,
  splitNodeAtCursor,
  startEditing,
  toggleNodeStatus,
  toggleVisualMode,
  updatePageTitle,
  updateDraft,
  yankLine,
} from './tree';
import type { OutlineState } from './types';
import { observeIdentities, rememberEdit, retainHistories, undoDocument } from './documentUndo';

export type OutlineAction =
  | { type: 'toggleFold'; nodeId?: string }
  | { type: 'applySessionState'; state: OutlineState }
  | { type: 'focus'; nodeId: string }
  | { type: 'moveCaret'; motion: 'left' | 'right' | 'wordForward' | 'wordBackward' | 'wordEnd' | 'lineStart' | 'lineEnd' }
  | { type: 'moveFocus'; direction: 1 | -1; extendSelection: boolean }
  | { type: 'jumpFocus'; position: 'start' | 'end' }
  | { type: 'insertTextAtCursor'; text: string }
  | { type: 'deleteWordForward' }
  | { type: 'yankLine' }
  | { type: 'pasteBelow'; text?: string; preferStructured?: boolean }
  | { type: 'pasteStructured'; text: string }
  | { type: 'startEditing'; placement?: 'current' | 'after' | 'start' | 'end' }
  | { type: 'updateDraft'; text: string }
  | { type: 'commitEdit'; text?: string; cursor?: number }
  | { type: 'cycleStatuses' }
  | { type: 'indent' }
  | { type: 'outdent' }
  | { type: 'moveSelection'; direction: 1 | -1 }
  | { type: 'openAbove' }
  | { type: 'openBelow' }
  | { type: 'splitNodeAtCursor'; selectionStart: number; selectionEnd: number }
  | { type: 'mergeWithPreviousAtCursorStart' }
  | { type: 'deleteSelection' }
  | { type: 'selectJournal' }
  | { type: 'selectJournalPage'; pageId: string }
  | { type: 'selectNote'; pageId: string }
  | { type: 'deleteNote'; pageId: string }
  | { type: 'openSearch' }
  | { type: 'openTodos' }
  | { type: 'openSettings' }
  | { type: 'openAI' }
  | { type: 'openDirectory' }
  | { type: 'openPomodoro' }
  | { type: 'createNote'; title?: string; directoryId?: number | null }
  | { type: 'createTodayJournal' }
  | { type: 'toggleNodeStatus'; nodeId: string }
  | { type: 'toggleVisualMode' }
  | { type: 'updatePageTitle'; title: string }
  | { type: 'hydrate'; pages: OutlineState['pages']; source?: string }
  | { type: 'refreshPages'; pages: OutlineState['pages'] }
  | { type: 'evictPages'; ids: ReadonlySet<string> }
  | { type: 'mergeRemotePage'; page: OutlineState['pages'][number]; previousPageId?: string; source?: string; acknowledged?: OutlineState['pages'][number] }
  | { type: 'syncRemoteTodo'; sourceDocumentId: number; sourceBlockId: number; todoId: number; status: OutlineState['pages'][number]['nodes'][number]['todoStatus']; updatedAt?: string }
  | { type: 'undo' };

function logIdentityChange(label: string, details: Record<string, unknown>) {
  console.debug(`[identity-debug] ${label}`, details);
}

const initialState: OutlineState = {
  pages: [],
  activePageId: '',
  activeView: 'journals',
  focusedId: '',
  normalCursor: 0,
  anchorId: null,
  editingId: null,
  draftText: '',
  editCursor: 'end',
  mode: 'normal',
  yankBuffer: null,
  documentHistory: {},
};

function withHistory(state: OutlineState, updater: (current: OutlineState) => OutlineState): OutlineState {
  return rememberEdit(state, updater(state));
}

export function reduceOutlineState(state: OutlineState, action: OutlineAction): OutlineState {
  if (action.type === 'applySessionState') return action.state;
  const prepared = state.blockIdentities ? state : observeIdentities(state, state);
  let next = revealFocusedNode(reduceAction(prepared, action));
  if (next.activePageId !== state.activePageId) {
    const cursors = { ...state.documentCursors, [state.activePageId]: { focusedId: state.focusedId, normalCursor: state.normalCursor } };
    const saved = cursors[next.activePageId];
    const page = next.pages.find(page => page.id === next.activePageId);
    const canRestore = saved && page?.nodes.some(node => node.id === saved.focusedId);
    next = { ...next, ...(canRestore ? saved : {}), documentCursors: Object.fromEntries(next.pages.filter(page => cursors[page.id]).map(page => [page.id, cursors[page.id]])) };
  }
  if (next === prepared) return state;
  return observeIdentities(prepared, next, action.type === 'mergeRemotePage' ? action.acknowledged : undefined);
}

function reduceAction(state: OutlineState, action: OutlineAction): OutlineState {
  const currentState = state;

  switch (action.type) {
    case 'toggleFold': {
      if (state.editingId || state.mode !== 'normal') return state;
      const nodeId = action.nodeId ?? state.focusedId;
      const page = state.pages.find((entry) => entry.id === state.activePageId);
      if (!page?.nodes.some((node) => node.parentId === nodeId)) return state;
      const collapsed = state.collapsedNodeIds ?? [];
      return {
        ...state,
        focusedId: nodeId,
        anchorId: null,
        collapsedNodeIds: collapsed.includes(nodeId) ? collapsed.filter((id) => id !== nodeId) : [...collapsed, nodeId],
      };
    }
    case 'applySessionState':
      return action.state;
    case 'focus':
      return focusNode(currentState, action.nodeId);
    case 'moveCaret':
      return moveCaret(currentState, action.motion);
    case 'moveFocus':
      return moveFocus(currentState, action.direction, action.extendSelection);
    case 'jumpFocus':
      return jumpFocusInPage(currentState, action.position);
    case 'insertTextAtCursor':
      return withHistory(currentState, (active) => insertTextAtCursor(active, action.text));
    case 'deleteWordForward':
      return withHistory(currentState, deleteWordForward);
    case 'yankLine':
      return yankLine(currentState);
    case 'pasteBelow':
      return withHistory(currentState, (active) => pasteBelow(active, action.text, action.preferStructured));
    case 'pasteStructured':
      return withHistory(currentState, (active) => pasteBelow(active, action.text, true));
    case 'startEditing':
      return startEditing(currentState, action.placement ?? 'current');
    case 'updateDraft':
      return updateDraft(currentState, action.text);
    case 'commitEdit':
      return withHistory(currentState, (active) => commitEdit(active, action.text, action.cursor));
    case 'cycleStatuses':
      return withHistory(currentState, cycleSelectedStatuses);
    case 'indent':
      return withHistory(currentState, indentSelection);
    case 'outdent':
      return withHistory(currentState, outdentSelection);
    case 'moveSelection':
      return withHistory(currentState, (active) => moveSelection(active, action.direction));
    case 'openAbove':
      return withHistory(currentState, openAbove);
    case 'openBelow':
      return withHistory(currentState, openBelow);
    case 'splitNodeAtCursor':
      return withHistory(currentState, (active) =>
        splitNodeAtCursor(active, action.selectionStart, action.selectionEnd),
      );
    case 'mergeWithPreviousAtCursorStart':
      return withHistory(currentState, mergeWithPreviousAtCursorStart);
    case 'deleteSelection':
      return withHistory(currentState, deleteSelection);
    case 'selectJournal':
      return withHistory(currentState, selectJournal);
    case 'selectJournalPage':
      return withHistory(currentState, active => selectJournalPage(active, action.pageId));
    case 'selectNote':
      return withHistory(currentState, active => selectNote(active, action.pageId));
    case 'deleteNote':
      return withHistory(currentState, (active) => deleteNotePage(active, action.pageId));
    case 'openSearch':
      return withHistory(currentState, openSearchView);
    case 'openTodos':
      return withHistory(currentState, openTodosView);
    case 'openSettings':
      return withHistory(currentState, openSettingsView);
    case 'openAI':
      return withHistory(currentState, openAIView);
    case 'openDirectory':
      return withHistory(currentState, openDirectoryView);
    case 'openPomodoro':
      return withHistory(currentState, openPomodoroView);
    case 'createNote':
      return withHistory(currentState, (active) => createNotePage(active, action.title, action.directoryId ?? null));
    case 'createTodayJournal':
      return withHistory(currentState, createTodayJournalPage);
    case 'toggleNodeStatus':
      return withHistory(currentState, (active) => toggleNodeStatus(active, action.nodeId));
    case 'toggleVisualMode':
      return toggleVisualMode(currentState);
    case 'updatePageTitle':
      return withHistory(currentState, (active) => updatePageTitle(active, action.title));
    case 'evictPages': {
      const keep = (page: OutlineState['pages'][number]) => page.id === currentState.activePageId || !action.ids.has(page.id);
      return { ...currentState, pages: currentState.pages.filter(keep),
        documentHistory: Object.fromEntries(Object.entries(currentState.documentHistory ?? {}).filter(([id]) => id === currentState.activePageId || !action.ids.has(id))) };
    }
    case 'refreshPages': {
      const active = action.pages.find((page) => page.id === currentState.activePageId);
      if (active && (!currentState.editingId || active.nodes.some((node) => node.id === currentState.editingId))) {
        return { ...currentState, pages: action.pages, documentHistory: retainHistories(currentState, action.pages) };
      }
      return { ...hydratePages(currentState, action.pages), documentHistory: retainHistories(currentState, action.pages) };
    }
    case 'hydrate':
      logIdentityChange('hydrate pages', {
        source: action.source ?? 'unknown',
        pages: action.pages.filter((page) => page.backendId).map((page) => ({
          pageId: page.id,
          backendDocumentId: page.backendId,
          ids: getPageBackendBlockIds(page).slice(-12),
          count: getPageBackendBlockIds(page).length,
        })),
      });
      return { ...hydratePages(currentState, action.pages), documentHistory: retainHistories(currentState, action.pages) };
    case 'mergeRemotePage':
      {
        const previousPage = currentState.pages.find((entry) => entry.id === action.previousPageId)
          ?? (action.page.backendId ? currentState.pages.find((entry) => entry.backendId === action.page.backendId) : null)
          ?? currentState.pages.find((entry) => entry.id === action.page.id)
          ?? null;
        const previousIds = previousPage ? getPageBackendBlockIds(previousPage) : [];
        const nextIds = getPageBackendBlockIds(action.page);
        logIdentityChange('mergeRemotePage', {
          source: action.source ?? 'unknown',
          pageId: action.page.id,
          previousPageId: action.previousPageId ?? null,
          backendDocumentId: action.page.backendId ?? previousPage?.backendId ?? null,
          previousCount: previousIds.length,
          nextCount: nextIds.length,
          previousTail: previousIds.slice(-12),
          nextTail: nextIds.slice(-12),
          removed: previousIds.filter((id) => !nextIds.includes(id)).slice(-12),
          added: nextIds.filter((id) => !previousIds.includes(id)).slice(-12),
        });
         const merged = mergeRemotePage(currentState, action.page, action.previousPageId);
         // Autosave may commit the active draft before insert mode ends. Keep
         // that content boundary undoable even when the later commit is a no-op.
         return action.acknowledged ? rememberEdit(currentState, merged)
           : { ...merged, documentHistory: retainHistories(currentState, merged.pages) };
      }
    case 'syncRemoteTodo': {
      const next = syncRemoteTodoToPage(currentState, action.sourceDocumentId, action.sourceBlockId, action.todoId, action.status, action.updatedAt);
      return next === currentState ? next : { ...next, documentHistory: retainHistories(currentState, next.pages) };
    }
    case 'undo': return undoDocument(currentState);
    default:
      return currentState;
  }
}

export function useOutlineState() {
  return useReducer(reduceOutlineState, initialState);
}
