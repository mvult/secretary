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
  | { type: 'createNote'; title?: string }
  | { type: 'createTodayJournal' }
  | { type: 'toggleNodeStatus'; nodeId: string }
  | { type: 'toggleVisualMode' }
  | { type: 'updatePageTitle'; title: string }
  | { type: 'hydrate'; pages: OutlineState['pages'] }
  | { type: 'mergeRemotePage'; page: OutlineState['pages'][number]; previousPageId?: string }
  | { type: 'undo' };

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
  if (nextState === state) {
    return state;
  }

  return {
    ...nextState,
    history: [...state.history, makeSnapshot(state)],
  };
}

export function reduceOutlineState(state: OutlineState, action: OutlineAction): OutlineState {
  const currentState = state;

  switch (action.type) {
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
    case 'createNote':
      return withHistory(currentState, (active) => createNotePage(active, action.title));
    case 'createTodayJournal':
      return withHistory(currentState, createTodayJournalPage);
    case 'toggleNodeStatus':
      return withHistory(currentState, (active) => toggleNodeStatus(active, action.nodeId));
    case 'toggleVisualMode':
      return toggleVisualMode(currentState);
    case 'updatePageTitle':
      return withHistory(currentState, (active) => updatePageTitle(active, action.title));
    case 'hydrate':
      return hydratePages(currentState, action.pages);
    case 'mergeRemotePage':
      return mergeRemotePage(currentState, action.page, action.previousPageId);
    case 'undo': {
      const previous = currentState.history[currentState.history.length - 1];
      if (!previous) {
        return currentState;
      }

      const restored = restoreSnapshot(currentState, previous);
      return {
        ...restored,
        history: currentState.history.slice(0, -1),
      };
    }
    default:
      return currentState;
  }
}

export function useOutlineState() {
  return useReducer(reduceOutlineState, initialState);
}
