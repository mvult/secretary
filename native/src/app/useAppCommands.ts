import { useCallback, useMemo, useRef, useState, type Dispatch } from 'react';
import { deleteDocument, moveDocumentTodosToRepository, pullOnDeckTodosToToday, type BackendTodo } from '../lib/backend';
import { findDocumentLinkAtCursor } from '../features/outline/documentLinks';
import type { OutlineAction } from '../features/outline/state';
import type { OutlinePage, OutlineState } from '../features/outline/types';
import { getPageTitle } from '../features/outline/tree';
import { JUMPLIST_LIMIT, type DirectoryEntry, type JumpLocation } from './types';

interface UseAppCommandsOptions {
  state: OutlineState;
  stateRef: React.MutableRefObject<OutlineState>;
  dispatch: Dispatch<OutlineAction>;
  dispatchAfterFlush: (action: OutlineAction) => void;
  flushDirtyPages: () => Promise<void>;
  backendUrl: string;
  authToken: string;
  workspaceId: number | null;
  syncEnabled: boolean;
  setSyncMessage: Dispatch<React.SetStateAction<string>>;
  runSync: () => Promise<void>;
  refreshTodos: () => Promise<void>;
  resetSearch: () => void;
  searchQuery: string;
  activeSearchMatch: OutlinePage | null;
  setSearchMode: Dispatch<React.SetStateAction<'insert' | 'select'>>;
  setActiveSearchResultId: Dispatch<React.SetStateAction<string | null>>;
  openDocumentLinkPicker: () => void;
  closeDocumentLinkPicker: () => void;
  setActiveDirectoryId: Dispatch<React.SetStateAction<number | null>>;
  setActiveDirectoryEntryKey: Dispatch<React.SetStateAction<string | null>>;
  currentPage: OutlinePage | null;
}

