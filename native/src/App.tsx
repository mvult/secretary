import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createWorkspace, listDocuments, listTodos, listWorkspaces, login, saveDocument, updateTodo } from './lib/backend';
import { OutlineEditor } from './features/outline/OutlineEditor';
import { documentToOutlinePage, outlinePageToDocument } from './features/outline/remote';
import { useOutlineState } from './features/outline/state';
import {
  findMatchingNotes,
  getCurrentPage,
  getJournalPage,
  getJournalPages,
  getNodeDepth,
  getPageDateLabel,
  getPageTitle,
  getPagesForPersistence,
} from './features/outline/tree';
import type { OutlinePage } from './features/outline/types';
import type { BackendTodo } from './lib/backend';

type TodoFilter = 'all' | 'open' | 'done' | 'blocked' | 'skipped';

const SETTINGS_STORAGE_KEY = 'secretary-native-settings';

interface StoredSettings {
  backendUrl?: string;
  email?: string;
  token?: string;
  userId?: number;
  workspaceId?: number;
  centerColumn?: boolean;
}

function todoStatusTone(status: BackendTodo['status']) {
  switch (status) {
    case 'not_started':
      return 'todo';
    case 'partial':
      return 'doing';
    default:
      return status;
  }
}

function formatTodoTimestamp(todo: BackendTodo) {
  const value = todo.updatedAt || todo.createdAt || todo.createdAtRecordingDate;
  if (!value) {
    return 'No timestamp';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(parsed);
}

function todoStatusToNodeStatus(status: BackendTodo['status']) {
  switch (status) {
    case 'not_started':
      return 'todo';
    case 'partial':
      return 'doing';
    case 'done':
      return 'done';
    case 'blocked':
      return 'blocked';
    case 'skipped':
      return 'skipped';
    default:
      return 'todo';
  }
}

function matchesTodoFilter(todo: BackendTodo, filter: TodoFilter) {
  switch (filter) {
    case 'open':
      return todo.status === 'not_started' || todo.status === 'partial';
    case 'done':
      return todo.status === 'done';
    case 'blocked':
      return todo.status === 'blocked';
    case 'skipped':
      return todo.status === 'skipped';
    case 'all':
    default:
      return true;
  }
}

function pageHash(page: OutlinePage) {
  return JSON.stringify({
    id: page.id,
    backendId: page.backendId ?? 0,
    workspaceId: page.workspaceId ?? 0,
    kind: page.kind,
    date: page.date,
    title: page.title,
    nodes: page.nodes.map((node) => ({
      id: node.id,
      backendId: node.backendId ?? 0,
      parentId: node.parentId,
      text: node.text,
      status: node.status,
      todoId: node.todoId ?? 0,
    })),
  });
}

function App() {
  const [state, dispatch] = useOutlineState();
  const [searchQuery, setSearchQuery] = useState('');
  const [backendUrl, setBackendUrl] = useState('http://localhost:8080');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [centerColumn, setCenterColumn] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [userId, setUserId] = useState<number | null>(null);
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [todos, setTodos] = useState<BackendTodo[]>([]);
  const [todoFilter, setTodoFilter] = useState<TodoFilter>('all');
  const [updatingTodoId, setUpdatingTodoId] = useState<number | null>(null);
  const [isLoadingTodos, setIsLoadingTodos] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [initialLoadResolved, setInitialLoadResolved] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const stateRef = useRef(state);
  const pagesForPersistence = useMemo(() => getPagesForPersistence(state), [state]);
  const pagesRef = useRef(pagesForPersistence);
  const lastSavedHashesRef = useRef<Map<string, string>>(new Map());
  const saveTimerRef = useRef<number | null>(null);
  const flushPromiseRef = useRef<Promise<void> | null>(null);
  const bootSyncRef = useRef(false);
  const page = getCurrentPage(state);
  const journalPage = getJournalPage(state);
  const journals = getJournalPages(state);
  const filteredTodos = useMemo(() => todos.filter((todo) => matchesTodoFilter(todo, todoFilter)), [todoFilter, todos]);
  const matches = useMemo(() => findMatchingNotes(state, searchQuery), [searchQuery, state]);
  const topMatch = useMemo(() => {
    const normalized = searchQuery.trim().toLowerCase();
    if (!normalized) {
      return matches[0]?.page ?? null;
    }

    return matches.find((entry) => getPageTitle(entry.page).trim().toLowerCase() === normalized)?.page ?? matches[0]?.page ?? null;
  }, [matches, searchQuery]);
  const syncEnabled = Boolean(backendUrl.trim() && authToken && workspaceId);

  useEffect(() => {
    stateRef.current = state;
    pagesRef.current = pagesForPersistence;
  }, [pagesForPersistence, state]);

  useEffect(() => {
    const saved = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!saved) {
      setBootstrapped(true);
      return;
    }

    try {
      const parsed = JSON.parse(saved) as StoredSettings;
      setBackendUrl(parsed.backendUrl ?? 'http://localhost:8080');
      setEmail(parsed.email ?? '');
      setAuthToken(parsed.token ?? '');
      setUserId(parsed.userId ?? null);
      setWorkspaceId(parsed.workspaceId ?? null);
      setCenterColumn(parsed.centerColumn ?? false);
    } catch {
      window.localStorage.removeItem(SETTINGS_STORAGE_KEY);
    }

    setBootstrapped(true);
  }, []);

  useEffect(() => {
    if (!bootstrapped) {
      return;
    }

    const payload: StoredSettings = {
      backendUrl,
      email,
      token: authToken || undefined,
      userId: userId ?? undefined,
      workspaceId: workspaceId ?? undefined,
      centerColumn,
    };
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(payload));
  }, [authToken, backendUrl, bootstrapped, centerColumn, email, userId, workspaceId]);

  useEffect(() => {
    if (!bootstrapped) {
      return;
    }

    if (!authToken || !backendUrl.trim()) {
      setInitialLoadResolved(true);
    }
  }, [authToken, backendUrl, bootstrapped]);

  useEffect(() => {
    if (state.activeView === 'search') {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  }, [state.activeView]);

  const applyRemotePages = useCallback((nextPages: OutlinePage[]) => {
    dispatch({ type: 'hydrate', pages: nextPages });
    const hashes = new Map<string, string>();
    for (const nextPage of nextPages) {
      hashes.set(nextPage.id, pageHash(nextPage));
    }
    lastSavedHashesRef.current = hashes;
  }, [dispatch]);

  const loadTodoList = useCallback(async (tokenOverride?: string, userIdOverride?: number | null) => {
    const nextToken = tokenOverride ?? authToken;
    const nextUserId = userIdOverride ?? userId;
    if (!backendUrl.trim() || !nextToken || !nextUserId) {
      setTodos([]);
      return;
    }

    setIsLoadingTodos(true);
    try {
      const nextTodos = await listTodos(backendUrl, nextToken, nextUserId);
      setTodos(nextTodos);
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Todo refresh failed.');
    } finally {
      setIsLoadingTodos(false);
    }
  }, [authToken, backendUrl, userId]);

  const syncTodoIntoPages = useCallback((todo: BackendTodo) => {
    if (!todo.sourceDocumentId || !todo.sourceBlockId) {
      return;
    }
    const page = stateRef.current.pages.find((entry) => entry.backendId === todo.sourceDocumentId);
    if (!page) {
      return;
    }
    const node = page.nodes.find((entry) => entry.backendId === todo.sourceBlockId || entry.todoId === todo.id);
    if (!node) {
      return;
    }
    const nextStatus = todoStatusToNodeStatus(todo.status);
    if (node.status === nextStatus) {
      return;
    }
    dispatch({
      type: 'mergeRemotePage',
      page: {
        ...page,
        nodes: page.nodes.map((entry) => (
          entry.id === node.id
            ? { ...entry, status: nextStatus, todoId: todo.id, updatedAt: todo.updatedAt || entry.updatedAt }
            : entry
        )),
      },
    });
  }, [dispatch]);

  const syncFromBackend = useCallback(async (tokenOverride?: string, workspaceOverride?: number | null) => {
    const nextToken = tokenOverride ?? authToken;
    if (!backendUrl.trim()) {
      setSyncMessage('Add a backend URL first.');
      setInitialLoadResolved(true);
      return;
    }
    if (!nextToken) {
      setSyncMessage('Log in first.');
      setInitialLoadResolved(true);
      return;
    }

    setIsSyncing(true);
    try {
      let workspaces = await listWorkspaces(backendUrl, nextToken);
      let nextWorkspaceId = workspaceOverride ?? workspaceId;

      if (!nextWorkspaceId) {
        if (workspaces.length === 0) {
          const workspace = await createWorkspace(backendUrl, nextToken, 'Personal');
          workspaces = [workspace];
        }
        nextWorkspaceId = workspaces[0]?.id ?? null;
      }

      if (!nextWorkspaceId) {
        throw new Error('No workspace is available for this account.');
      }

      const documents = await listDocuments(backendUrl, nextToken, nextWorkspaceId);
      const pages = documents.map(documentToOutlinePage);
      applyRemotePages(pages);
      setWorkspaceId(nextWorkspaceId);
      setSyncMessage(`Loaded ${documents.length} document${documents.length === 1 ? '' : 's'}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sync failed.';
      setSyncMessage(message);
      if (/unauthenticated|invalid token|missing token/i.test(message)) {
        setAuthToken('');
        setWorkspaceId(null);
      }
    } finally {
      setIsSyncing(false);
      setInitialLoadResolved(true);
    }
  }, [applyRemotePages, authToken, backendUrl, workspaceId]);

  useEffect(() => {
    if (!bootstrapped || bootSyncRef.current || !authToken || !backendUrl.trim()) {
      return;
    }
    bootSyncRef.current = true;
    setInitialLoadResolved(false);
    void syncFromBackend();
  }, [authToken, backendUrl, bootstrapped, syncFromBackend]);

  useEffect(() => {
    if (!bootstrapped || !initialLoadResolved || state.pages.length > 0) {
      return;
    }

    dispatch({ type: 'createTodayJournal' });
  }, [bootstrapped, dispatch, initialLoadResolved, state.pages.length]);

  useEffect(() => {
    if (state.activeView !== 'todos') {
      return;
    }
    void loadTodoList();
  }, [loadTodoList, state.activeView]);

  const flushDirtyPages = useCallback(async () => {
    if (!syncEnabled) {
      return;
    }

    if (flushPromiseRef.current) {
      await flushPromiseRef.current;
      return;
    }

    const run = (async () => {
      const snapshot = pagesRef.current;
      for (const nextPage of snapshot) {
        const nextHash = pageHash(nextPage);
        if (lastSavedHashesRef.current.get(nextPage.id) === nextHash) {
          continue;
        }

        const savedDocument = await saveDocument(backendUrl, authToken, outlinePageToDocument(nextPage, workspaceId!));
        const savedPage = documentToOutlinePage(savedDocument);
        dispatch({ type: 'mergeRemotePage', page: savedPage });
        lastSavedHashesRef.current.set(savedPage.id, pageHash(savedPage));
      }
    })();

    flushPromiseRef.current = run.finally(() => {
      flushPromiseRef.current = null;
    });
    await flushPromiseRef.current;
  }, [authToken, backendUrl, dispatch, syncEnabled, workspaceId]);

  const persistSignature = useMemo(
    () => pagesForPersistence.map((nextPage) => `${nextPage.id}:${pageHash(nextPage)}`).join('|'),
    [pagesForPersistence],
  );

  useEffect(() => {
    if (!syncEnabled) {
      return;
    }

    const hasDirtyPages = pagesForPersistence.some((nextPage) => lastSavedHashesRef.current.get(nextPage.id) !== pageHash(nextPage));
    if (!hasDirtyPages) {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      return;
    }

    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      void flushDirtyPages().catch((error) => {
        setSyncMessage(error instanceof Error ? error.message : 'Auto-save failed.');
      });
    }, 10000);

    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [flushDirtyPages, pagesForPersistence, persistSignature, syncEnabled]);

  useEffect(() => {
    const handlePageHide = () => {
      void flushDirtyPages();
    };

    window.addEventListener('pagehide', handlePageHide);
    return () => window.removeEventListener('pagehide', handlePageHide);
  }, [flushDirtyPages]);

  const dispatchAfterFlush = useCallback((action: Parameters<typeof dispatch>[0]) => {
    if (!syncEnabled) {
      dispatch(action);
      return;
    }

    void flushDirtyPages()
      .catch((error) => {
        setSyncMessage(error instanceof Error ? error.message : 'Save failed before navigation.');
      })
      .finally(() => {
        dispatch(action);
      });
  }, [dispatch, flushDirtyPages, syncEnabled]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (state.activeView === 'search' || state.activeView === 'settings' || state.activeView === 'todos')) {
        event.preventDefault();
        setSearchQuery('');
        dispatchAfterFlush({ type: 'selectJournal' });
        return;
      }

      if (!(event.metaKey || event.ctrlKey)) {
        return;
      }

      if (event.key.toLowerCase() === 'j') {
        event.preventDefault();
        dispatchAfterFlush({ type: 'selectJournal' });
        return;
      }

      if (event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchQuery('');
        dispatchAfterFlush({ type: 'openSearch' });
        return;
      }

      if (event.key.toLowerCase() === 't') {
        event.preventDefault();
        dispatchAfterFlush({ type: 'openTodos' });
        return;
      }

      if (event.key === ',') {
        event.preventDefault();
        dispatchAfterFlush({ type: 'openSettings' });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dispatchAfterFlush, state.activeView]);

  if (!page) {
    return (
      <main className="app-shell">
        <section className="page-shell" data-center-column={centerColumn}>
          <header className="workspace-toolbar">
            <button
              type="button"
              className="settings-trigger"
              aria-label="Open settings"
              onClick={() => dispatchAfterFlush({ type: 'openSettings' })}
            >
              <span />
              <span />
              <span />
            </button>
          </header>

          <div className="workspace-content">
            {state.activeView === 'settings' ? (
              <section className="settings-shell">
                <header className="page-header">
                  <p className="page-date">Settings</p>
                  <div className="page-heading-row">
                    <h2 className="page-title settings-title">Sync</h2>
                  </div>
                </header>

                <div className="settings-card">
                  <label className="settings-label" htmlFor="backend-url-empty">
                    Backend URL
                  </label>
                  <input
                    id="backend-url-empty"
                    className="settings-input"
                    type="text"
                    value={backendUrl}
                    placeholder="http://localhost:8080"
                    onChange={(event) => {
                      setBackendUrl(event.target.value);
                      setSyncMessage('');
                    }}
                  />

                  <label className="settings-label" htmlFor="sync-email-empty">
                    Email
                  </label>
                  <input
                    id="sync-email-empty"
                    className="settings-input"
                    type="email"
                    value={email}
                    placeholder="you@example.com"
                    onChange={(event) => {
                      setEmail(event.target.value);
                      setSyncMessage('');
                    }}
                  />

                  <label className="settings-label" htmlFor="sync-password-empty">
                    Password
                  </label>
                  <input
                    id="sync-password-empty"
                    className="settings-input"
                    type="password"
                    value={password}
                    placeholder="Password"
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setSyncMessage('');
                    }}
                  />

                  <div className="settings-actions">
                    <button type="button" className="sync-button" onClick={() => void runLogin()} disabled={isSyncing}>
                      {authToken ? 'Refresh login' : 'Log in'}
                    </button>
                    <button type="button" className="sync-button" onClick={() => void runSync()} disabled={isSyncing || !authToken}>
                      Sync now
                    </button>
                  </div>

                  {syncMessage ? <p className="settings-message">{syncMessage}</p> : null}
                </div>
              </section>
            ) : (
              <section className="search-shell">
                <header className="page-header">
                  <p className="page-date">Workspace</p>
                  <div className="page-heading-row">
                    <h2 className="page-title">Preparing today&apos;s journal</h2>
                  </div>
                </header>

                <div className="settings-card">
                  <p className="settings-message">{initialLoadResolved ? 'Creating today\'s journal.' : 'Loading documents from the backend.'}</p>
                  <div className="settings-actions">
                    <button type="button" className="sync-button" onClick={() => dispatch({ type: 'openSettings' })}>
                      Open settings
                    </button>
                    <button type="button" className="sync-button" onClick={() => void runSync()} disabled={isSyncing || !authToken}>
                      Sync now
                    </button>
                  </div>
                  {syncMessage ? <p className="settings-message">{syncMessage}</p> : null}
                </div>
              </section>
            )}
          </div>
        </section>
      </main>
    );
  }

  const openSearchResult = (pageId: string) => {
    dispatchAfterFlush({ type: 'selectNote', pageId });
    setSearchQuery('');
  };

  const submitSearch = () => {
    const nextTitle = searchQuery.trim();
    if (!nextTitle) {
      return;
    }

    if (topMatch) {
      openSearchResult(topMatch.id);
      return;
    }

    dispatch({ type: 'createNote', title: nextTitle });
    setSearchQuery('');
  };

  const runLogin = async () => {
    if (!backendUrl.trim()) {
      setSyncMessage('Add a backend URL first.');
      return;
    }
    if (!email.trim() || !password) {
      setSyncMessage('Email and password are required.');
      return;
    }

    setIsSyncing(true);
    try {
      setInitialLoadResolved(false);
      const response = await login(backendUrl, email, password);
      bootSyncRef.current = true;
      setAuthToken(response.token);
      setUserId(response.user.id);
      setPassword('');
      setSyncMessage(`Logged in as ${response.user.firstName || email}.`);
      await syncFromBackend(response.token, null);
      await loadTodoList(response.token, response.user.id);
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Login failed.');
    } finally {
      setIsSyncing(false);
    }
  };

  const runSync = async () => {
    try {
      await flushDirtyPages();
      await syncFromBackend();
      await loadTodoList();
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Sync failed.');
    }
  };

  const handleLogout = () => {
    setAuthToken('');
    setUserId(null);
    setWorkspaceId(null);
    setTodos([]);
    setSyncMessage('Logged out.');
    bootSyncRef.current = false;
  };

  const openTodoSource = (todo: BackendTodo) => {
    if (!todo.sourceDocumentId) {
      return;
    }
    const sourcePage = state.pages.find((entry) => entry.backendId === todo.sourceDocumentId);
    if (!sourcePage) {
      setSyncMessage('Source page is not loaded locally yet. Sync to refresh documents.');
      return;
    }

    if (sourcePage.kind === 'note') {
      dispatchAfterFlush({ type: 'selectNote', pageId: sourcePage.id });
    } else {
      dispatchAfterFlush({ type: 'selectJournalPage', pageId: sourcePage.id });
    }

    if (!todo.sourceBlockId) {
      return;
    }

    window.setTimeout(() => {
      const node = stateRef.current.pages
        .find((entry) => entry.id === sourcePage.id)
        ?.nodes.find((entry) => entry.backendId === todo.sourceBlockId || entry.todoId === todo.id);
      if (!node) {
        return;
      }
      dispatch({ type: 'focus', nodeId: node.id });
      document.querySelector<HTMLElement>(`[data-node-id="${node.id}"]`)?.scrollIntoView({ block: 'center' });
    }, 0);
  };

  const handleTodoStatusChange = async (todo: BackendTodo, nextStatus: BackendTodo['status']) => {
    if (!authToken || !userId || nextStatus === todo.status) {
      return;
    }
    setUpdatingTodoId(todo.id);
    try {
      const savedTodo = await updateTodo(backendUrl, authToken, { ...todo, status: nextStatus, userId });
      setTodos((current) => current.map((entry) => (entry.id === savedTodo.id ? savedTodo : entry)));
      syncTodoIntoPages(savedTodo);
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Todo update failed.');
    } finally {
      setUpdatingTodoId(null);
    }
  };

  return (
    <main className="app-shell">
      <section className="page-shell" data-center-column={centerColumn}>
        <header className="workspace-toolbar">
          <button
            type="button"
            className="settings-trigger"
            aria-label="Open settings"
            onClick={() => dispatchAfterFlush({ type: 'openSettings' })}
          >
            <span />
            <span />
            <span />
          </button>
        </header>

        <div className="workspace-content">
        {state.activeView === 'journals' ? (
          <>
            <header className="page-header page-header-stacked">
              <div className="page-heading-row">
                <h2 className="page-title journal-stack-title">Journals</h2>
              </div>
            </header>

            <div className="journal-stack">
              {journals.map((journal) => {
                const isActive = state.activePageId === journal.id;

                return (
                  <article key={journal.id} className="journal-card" data-active={isActive}>
                    <button
                      type="button"
                      className="journal-card-header"
                      onClick={() => dispatchAfterFlush({ type: 'selectJournalPage', pageId: journal.id })}
                    >
                      <div className="journal-card-heading">
                        <h3 className="page-title">{getPageDateLabel(journal)}</h3>
                        <span className="page-kind">{journalPage?.id === journal.id ? 'Today' : 'Journal entry'}</span>
                      </div>
                    </button>

                    {isActive ? (
                      <OutlineEditor page={journal} state={state} dispatch={dispatch} />
                    ) : (
                      <div className="journal-preview">
                        {journal.nodes.map((node) => (
                          <div
                            key={node.id}
                            className="journal-preview-row"
                            style={{ paddingLeft: `${12 + getNodeDepth(journal.nodes, node.id) * 24}px` }}
                          >
                            <span className="row-gutter" aria-hidden="true">
                              •
                            </span>
                            {node.status === 'note' ? null : (
                              <button
                                type="button"
                                className="status-chip status-chip-button"
                                data-status={node.status}
                                onClick={() => dispatch({ type: 'toggleNodeStatus', nodeId: node.id })}
                              >
                                {node.status}
                              </button>
                            )}
                            <div className="journal-preview-content">
                              <p className="row-text">{node.text}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </>
        ) : null}

        {state.activeView === 'note' ? (
          <>
            <header className="page-header">
              {page.kind === 'note' ? <p className="page-date">{getPageDateLabel(page)}</p> : null}
              <div className="page-heading-row">
                <input
                  className="page-title-input"
                  type="text"
                  value={page.title}
                  placeholder="Untitled note"
                  onChange={(event) => dispatch({ type: 'updatePageTitle', title: event.target.value })}
                />
                <span className="page-kind">Note</span>
              </div>
            </header>

            <OutlineEditor page={page} state={state} dispatch={dispatch} />
          </>
        ) : null}

        {state.activeView === 'search' ? (
          <section className="search-shell">
            <header className="page-header search-header">
              <p className="page-date">New or existing note</p>
              <div className="page-heading-row page-heading-row-search">
                <input
                  ref={searchInputRef}
                  className="page-title-input search-input"
                  type="text"
                  value={searchQuery}
                  placeholder="Type a note title"
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      submitSearch();
                    }
                  }}
                />
              </div>
            </header>

            <div className="search-results">
              {matches.length > 0 ? (
                matches.slice(0, 8).map(({ page: match }) => (
                  <button
                    key={match.id}
                    type="button"
                    className="search-result"
                    data-active={topMatch?.id === match.id ? 'true' : 'false'}
                    onClick={() => openSearchResult(match.id)}
                  >
                    <span className="search-result-title">{getPageTitle(match)}</span>
                    <span className="search-result-date">{getPageDateLabel(match)}</span>
                  </button>
                ))
              ) : searchQuery.trim() ? (
                <button type="button" className="search-result search-result-create" data-active="true" onClick={submitSearch}>
                  <span className="search-result-title">Create "{searchQuery.trim()}"</span>
                  <span className="search-result-date">Press Enter to make a new page</span>
                </button>
              ) : (
                <div className="search-empty">Start typing to jump to an existing note or create a new one.</div>
              )}
            </div>
          </section>
        ) : null}

        {state.activeView === 'todos' ? (
          <section className="todos-shell">
            <header className="page-header">
              <p className="page-date">Canonical tasks</p>
              <div className="page-heading-row">
                <h2 className="page-title settings-title">Todos</h2>
                <span className="page-kind">{filteredTodos.length}</span>
              </div>
            </header>

            <div className="search-results">
              <div className="todo-filter-row">
                {(['all', 'open', 'done', 'blocked', 'skipped'] as TodoFilter[]).map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    className="todo-filter-button"
                    data-active={todoFilter === filter}
                    onClick={() => setTodoFilter(filter)}
                  >
                    {filter}
                  </button>
                ))}
              </div>
              {!authToken || !userId ? (
                <div className="search-empty">Log in again to load your todos.</div>
              ) : isLoadingTodos ? (
                <div className="search-empty">Loading todos...</div>
              ) : filteredTodos.length === 0 ? (
                <div className="search-empty">No todos yet. Mark a block as a task and it will show up here.</div>
              ) : (
                filteredTodos.map((todo) => (
                  <article key={todo.id} className="todo-card">
                    <div className="todo-card-header">
                      <div>
                        <h3 className="search-result-title">{todo.name}</h3>
                        <p className="todo-card-meta">{formatTodoTimestamp(todo)}</p>
                      </div>
                      <label
                        className="todo-status-control"
                        data-status={todoStatusTone(todo.status)}
                        data-busy={updatingTodoId === todo.id}
                      >
                        <span className="todo-status-dot" aria-hidden="true" />
                        <select
                          className="todo-status-select"
                          value={todo.status}
                          disabled={updatingTodoId === todo.id}
                          aria-label={`Set status for ${todo.name}`}
                          onChange={(event) => void handleTodoStatusChange(todo, event.target.value as BackendTodo['status'])}
                        >
                          <option value="not_started">Todo</option>
                          <option value="partial">Doing</option>
                          <option value="done">Done</option>
                          <option value="blocked">Blocked</option>
                          <option value="skipped">Skipped</option>
                        </select>
                        <span className="todo-status-caret" aria-hidden="true">
                          v
                        </span>
                      </label>
                    </div>
                    {todo.desc ? <p className="todo-card-desc">{todo.desc}</p> : null}
                    <div className="todo-card-footer">
                      <span className="todo-card-meta">#{todo.id}</span>
                      {todo.sourceDocumentId ? (
                        <button type="button" className="todo-link-button" onClick={() => openTodoSource(todo)}>
                          Open source
                        </button>
                      ) : null}
                      {todo.createdAtRecordingName ? <span className="todo-card-meta">From {todo.createdAtRecordingName}</span> : null}
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>
        ) : null}

        {state.activeView === 'settings' ? (
          <section className="settings-shell">
            <header className="page-header">
              <p className="page-date">Settings</p>
              <div className="page-heading-row">
                <h2 className="page-title settings-title">Sync</h2>
              </div>
            </header>

            <div className="settings-card">
              <label className="settings-label" htmlFor="backend-url">
                Backend URL
              </label>
              <input
                id="backend-url"
                className="settings-input"
                type="text"
                value={backendUrl}
                placeholder="http://localhost:8080"
                onChange={(event) => {
                  setBackendUrl(event.target.value);
                  setSyncMessage('');
                }}
              />

              <label className="settings-label" htmlFor="sync-email">
                Email
              </label>
              <input
                id="sync-email"
                className="settings-input"
                type="email"
                value={email}
                placeholder="you@example.com"
                onChange={(event) => {
                  setEmail(event.target.value);
                  setSyncMessage('');
                }}
              />

              <label className="settings-label" htmlFor="sync-password">
                Password
              </label>
              <input
                id="sync-password"
                className="settings-input"
                type="password"
                value={password}
                placeholder="Password"
                onChange={(event) => {
                  setPassword(event.target.value);
                  setSyncMessage('');
                }}
              />

              <label className="settings-toggle" htmlFor="center-column">
                <span className="settings-toggle-copy">
                  <span className="settings-label">Center column view</span>
                  <span className="settings-message">Keep the editor in a narrower centered column.</span>
                </span>
                <input
                  id="center-column"
                  type="checkbox"
                  checked={centerColumn}
                  onChange={(event) => setCenterColumn(event.target.checked)}
                />
              </label>

              <div className="settings-hotkeys">
                <span className="settings-label">Hotkeys</span>
                <p className="settings-message">`Cmd+J` journals. `Cmd+K` note search. `Cmd+T` todos. `Cmd+,` settings. `Esc` returns to journals from overlays.</p>
              </div>

              <div className="settings-actions">
                <button type="button" className="sync-button" onClick={() => void runLogin()} disabled={isSyncing}>
                  {authToken ? 'Refresh login' : 'Log in'}
                </button>
                <button type="button" className="sync-button" onClick={() => void runSync()} disabled={isSyncing || !authToken}>
                  Sync now
                </button>
                <button type="button" className="sync-button" onClick={handleLogout} disabled={isSyncing || !authToken}>
                  Log out
                </button>
              </div>

              <div className="settings-hotkeys">
                <span className="settings-label">Status</span>
                <p className="settings-message">
                  {isSyncing ? 'Working...' : authToken ? `Connected${workspaceId ? ` to workspace ${workspaceId}` : ''}.` : 'Not connected.'}
                </p>
                {syncMessage ? <p className="settings-message">{syncMessage}</p> : null}
              </div>
            </div>
          </section>
        ) : null}
        </div>
      </section>
    </main>
  );
}

export default App;
