import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentPage, getJournalPage, getJournalPages } from './features/outline/tree';
import { useOutlineState } from './features/outline/state';
import { useSessionSync } from './features/session/useSessionSync';
import { useSearchView } from './features/search/useSearchView';
import { useDocumentLinkPicker } from './features/document-links/useDocumentLinkPicker';
import { useTodos } from './features/todos/useTodos';
import { useAIThreads } from './features/ai/useAIThreads';
import { useDirectoryBrowser } from './features/directory/useDirectoryBrowser';
import { useAppCommands } from './app/useAppCommands';
import { useGlobalHotkeys } from './app/useGlobalHotkeys';
import { ToolbarMenu } from './app/ToolbarMenu';
import { DeleteNoteDialog } from './app/DeleteNoteDialog';
import { DocumentLinkDialog } from './features/document-links/DocumentLinkDialog';
import { JournalsView } from './features/journals/JournalsView';
import { NoteView } from './features/notes/NoteView';
import { DirectoryView } from './features/directory/DirectoryView';
import { SearchView } from './features/search/SearchView';
import { TodosView } from './features/todos/TodosView';
import { AIView } from './features/ai/AIView';
import { SettingsView } from './features/settings/SettingsView';
import { NoteHistoryDialog } from './features/history/NoteHistoryDialog';
import { getDocumentHistoryEntry, listDocumentHistory, type BackendDocumentHistoryEntry, type BackendTodo } from './lib/backend';