export function useAppCommands({
  state,
  stateRef,
  dispatch,
  dispatchAfterFlush,
  flushDirtyPages,
  backendUrl,
  authToken,
  workspaceId,
  syncEnabled,
  setSyncMessage,
  runSync,
  refreshTodos,
  resetSearch,
  searchQuery,
  activeSearchMatch,
  setSearchMode,
  setActiveSearchResultId,
  openDocumentLinkPicker,
  closeDocumentLinkPicker,
  setActiveDirectoryId,
  setActiveDirectoryEntryKey,
  currentPage,
}: UseAppCommandsOptions) {
  const [pendingDeleteNoteId, setPendingDeleteNoteId] = useState<string | null>(null);
  const jumpBackRef = useRef<JumpLocation[]>([]);
  const jumpForwardRef = useRef<JumpLocation[]>([]);

  const activeNotePage = currentPage?.kind === 'note' ? currentPage : null;
  const canDeleteNote = state.activeView === 'note' && activeNotePage !== null;
  const pendingDeleteNote = useMemo(
    () => pendingDeleteNoteId
      ? state.pages.find((entry) => entry.id === pendingDeleteNoteId && entry.kind === 'note') ?? null
      : null,
    [pendingDeleteNoteId, state.pages],
  );

  const getCurrentJumpLocation = useCallback((): JumpLocation | null => {
    const page = stateRef.current.pages.find((entry) => entry.id === stateRef.current.activePageId) ?? null;
    if (!page) {
      return null;
    }
    return {
      pageId: page.id,
      focusedId: page.nodes.some((entry) => entry.id === stateRef.current.focusedId)
        ? stateRef.current.focusedId
        : page.nodes[0]?.id ?? '',
    };
  }, [stateRef]);

  const pushJumpBack = useCallback((location: JumpLocation | null) => {
    if (!location) {
      return;
    }
    const current = jumpBackRef.current;
    const previous = current[current.length - 1];
    if (previous?.pageId === location.pageId && previous.focusedId === location.focusedId) {
      return;
    }
    jumpBackRef.current = [...current.slice(-(JUMPLIST_LIMIT - 1)), location];
  }, []);

  const navigateToJumpLocation = useCallback((location: JumpLocation | null) => {
    if (!location) {
      return;
    }

    const targetPage = stateRef.current.pages.find((entry) => entry.id === location.pageId) ?? null;
    if (!targetPage) {
      return;
    }

    if (targetPage.kind === 'note') {
      dispatchAfterFlush({ type: 'selectNote', pageId: targetPage.id });
    } else {
      dispatchAfterFlush({ type: 'selectJournalPage', pageId: targetPage.id });
    }

    window.setTimeout(() => {
      const focusedNode = stateRef.current.pages
        .find((entry) => entry.id === location.pageId)
        ?.nodes.find((entry) => entry.id === location.focusedId);
      if (!focusedNode) {
        return;
      }
      dispatch({ type: 'focus', nodeId: focusedNode.id });
      document.querySelector<HTMLElement>(`[data-node-id="${focusedNode.id}"]`)?.scrollIntoView({ block: 'center' });
    }, 0);
  }, [dispatch, dispatchAfterFlush, stateRef]);

  const jumpBack = useCallback(() => {
    const destination = jumpBackRef.current[jumpBackRef.current.length - 1] ?? null;
    if (!destination) {
      return;
    }
    const current = getCurrentJumpLocation();
    jumpBackRef.current = jumpBackRef.current.slice(0, -1);
    if (current) {
      jumpForwardRef.current = [...jumpForwardRef.current.slice(-(JUMPLIST_LIMIT - 1)), current];
    }
    navigateToJumpLocation(destination);
  }, [getCurrentJumpLocation, navigateToJumpLocation]);

  const jumpForward = useCallback(() => {
    const destination = jumpForwardRef.current[jumpForwardRef.current.length - 1] ?? null;
    if (!destination) {
      return;
    }
    const current = getCurrentJumpLocation();
    jumpForwardRef.current = jumpForwardRef.current.slice(0, -1);
    if (current) {
      pushJumpBack(current);
    }
    navigateToJumpLocation(destination);
  }, [getCurrentJumpLocation, navigateToJumpLocation, pushJumpBack]);

  const navigateToPage = useCallback((targetPage: OutlinePage, options?: { focusNodeId?: string; recordJump?: boolean }) => {
    if (options?.recordJump) {
      pushJumpBack(getCurrentJumpLocation());
      jumpForwardRef.current = [];
    }

    if (targetPage.kind === 'note') {
      dispatchAfterFlush({ type: 'selectNote', pageId: targetPage.id });
    } else {
      dispatchAfterFlush({ type: 'selectJournalPage', pageId: targetPage.id });
    }

    if (!options?.focusNodeId) {
      return;
    }

    window.setTimeout(() => {
      const node = stateRef.current.pages
        .find((entry) => entry.id === targetPage.id)
        ?.nodes.find((entry) => entry.id === options.focusNodeId);
      if (!node) {
        return;
      }
      dispatch({ type: 'focus', nodeId: node.id });
      document.querySelector<HTMLElement>(`[data-node-id="${node.id}"]`)?.scrollIntoView({ block: 'center' });
    }, 0);
  }, [dispatch, dispatchAfterFlush, getCurrentJumpLocation, pushJumpBack, stateRef]);

  const openDirectoryBrowser = useCallback(() => {
    const activeNote = currentPage?.kind === 'note' ? currentPage : null;
    setActiveDirectoryId(activeNote?.directoryId ?? null);
    setActiveDirectoryEntryKey(activeNote ? `note-${activeNote.id}` : null);
    dispatchAfterFlush({ type: 'openDirectory' });
  }, [currentPage, dispatchAfterFlush, setActiveDirectoryEntryKey, setActiveDirectoryId]);

  const openDirectoryEntry = useCallback((entry: DirectoryEntry | null) => {
    if (!entry) {
      return;
    }
    if (entry.kind === 'directory') {
      setActiveDirectoryId(entry.directory?.id ?? null);
      setActiveDirectoryEntryKey(null);
      return;
    }
    if (entry.page) {
      navigateToPage(entry.page, { recordJump: true });
    }
  }, [navigateToPage, setActiveDirectoryEntryKey, setActiveDirectoryId]);

  const openSearchResult = useCallback((pageId: string) => {
    const targetPage = state.pages.find((entry) => entry.id === pageId) ?? null;
    if (targetPage) {
      navigateToPage(targetPage, { recordJump: true });
    }
    resetSearch();
  }, [navigateToPage, resetSearch, state.pages]);

  const openJournalPage = useCallback((pageId: string, options?: { recordJump?: boolean }) => {
    const targetPage = stateRef.current.pages.find((entry) => entry.id === pageId && entry.kind === 'journal') ?? null;
    if (!targetPage) {
      return;
    }
    navigateToPage(targetPage, { recordJump: options?.recordJump });
  }, [navigateToPage, stateRef]);

  const openTodayJournal = useCallback(() => {
    pushJumpBack(getCurrentJumpLocation());
    jumpForwardRef.current = [];
    dispatchAfterFlush({ type: 'selectJournal' });
  }, [dispatchAfterFlush, getCurrentJumpLocation, pushJumpBack]);

  const submitSearch = useCallback(() => {
    const nextTitle = searchQuery.trim();
    if (activeSearchMatch) {
      openSearchResult(activeSearchMatch.id);
      return;
    }

    if (!nextTitle) {
      return;
    }

    dispatch({ type: 'createNote', title: nextTitle });
    resetSearch();
  }, [activeSearchMatch, dispatch, openSearchResult, resetSearch, searchQuery]);

  const openDocumentLinkTarget = useCallback((targetDocumentId: number) => {
    const targetPage = stateRef.current.pages.find((entry) => entry.backendId === targetDocumentId) ?? null;
    if (!targetPage) {
      setSyncMessage('Linked document is not loaded locally yet. Sync to refresh documents.');
      return;
    }
    navigateToPage(targetPage, { recordJump: true });
  }, [navigateToPage, setSyncMessage, stateRef]);

  const insertDocumentLink = useCallback((targetPage: OutlinePage | null) => {
    if (!targetPage || !targetPage.backendId) {
      return;
    }

    dispatch({ type: 'insertTextAtCursor', text: `[[doc:${targetPage.backendId}|${getPageTitle(targetPage)}]]` });
    closeDocumentLinkPicker();
  }, [closeDocumentLinkPicker, dispatch]);

  const followDocumentLink = useCallback(() => {
    const page = stateRef.current.pages.find((entry) => entry.id === stateRef.current.activePageId) ?? null;
    const node = page?.nodes.find((entry) => entry.id === stateRef.current.focusedId) ?? null;
    if (!node) {
      return;
    }

    const link = findDocumentLinkAtCursor(node.text, stateRef.current.normalCursor);
    if (!link) {
      setSyncMessage('No document link under cursor.');
      return;
    }

    openDocumentLinkTarget(link.targetDocumentId);
  }, [openDocumentLinkTarget, setSyncMessage, stateRef]);

  const openTodoSource = useCallback((todo: BackendTodo) => {
    const documentId = todo.currentDocumentId || todo.sourceDocumentId;
    const blockId = todo.currentBlockId || todo.sourceBlockId;
    if (!documentId) {
      if (todo.createdAtRecordingName) {
        setSyncMessage('Opening recording sources is not available yet in the native app.');
      }
      return;
    }
    const sourcePage = state.pages.find((entry) => entry.backendId === documentId);
    if (!sourcePage) {
      setSyncMessage('Source page is not loaded locally yet. Sync to refresh documents.');
      return;
    }

    if (!blockId) {
      navigateToPage(sourcePage, { recordJump: true });
      return;
    }

    const node = sourcePage.nodes.find((entry) => entry.backendId === blockId || entry.todoId === todo.id);
    navigateToPage(sourcePage, { focusNodeId: node?.id, recordJump: true });
  }, [navigateToPage, setSyncMessage, state.pages]);

  const handleDeleteNote = useCallback(() => {
    if (!activeNotePage || state.activeView !== 'note') {
      setSyncMessage('Open a note to delete it.');
      return;
    }
    setPendingDeleteNoteId(activeNotePage.id);
  }, [activeNotePage, setSyncMessage, state.activeView]);

  const confirmDeleteNote = useCallback(() => {
    if (!pendingDeleteNote) {
      setPendingDeleteNoteId(null);
      return;
    }

    setPendingDeleteNoteId(null);

    if (pendingDeleteNote.backendId && !syncEnabled) {
      setSyncMessage('Connect to the workspace before deleting a server note.');
      return;
    }

    if (pendingDeleteNote.backendId && syncEnabled) {
      void (async () => {
        try {
          await flushDirtyPages();
          await deleteDocument(backendUrl, authToken, pendingDeleteNote.backendId!);
          dispatch({ type: 'deleteNote', pageId: pendingDeleteNote.id });
          setSyncMessage(`Deleted ${pendingDeleteNote.title}.`);
        } catch (error) {
          setSyncMessage(error instanceof Error ? error.message : 'Delete failed.');
        }
      })();
      return;
    }

    dispatch({ type: 'deleteNote', pageId: pendingDeleteNote.id });
    setSyncMessage(`Deleted ${pendingDeleteNote.title}.`);
  }, [authToken, backendUrl, dispatch, flushDirtyPages, pendingDeleteNote, setSyncMessage, syncEnabled]);

  const moveCurrentDocumentTodosToRepository = useCallback(() => {
    const page = currentPage;
    if (!syncEnabled || !authToken || !page?.backendId) {
      setSyncMessage('Sync this document before moving todos to the repository.');
      return;
    }

    void (async () => {
      try {
        await flushDirtyPages();
        const movedCount = await moveDocumentTodosToRepository(backendUrl, authToken, page.backendId!);
        await runSync();
        await refreshTodos();
        setSyncMessage(`Moved ${movedCount} todo${movedCount === 1 ? '' : 's'} to the repository.`);
      } catch (error) {
        setSyncMessage(error instanceof Error ? error.message : 'Move todos failed.');
      }
    })();
  }, [authToken, backendUrl, currentPage, flushDirtyPages, refreshTodos, runSync, setSyncMessage, syncEnabled]);

  const pullOnDeckTodosIntoToday = useCallback(() => {
    if (!syncEnabled || !authToken || !workspaceId) {
      setSyncMessage('Sync a workspace before pulling on-deck todos.');
      return;
    }

    void (async () => {
      try {
        await flushDirtyPages();
        const result = await pullOnDeckTodosToToday(backendUrl, authToken, workspaceId);
        await runSync();
        await refreshTodos();
        const todayPage = stateRef.current.pages.find((entry) => entry.backendId === result.documentId) ?? null;
        if (todayPage) {
          navigateToPage(todayPage, { recordJump: true });
        }
        setSyncMessage(`Pulled ${result.pulledCount} on-deck todo${result.pulledCount === 1 ? '' : 's'} into today's journal.`);
      } catch (error) {
        setSyncMessage(error instanceof Error ? error.message : 'Pull on-deck todos failed.');
      }
    })();
  }, [authToken, backendUrl, flushDirtyPages, navigateToPage, refreshTodos, runSync, setSyncMessage, stateRef, syncEnabled, workspaceId]);

  const resetSearchView = useCallback(() => {
    resetSearch();
    setSearchMode('insert');
    setActiveSearchResultId(null);
  }, [resetSearch, setActiveSearchResultId, setSearchMode]);

  return {
    jumpBack,
    jumpForward,
    navigateToPage,
    openJournalPage,
    openTodayJournal,
    openDirectoryBrowser,
    openDirectoryEntry,
    openSearchResult,
    submitSearch,
    openDocumentLinkPicker,
    openDocumentLinkTarget,
    insertDocumentLink,
    followDocumentLink,
    openTodoSource,
    handleDeleteNote,
    confirmDeleteNote,
    moveCurrentDocumentTodosToRepository,
    pullOnDeckTodosIntoToday,
    pendingDeleteNote,
    pendingDeleteNoteId,
    setPendingDeleteNoteId,
    canDeleteNote,
    resetSearchView,
  };
}
