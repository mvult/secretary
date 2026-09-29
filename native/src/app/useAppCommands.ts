import { useCallback, useMemo, useRef, useState, type Dispatch } from 'react';
import type { BackendTodo } from '../lib/backend';
import { findDocumentLinkAtCursor } from '../features/outline/documentLinks';
import type { OutlineAction } from '../features/outline/state';
import type { OutlinePage, OutlineState } from '../features/outline/types';
import { getPageTitle } from '../features/outline/tree';
import { JUMPLIST_LIMIT, type DirectoryEntry, type JumpLocation } from './types';

interface UseAppCommandsOptions {
  availablePages?: OutlinePage[];
  ensurePageLoaded?: (id: string) => Promise<OutlinePage>;
  state: OutlineState;
  stateRef: React.MutableRefObject<OutlineState>;
  dispatch: Dispatch<OutlineAction>;
  dispatchAfterFlush: (action: OutlineAction) => void;
  runTodoCommand: (operation: 'repository' | 'pull', documentId?: number) => Promise<{ movedCount: number; pulledCount: number; documentId: number }>;
  deleteNote: (pageId: string) => Promise<void>;
  backendUrl: string;
  authToken: string;
  workspaceId: number | null;
  syncEnabled: boolean;
  setSyncMessage: Dispatch<React.SetStateAction<string>>;
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
  availablePages,
  ensurePageLoaded,
  state,
  stateRef,
  dispatch,
  dispatchAfterFlush,
  runTodoCommand,
  deleteNote,
  backendUrl,
  authToken,
  workspaceId,
  syncEnabled,
  setSyncMessage,
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

  const jumpTicket = useRef(0);
  const navigateToJumpLocation = useCallback(async (location: JumpLocation | null) => {
    if (!location) {
      return;
    }

    const ticket = ++jumpTicket.current;
    const originPage = stateRef.current.activePageId;
    const originView = stateRef.current.activeView;
    let targetPage = stateRef.current.pages.find((entry) => entry.id === location.pageId) ?? null;
    if (!targetPage && ensurePageLoaded) {
      try { targetPage = await ensurePageLoaded(location.pageId); }
      catch (error) { setSyncMessage(error instanceof Error ? error.message : 'Document load failed.'); return; }
      if (ticket !== jumpTicket.current || stateRef.current.activePageId !== originPage || stateRef.current.activeView !== originView) return;
    }
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
  }, [dispatch, dispatchAfterFlush, stateRef, ensurePageLoaded, setSyncMessage]);

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

