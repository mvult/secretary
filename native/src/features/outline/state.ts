import { useReducer } from 'react';
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
  makeSnapshot,
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
  restoreSnapshot,
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

export type OutlineAction =
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
  | { type: 'mergeRemotePage'; page: OutlineState['pages'][number]; previousPageId?: string; source?: string }
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
  history: [],
};

function withHistory(state: OutlineState, updater: (current: OutlineState) => OutlineState): OutlineState {
  const nextState = updater(state);
  if (nextState === state || sameEditablePages(state.pages, nextState.pages)) {
    return nextState;
  }

  return {
    ...nextState,
    history: [...state.history, makeSnapshot(state)],
  };
}

// Focus, cursor, editor mode, and server bookkeeping are not undoable edits.
function sameEditablePages(left: OutlineState['pages'], right: OutlineState['pages']) {
  if (left === right) return true;
  return left.length === right.length && left.every((page, index) => {
    const other = right[index];
    return page.id === other.id && page.kind === other.kind && page.date === other.date
      && page.title === other.title && page.directoryId === other.directoryId
      && page.nodes.length === other.nodes.length && page.nodes.every((node, nodeIndex) => {
        const next = other.nodes[nodeIndex];
        return node.id === next.id && node.parentId === next.parentId && node.text === next.text
          && (node.todoStatus || '') === (next.todoStatus || '');
      });
  });
}

export function reduceOutlineState(state: OutlineState, action: OutlineAction): OutlineState {
  const currentState = state;

  switch (action.type) {
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
      return selectJournal(currentState);
    case 'selectJournalPage':
      return selectJournalPage(currentState, action.pageId);
    case 'selectNote':
      return selectNote(currentState, action.pageId);
    case 'deleteNote':
      return withHistory(currentState, (active) => deleteNotePage(active, action.pageId));
    case 'openSearch':
      return openSearchView(currentState);
    case 'openTodos':
      return openTodosView(currentState);
    case 'openSettings':
      return openSettingsView(currentState);
    case 'openAI':
      return openAIView(currentState);
    case 'openDirectory':
      return openDirectoryView(currentState);
    case 'openPomodoro':
      return openPomodoroView(currentState);
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
    case 'refreshPages': {
      const active = action.pages.find((page) => page.id === currentState.activePageId);
      if (active && (!currentState.editingId || active.nodes.some((node) => node.id === currentState.editingId))) {
        return { ...currentState, pages: action.pages, history: [] };
      }
      return hydratePages(currentState, action.pages);
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
      return hydratePages(currentState, action.pages);
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
        return mergeRemotePage(currentState, action.page, action.previousPageId);
      }
    case 'syncRemoteTodo':
      return syncRemoteTodoToPage(currentState, action.sourceDocumentId, action.sourceBlockId, action.todoId, action.status, action.updatedAt);
    case 'undo': {
      // Also skip no-op entries retained by a live app from the older implementation.
      let index = currentState.history.length - 1;
      while (index >= 0 && sameEditablePages(currentState.pages, currentState.history[index].pages)) index--;
      const previous = currentState.history[index];
      if (!previous) {
        return currentState.history.length ? { ...currentState, history: [] } : currentState;
      }

      const restored = restoreSnapshot(currentState, previous);
      return {
        ...restored,
        // The snapshot's pages contain the pre-edit text. Its draft buffer may
        // already contain the later edit; reopening it would hide the undo.
        editingId: null,
        draftText: '',
        mode: 'normal',
        anchorId: null,
        history: currentState.history.slice(0, index),
      };
    }
    default:
      return currentState;
  }
}

export function useOutlineState() {
  return useReducer(reduceOutlineState, initialState);
}
