import { useReducer } from 'react';
import {
  commitEdit,
  createNotePage,
  createTodayJournalPage,
  cycleSelectedStatuses,
  deleteSelection,
  focusNode,
  indentSelection,
  jumpFocusInPage,
  hydratePages,
  makeSnapshot,
  mergeRemotePage,
  moveCaret,
  moveFocus,
  moveSelection,
  pasteBelow,
  openSearchView,
  openSettingsView,
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
  | { type: 'yankLine' }
  | { type: 'pasteBelow'; text?: string }
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
  | { type: 'deleteSelection' }
  | { type: 'selectJournal' }
  | { type: 'selectJournalPage'; pageId: string }
  | { type: 'selectNote'; pageId: string }
  | { type: 'openSearch' }
  | { type: 'openSettings' }
  | { type: 'createNote'; title?: string }
  | { type: 'createTodayJournal' }
  | { type: 'toggleNodeStatus'; nodeId: string }
  | { type: 'updatePageTitle'; title: string }
  | { type: 'hydrate'; pages: OutlineState['pages'] }
  | { type: 'mergeRemotePage'; page: OutlineState['pages'][number] }
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

function reducer(state: OutlineState, action: OutlineAction): OutlineState {
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
    case 'yankLine':
      return yankLine(currentState);
    case 'pasteBelow':
      return withHistory(currentState, (active) => pasteBelow(active, action.text));
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
    case 'deleteSelection':
      return withHistory(currentState, deleteSelection);
    case 'selectJournal':
      return selectJournal(currentState);
    case 'selectJournalPage':
      return selectJournalPage(currentState, action.pageId);
    case 'selectNote':
      return selectNote(currentState, action.pageId);
    case 'openSearch':
      return openSearchView(currentState);
    case 'openSettings':
      return openSettingsView(currentState);
    case 'createNote':
      return withHistory(currentState, (active) => createNotePage(active, action.title));
    case 'createTodayJournal':
      return withHistory(currentState, createTodayJournalPage);
    case 'toggleNodeStatus':
      return withHistory(currentState, (active) => toggleNodeStatus(active, action.nodeId));
    case 'updatePageTitle':
      return withHistory(currentState, (active) => updatePageTitle(active, action.title));
    case 'hydrate':
      return hydratePages(currentState, action.pages);
    case 'mergeRemotePage':
      return mergeRemotePage(currentState, action.page);
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
  return useReducer(reducer, initialState);
}