  const navigationTicket = useRef(0);
  const navigateToPage = useCallback(async (targetPage: OutlinePage, options?: { focusNodeId?: string; recordJump?: boolean; blockId?: number }) => {
    const ticket = ++navigationTicket.current;
    const originView = stateRef.current.activeView;
    const originPage = stateRef.current.activePageId;
    try {
      if (ensurePageLoaded) targetPage = await ensurePageLoaded(targetPage.id);
      if (ticket !== navigationTicket.current || stateRef.current.activeView !== originView || stateRef.current.activePageId !== originPage) return;
    } catch (error) {
      if (ticket === navigationTicket.current) setSyncMessage(error instanceof Error ? error.message : 'Document load failed.');
      return;
    }
    if (options?.blockId) options = { ...options, focusNodeId: targetPage.nodes.find(node => node.backendId === options?.blockId)?.id };
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
  }, [dispatch, dispatchAfterFlush, getCurrentJumpLocation, pushJumpBack, stateRef, ensurePageLoaded, setSyncMessage]);

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
    const targetPage = (availablePages ?? state.pages).find((entry) => entry.id === pageId) ?? (activeSearchMatch?.id === pageId ? activeSearchMatch : null);
    if (targetPage) {
      navigateToPage(targetPage, { recordJump: true });
    } else if (ensurePageLoaded) {
      void ensurePageLoaded(pageId).then(page => {
        if (stateRef.current.activeView === 'search') void navigateToPage(page, { recordJump: true });
      }).catch(error => setSyncMessage(error instanceof Error ? error.message : 'Document load failed.'));
    }
    resetSearch();
  }, [navigateToPage, resetSearch, state.pages, availablePages, activeSearchMatch, ensurePageLoaded, stateRef, setSyncMessage]);

  const openJournalPage = useCallback((pageId: string, options?: { recordJump?: boolean }) => {
    const targetPage = (availablePages ?? stateRef.current.pages).find((entry) => entry.id === pageId && entry.kind === 'journal') ?? null;
    if (!targetPage) {
      return;
    }
    navigateToPage(targetPage, { recordJump: options?.recordJump });
  }, [navigateToPage, stateRef, availablePages]);

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
    const targetPage = (availablePages ?? stateRef.current.pages).find((entry) => entry.backendId === targetDocumentId) ?? null;
    if (!targetPage) {
      setSyncMessage('Linked document is not loaded locally yet. Sync to refresh documents.');
      return;
    }
    navigateToPage(targetPage, { recordJump: true });
  }, [navigateToPage, setSyncMessage, stateRef, availablePages]);

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
    const sourcePage = (availablePages ?? state.pages).find((entry) => entry.backendId === documentId);
    if (!sourcePage) {
      setSyncMessage('Source page is not loaded locally yet. Sync to refresh documents.');
      return;
    }

    if (!blockId) {
      navigateToPage(sourcePage, { recordJump: true });
      return;
    }

    const node = sourcePage.nodes.find((entry) => entry.backendId === blockId || entry.todoId === todo.id);
    navigateToPage(sourcePage, { focusNodeId: node?.id, blockId, recordJump: true });
  }, [navigateToPage, setSyncMessage, state.pages, availablePages]);

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

    void deleteNote(pendingDeleteNote.id).then(() => {
      setSyncMessage(`Deleted ${pendingDeleteNote.title}.`);
    }).catch((error) => setSyncMessage(error instanceof Error ? error.message : 'Delete failed.'));
  }, [deleteNote, pendingDeleteNote, setSyncMessage, syncEnabled]);

  const moveCurrentDocumentTodosToRepository = useCallback(() => {
    const page = currentPage;
    if (!syncEnabled || !authToken || !page?.backendId) {
      setSyncMessage('Sync this document before moving todos to the repository.');
      return;
    }

    void (async () => {
      try {
        const { movedCount } = await runTodoCommand('repository', page.backendId!);
        await refreshTodos();
        setSyncMessage(`Moved ${movedCount} todo${movedCount === 1 ? '' : 's'} to the repository.`);
      } catch (error) {
        setSyncMessage(error instanceof Error ? error.message : 'Move todos failed.');
      }
    })();
  }, [authToken, backendUrl, currentPage, runTodoCommand, refreshTodos, setSyncMessage, syncEnabled]);

  const pullOnDeckTodosIntoToday = useCallback(() => {
    if (!syncEnabled || !authToken || !workspaceId) {
      setSyncMessage('Sync a workspace before pulling on-deck todos.');
      return;
    }

    void (async () => {
      try {
        const result = await runTodoCommand('pull');
        await refreshTodos();
        const todayPage = stateRef.current.pages.find((entry) => entry.backendId === result.documentId)
          ?? (result.documentId && ensurePageLoaded ? await ensurePageLoaded(`document-${result.documentId}`) : null);
        if (todayPage) {
          navigateToPage(todayPage, { recordJump: true });
        }
        setSyncMessage(`Pulled ${result.pulledCount} on-deck todo${result.pulledCount === 1 ? '' : 's'} into today's journal.`);
      } catch (error) {
        setSyncMessage(error instanceof Error ? error.message : 'Pull on-deck todos failed.');
      }
    })();
  }, [authToken, backendUrl, runTodoCommand, navigateToPage, refreshTodos, setSyncMessage, stateRef, syncEnabled, workspaceId, ensurePageLoaded]);

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