function App() {
  const [state, dispatch] = useOutlineState();
  const page = getCurrentPage(state);
  const journalPage = getJournalPage(state);
  const journals = getJournalPages(state);
  const refreshTodosRef = useRef<(() => Promise<void>) | null>(null);
  const [isToolbarMenuOpen, setIsToolbarMenuOpen] = useState(false);
  const [isNoteHistoryOpen, setIsNoteHistoryOpen] = useState(false);
  const [noteHistoryEntries, setNoteHistoryEntries] = useState<BackendDocumentHistoryEntry[]>([]);
  const [activeNoteHistoryId, setActiveNoteHistoryId] = useState<number | null>(null);
  const [activeNoteHistoryEntry, setActiveNoteHistoryEntry] = useState<BackendDocumentHistoryEntry | null>(null);
  const [isLoadingNoteHistory, setIsLoadingNoteHistory] = useState(false);
  const [isLoadingNoteHistoryEntry, setIsLoadingNoteHistoryEntry] = useState(false);
  const [noteHistoryError, setNoteHistoryError] = useState('');
  const toolbarMenuRef = useRef<HTMLDivElement | null>(null);
  const lastTodoGPressRef = useRef<number | null>(null);

  const session = useSessionSync({ state, dispatch, onPagesSavedRef: refreshTodosRef });

  const search = useSearchView(state);
  const documentLinks = useDocumentLinkPicker(state);

  const syncTodoIntoPages = useCallback((todo: BackendTodo) => {
    if (!todo.sourceDocumentId || !todo.sourceBlockId) {
      return;
    }
    const sourcePage = session.stateRef.current.pages.find((entry) => entry.backendId === todo.sourceDocumentId);
    if (!sourcePage) {
      return;
    }
    const node = sourcePage.nodes.find((entry) => entry.backendId === todo.sourceBlockId || entry.todoId === todo.id);
    if (!node || node.todoStatus === todo.status) {
      return;
    }
    dispatch({
      type: 'mergeRemotePage',
      page: {
        ...sourcePage,
        nodes: sourcePage.nodes.map((entry) => (
          entry.id === node.id
            ? { ...entry, todoStatus: todo.status, todoId: todo.id, updatedAt: todo.updatedAt || entry.updatedAt }
            : entry
        )),
      },
    });
  }, [dispatch, session.stateRef]);

  const todos = useTodos({
    backendUrl: session.backendUrl,
    authToken: session.authToken,
    userId: session.userId,
    syncMessageSetter: session.setSyncMessage,
    syncTodoIntoPages,
  });

  refreshTodosRef.current = async () => {
    await todos.loadTodoList();
  };

  const ai = useAIThreads({
    backendUrl: session.backendUrl,
    authToken: session.authToken,
    workspaceId: session.workspaceId,
    page,
    syncMessageSetter: session.setSyncMessage,
  });

  const directory = useDirectoryBrowser({
    state,
    stateRef: session.stateRef,
    dispatch,
    backendUrl: session.backendUrl,
    authToken: session.authToken,
    workspaceId: session.workspaceId,
    syncEnabled: session.syncEnabled,
    directories: session.directories,
    setDirectories: session.setDirectories,
    setSyncMessage: session.setSyncMessage,
  });

  const commands = useAppCommands({
    state,
    stateRef: session.stateRef,
    dispatch,
    dispatchAfterFlush: session.dispatchAfterFlush,
    flushDirtyPages: () => session.flushDirtyPages(),
    backendUrl: session.backendUrl,
    authToken: session.authToken,
    syncEnabled: session.syncEnabled,
    setSyncMessage: session.setSyncMessage,
    resetSearch: search.resetSearch,
    searchQuery: search.searchQuery,
    activeSearchMatch: search.activeSearchMatch,
    setSearchMode: search.setSearchMode,
    setActiveSearchResultId: search.setActiveSearchResultId,
    openDocumentLinkPicker: documentLinks.openDocumentLinkPicker,
    closeDocumentLinkPicker: documentLinks.closeDocumentLinkPicker,
    setActiveDirectoryId: directory.setActiveDirectoryId,
    setActiveDirectoryEntryKey: directory.setActiveDirectoryEntryKey,
    currentPage: page,
  });

  const handleLogout = useCallback(() => {
    todos.clearTodos();
    ai.clearAI();
    session.handleLogout();
  }, [ai.clearAI, session.handleLogout, todos.clearTodos]);

  useEffect(() => {
    if (state.activeView !== 'todos') {
      return;
    }
    void todos.loadTodoList();
  }, [state.activeView, todos.loadTodoList]);

  useEffect(() => {
    if (state.activeView !== 'ai') {
      return;
    }
    void ai.loadAIThreads();
  }, [ai.loadAIThreads, state.activeView]);

  useEffect(() => {
    if (!session.authToken) {
      todos.clearTodos();
      ai.clearAI();
    }
  }, [ai.clearAI, session.authToken, todos.clearTodos]);

  useEffect(() => {
    if (!isToolbarMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (toolbarMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      setIsToolbarMenuOpen(false);
    };

    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [isToolbarMenuOpen]);

  useEffect(() => {
    setIsToolbarMenuOpen(false);
  }, [state.activePageId, state.activeView]);

  useEffect(() => {
    if (!isNoteHistoryOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsNoteHistoryOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isNoteHistoryOpen]);

  useEffect(() => {
    if ((state.activeView !== 'note' && state.activeView !== 'journals') || !page?.backendId) {
      setIsNoteHistoryOpen(false);
      setNoteHistoryEntries([]);
      setActiveNoteHistoryId(null);
      setActiveNoteHistoryEntry(null);
      setNoteHistoryError('');
    }
  }, [page, state.activeView]);

  const openSettingsFromMenu = () => {
    setIsToolbarMenuOpen(false);
    session.dispatchAfterFlush({ type: 'openSettings' });
  };

  const openAIFromMenu = () => {
    setIsToolbarMenuOpen(false);
    session.dispatchAfterFlush({ type: 'openAI' });
  };

  const loadNoteHistoryEntry = useCallback(async (historyId: number) => {
    if (!session.authToken) {
      return;
    }
    setIsLoadingNoteHistoryEntry(true);
    setNoteHistoryError('');
    try {
      const entry = await getDocumentHistoryEntry(session.backendUrl, session.authToken, historyId);
      setActiveNoteHistoryEntry(entry);
      setActiveNoteHistoryId(entry.id);
    } catch (error) {
      setNoteHistoryError(error instanceof Error ? error.message : 'History entry load failed.');
    } finally {
      setIsLoadingNoteHistoryEntry(false);
    }
  }, [session.authToken, session.backendUrl]);

  const openHistoryFromMenu = useCallback(async () => {
    if (!page?.backendId || !session.authToken) {
      return;
    }
    setIsToolbarMenuOpen(false);
    setIsNoteHistoryOpen(true);
    setIsLoadingNoteHistory(true);
    setNoteHistoryError('');
    try {
      const entries = await listDocumentHistory(session.backendUrl, session.authToken, page.backendId);
      setNoteHistoryEntries(entries);
      const firstEntry = entries[0] ?? null;
      setActiveNoteHistoryId(firstEntry?.id ?? null);
      setActiveNoteHistoryEntry(firstEntry);
      if (firstEntry) {
        void loadNoteHistoryEntry(firstEntry.id);
      }
    } catch (error) {
      setNoteHistoryEntries([]);
      setActiveNoteHistoryId(null);
      setActiveNoteHistoryEntry(null);
      setNoteHistoryError(error instanceof Error ? error.message : 'History load failed.');
    } finally {
      setIsLoadingNoteHistory(false);
    }
  }, [loadNoteHistoryEntry, page, session.authToken, session.backendUrl]);

  const canOpenHistory = (state.activeView === 'note' || state.activeView === 'journals') && Boolean(page?.backendId && session.authToken);

  useGlobalHotkeys({
    state,
    isToolbarMenuOpen,
    setIsToolbarMenuOpen,
    pendingDeleteNoteId: commands.pendingDeleteNoteId,
    setPendingDeleteNoteId: commands.setPendingDeleteNoteId,
    isDocumentLinkPickerOpen: documentLinks.isDocumentLinkPickerOpen,
    closeDocumentLinkPicker: documentLinks.closeDocumentLinkPicker,
    resetSearchView: commands.resetSearchView,
    directoryPrompt: directory.directoryPrompt,
    setDirectoryPrompt: directory.setDirectoryPrompt,
    setDirectoryPromptValue: directory.setDirectoryPromptValue,
    submitDirectoryPrompt: directory.submitDirectoryPrompt,
    activeDirectoryEntry: directory.activeDirectoryEntry,
    directoryEntries: directory.directoryEntries,
    currentDirectory: directory.currentDirectory,
    enterDirectory: directory.enterDirectory,
    openCreateDirectoryPrompt: directory.openCreateDirectoryPrompt,
    renameDirectoryEntry: directory.renameDirectoryEntry,
    pasteClipboardHere: directory.pasteClipboardHere,
    clearPendingDirectoryMove: directory.clearPendingDirectoryMove,
    lastDirectoryDPressRef: directory.lastDirectoryDPressRef,
    pendingDirectoryMoveTimerRef: directory.pendingDirectoryMoveTimerRef,
    moveSelectedDirectoryToClipboard: directory.moveSelectedDirectoryToClipboard,
    deleteSelectedDirectory: directory.deleteSelectedDirectory,
    cutSelectedNoteToClipboard: directory.cutSelectedNoteToClipboard,
    copySelectedDirectoryToClipboard: directory.copySelectedDirectoryToClipboard,
    setActiveDirectoryEntryKey: directory.setActiveDirectoryEntryKey,
    openDirectoryEntry: commands.openDirectoryEntry,
    filteredTodos: todos.filteredTodos,
    activeTodo: todos.activeTodo,
    setActiveTodoId: todos.setActiveTodoId,
    lastTodoGPressRef,
    openTodoSource: commands.openTodoSource,
    handleTodoStatusChange: todos.handleTodoStatusChange,
    updatingTodoId: todos.updatingTodoId,
    aiThreads: ai.aiThreads,
    activeAIThread: ai.activeAIThread,
    setActiveAIThreadId: ai.setActiveAIThreadId,
    jumpBack: commands.jumpBack,
    jumpForward: commands.jumpForward,
    dispatchAfterFlush: session.dispatchAfterFlush,
    openDirectoryBrowser: commands.openDirectoryBrowser,
  });

  const pagesByBackendId = useMemo(
    () => new Map(state.pages.filter((entry) => entry.backendId).map((entry) => [entry.backendId!, entry])),
    [state.pages],
  );

  if (!page) {
    return (
      <main className="app-shell">
        <section className="page-shell" data-center-column={session.centerColumn} data-active-view={state.activeView}>
          <header className="workspace-toolbar">
            <ToolbarMenu
              isOpen={isToolbarMenuOpen}
              canDeleteNote={commands.canDeleteNote}
              canOpenHistory={false}
              menuRef={toolbarMenuRef}
              onToggle={() => setIsToolbarMenuOpen((current) => !current)}
              onDeleteNote={() => {
                setIsToolbarMenuOpen(false);
                commands.handleDeleteNote();
              }}
              onOpenHistory={() => undefined}
              onOpenAI={openAIFromMenu}
              onOpenSettings={openSettingsFromMenu}
            />
          </header>

          <div className="workspace-content" data-active-view={state.activeView}>
            {state.activeView === 'settings' ? (
              <SettingsView
                backendUrl={session.backendUrl}
                email={session.email}
                password={session.password}
                centerColumn={session.centerColumn}
                authToken={session.authToken}
                workspaceId={session.workspaceId}
                isSyncing={session.isSyncing}
                syncMessage={session.syncMessage}
                showCenterColumnToggle={false}
                showLogout={false}
                onChangeBackendUrl={(value) => {
                  session.setBackendUrl(value);
                  session.setSyncMessage('');
                }}
                onChangeEmail={(value) => {
                  session.setEmail(value);
                  session.setSyncMessage('');
                }}
                onChangePassword={(value) => {
                  session.setPassword(value);
                  session.setSyncMessage('');
                }}
                onChangeCenterColumn={session.setCenterColumn}
                onLogin={() => void session.runLogin()}
                onSync={() => void session.runSync()}
              />
            ) : state.activeView === 'ai' ? (
              <AIView
                pageTitle={null}
                authToken={session.authToken}
                workspaceId={session.workspaceId}
                aiThreads={ai.aiThreads}
                activeAIThread={ai.activeAIThread}
                aiThreadDetail={ai.aiThreadDetail}
                aiDraftMessage={ai.aiDraftMessage}
                isLoadingAIThreads={ai.isLoadingAIThreads}
                isLoadingAIThread={ai.isLoadingAIThread}
                isSendingAIMessage={ai.isSendingAIMessage}
                onSelectThread={ai.setActiveAIThreadId}
                onChangeDraft={ai.setAIDraftMessage}
                onCreateThread={() => void ai.createAIThreadFromCurrentContext()}
                onRenameThread={(threadId, title) => void ai.renameAIThread(threadId, title)}
                onDeleteThread={(threadId) => void ai.removeAIThread(threadId)}
                onSendMessage={() => void ai.sendAIMessage()}
                isUpdatingThreadTitle={ai.isUpdatingAIThreadTitle}
                pendingAIMessage={ai.pendingAIMessage}
              />
            ) : (
              <section className="search-shell">
                <header className="page-header">
                  <p className="page-date">Workspace</p>
                  <div className="page-heading-row">
                    <h2 className="page-title">Preparing today&apos;s journal</h2>
                  </div>
                </header>

                <div className="settings-card">
                  <p className="settings-message">{session.initialLoadResolved ? 'Creating today\'s journal.' : 'Loading documents from the backend.'}</p>
                  <div className="settings-actions">
                    <button type="button" className="sync-button" onClick={() => dispatch({ type: 'openSettings' })}>
                      Open settings
                    </button>
                    <button type="button" className="sync-button" onClick={() => void session.runSync()} disabled={session.isSyncing || !session.authToken}>
                      Sync now
                    </button>
                  </div>
                  {session.syncMessage ? <p className="settings-message">{session.syncMessage}</p> : null}
                </div>
              </section>
            )}
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="page-shell" data-center-column={session.centerColumn} data-active-view={state.activeView}>
        <header className="workspace-toolbar">
          <ToolbarMenu
            isOpen={isToolbarMenuOpen}
            canDeleteNote={commands.canDeleteNote}
            canOpenHistory={canOpenHistory}
            menuRef={toolbarMenuRef}
            onToggle={() => setIsToolbarMenuOpen((current) => !current)}
            onDeleteNote={() => {
              setIsToolbarMenuOpen(false);
              commands.handleDeleteNote();
            }}
            onOpenHistory={() => void openHistoryFromMenu()}
            onOpenAI={openAIFromMenu}
            onOpenSettings={openSettingsFromMenu}
          />
        </header>

        <div className="workspace-content" data-active-view={state.activeView}>
          {state.activeView === 'journals' ? (
            <JournalsView
              journals={journals}
              journalPage={journalPage}
              state={state}
              dispatch={dispatch}
              pagesByBackendId={pagesByBackendId}
              activePageSaveMessage={session.activePageSaveMessage}
              onSelectJournalPage={(pageId) => session.dispatchAfterFlush({ type: 'selectJournalPage', pageId })}
              onOpenDocumentLinkPicker={documentLinks.openDocumentLinkPicker}
              onFollowDocumentLink={commands.followDocumentLink}
              onOpenDocumentLink={commands.openDocumentLinkTarget}
            />
          ) : null}

          {state.activeView === 'note' ? (
            <NoteView
              page={page}
              state={state}
              dispatch={dispatch}
              activeNoteDirectoryPath={directory.activeNoteDirectoryPath}
              activePageSaveMessage={session.activePageSaveMessage}
              onOpenDocumentLinkPicker={documentLinks.openDocumentLinkPicker}
              onFollowDocumentLink={commands.followDocumentLink}
              onOpenDocumentLink={commands.openDocumentLinkTarget}
            />
          ) : null}

          {state.activeView === 'directory' ? (
            <DirectoryView
              directoryPath={directory.directoryPath}
              directoryEntries={directory.directoryEntries}
              activeDirectoryEntry={directory.activeDirectoryEntry}
              directoryPrompt={directory.directoryPrompt}
              directoryPromptValue={directory.directoryPromptValue}
              directoryPromptInputRef={directory.directoryPromptInputRef}
              directoryClipboardPage={directory.directoryClipboardPage ? { title: directory.directoryClipboardPage.title } : null}
              directoryClipboardDirectory={directory.directoryClipboardDirectory}
              directoryClipboardMode={directory.directoryClipboard?.kind === 'directory' ? directory.directoryClipboard.mode : directory.directoryClipboard?.kind === 'note' ? 'move' : null}
              onChangePromptValue={directory.setDirectoryPromptValue}
              onSubmitPrompt={() => void directory.submitDirectoryPrompt()}
              onSelectEntry={(_entry) => {
                directory.setActiveDirectoryEntryKey(_entry.key);
              }}
              onOpenEntry={commands.openDirectoryEntry}
            />
          ) : null}

          {state.activeView === 'search' ? (
            <SearchView
              searchQuery={search.searchQuery}
              searchScope={search.searchScope}
              searchMode={search.searchMode}
              searchInputRef={search.searchInputRef}
              visibleMatches={search.visibleMatches}
              activeSearchMatch={search.activeSearchMatch}
              lastSearchJPressRef={search.lastSearchJPressRef}
              onChangeQuery={search.setSearchQuery}
              onSetSearchScope={search.setSearchScope}
              onSetSearchMode={search.setSearchMode}
              onSetActiveSearchResultId={search.setActiveSearchResultId}
              onMoveActiveSearchResult={search.moveActiveSearchResult}
              onSubmitSearch={commands.submitSearch}
              onOpenSearchResult={commands.openSearchResult}
            />
          ) : null}

          {state.activeView === 'todos' ? (
            <TodosView
              authToken={session.authToken}
              userId={session.userId}
              isLoadingTodos={todos.isLoadingTodos}
              filteredTodos={todos.filteredTodos}
              activeTodo={todos.activeTodo}
              todoFilter={todos.todoFilter}
              updatingTodoId={todos.updatingTodoId}
              onSetTodoFilter={todos.setTodoFilter}
              onSetActiveTodoId={todos.setActiveTodoId}
              onOpenTodoSource={commands.openTodoSource}
              onHandleTodoStatusChange={(todo, status) => void todos.handleTodoStatusChange(todo, status)}
            />
          ) : null}

          {state.activeView === 'ai' ? (
            <AIView
              pageTitle={page?.backendId ? page.title : null}
              authToken={session.authToken}
              workspaceId={session.workspaceId}
              aiThreads={ai.aiThreads}
              activeAIThread={ai.activeAIThread}
              aiThreadDetail={ai.aiThreadDetail}
              aiDraftMessage={ai.aiDraftMessage}
              isLoadingAIThreads={ai.isLoadingAIThreads}
              isLoadingAIThread={ai.isLoadingAIThread}
              isSendingAIMessage={ai.isSendingAIMessage}
              onSelectThread={ai.setActiveAIThreadId}
              onChangeDraft={ai.setAIDraftMessage}
              onCreateThread={() => void ai.createAIThreadFromCurrentContext()}
              onRenameThread={(threadId, title) => void ai.renameAIThread(threadId, title)}
              onDeleteThread={(threadId) => void ai.removeAIThread(threadId)}
              onSendMessage={() => void ai.sendAIMessage()}
              isUpdatingThreadTitle={ai.isUpdatingAIThreadTitle}
              pendingAIMessage={ai.pendingAIMessage}
            />
          ) : null}

          {state.activeView === 'settings' ? (
            <SettingsView
              backendUrl={session.backendUrl}
              email={session.email}
              password={session.password}
              centerColumn={session.centerColumn}
              authToken={session.authToken}
              workspaceId={session.workspaceId}
              isSyncing={session.isSyncing}
              syncMessage={session.syncMessage}
              onChangeBackendUrl={(value) => {
                session.setBackendUrl(value);
                session.setSyncMessage('');
              }}
              onChangeEmail={(value) => {
                session.setEmail(value);
                session.setSyncMessage('');
              }}
              onChangePassword={(value) => {
                session.setPassword(value);
                session.setSyncMessage('');
              }}
              onChangeCenterColumn={session.setCenterColumn}
              onLogin={() => void session.runLogin()}
              onSync={() => void session.runSync()}
              onLogout={handleLogout}
            />
          ) : null}

          <DocumentLinkDialog
            isOpen={documentLinks.isDocumentLinkPickerOpen}
            query={documentLinks.documentLinkQuery}
            inputRef={documentLinks.documentLinkInputRef}
            matches={documentLinks.documentLinkMatches}
            activeMatch={documentLinks.activeDocumentLinkMatch}
            onClose={documentLinks.closeDocumentLinkPicker}
            onChangeQuery={documentLinks.setDocumentLinkQuery}
            onMove={documentLinks.moveActiveDocumentLinkResult}
            onInsert={commands.insertDocumentLink}
          />

          <DeleteNoteDialog
            title={commands.pendingDeleteNote?.title ?? null}
            onCancel={() => commands.setPendingDeleteNoteId(null)}
            onConfirm={commands.confirmDeleteNote}
          />

          <NoteHistoryDialog
            isOpen={isNoteHistoryOpen}
            isLoading={isLoadingNoteHistory}
            isLoadingEntry={isLoadingNoteHistoryEntry}
            noteTitle={page.title}
            entries={noteHistoryEntries}
            activeEntryId={activeNoteHistoryId}
            activeEntry={activeNoteHistoryEntry}
            errorMessage={noteHistoryError}
            onClose={() => setIsNoteHistoryOpen(false)}
            onSelectEntry={(id) => {
              void loadNoteHistoryEntry(id);
            }}
          />
        </div>
      </section>
    </main>
  );
}

export default App;
