import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createDirectory,
  deleteDocument,
  createWorkspace,
  deleteDirectory,
  listDocuments,
  listTodos,
  listWorkspaces,
  login,
  saveDocument,
  updateDirectory,
  updateTodo,
} from './lib/backend';
import { OutlineEditor } from './features/outline/OutlineEditor';
import { OutlineText } from './features/outline/OutlineText';
import { findDocumentLinkAtCursor } from './features/outline/documentLinks';
import { documentToOutlinePage, outlinePageToDocument } from './features/outline/remote';
import { reduceOutlineState, useOutlineState } from './features/outline/state';
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
import type { BackendDirectory, BackendTodo } from './lib/backend';

type TodoFilter = 'all' | 'open' | 'done' | 'blocked' | 'skipped';

const TODO_STATUS_ORDER: BackendTodo['status'][] = ['todo', 'doing', 'done', 'blocked', 'skipped'];

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
    case 'todo':
      return 'todo';
    case 'doing':
      return 'doing';
    default:
      return status;
  }
}

function formatInlineTodoStatus(status: string) {
  switch (status) {
    case 'todo':
      return '☐';
    case 'doing':
      return 'DOING';
    case 'done':
      return '☑';
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

function matchesTodoFilter(todo: BackendTodo, filter: TodoFilter) {
  switch (filter) {
    case 'open':
      return todo.status === 'todo' || todo.status === 'doing';
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

function cycleTodoStatus(status: BackendTodo['status'], direction: 1 | -1) {
  const currentIndex = TODO_STATUS_ORDER.indexOf(status);
  const safeIndex = currentIndex === -1 ? 0 : currentIndex;
  const nextIndex = (safeIndex + direction + TODO_STATUS_ORDER.length) % TODO_STATUS_ORDER.length;
  return TODO_STATUS_ORDER[nextIndex];
}

function pageHash(page: OutlinePage) {
  return JSON.stringify({
    id: page.id,
    backendId: page.backendId ?? 0,
    workspaceId: page.workspaceId ?? 0,
    directoryId: page.directoryId ?? 0,
    kind: page.kind,
    date: page.date,
    title: page.title,
    nodes: page.nodes.map((node) => ({
      id: node.id,
      backendId: node.backendId ?? 0,
      parentId: node.parentId,
      text: node.text,
      todoStatus: node.todoStatus ?? '',
      todoId: node.todoId ?? 0,
    })),
  });
}

function pageMatchesTitle(page: OutlinePage, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return getPageTitle(page).toLowerCase().includes(normalized);
}

function pageMatchesBody(page: OutlinePage, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const text = page.nodes.map((node) => node.text).join(' ').toLowerCase();
  return text.includes(normalized);
}

interface DirectoryEntry {
  key: string;
  kind: 'directory' | 'note';
  directory?: BackendDirectory;
  page?: OutlinePage;
}

type DirectoryPrompt =
  | { kind: 'create-directory' }
  | { kind: 'rename-directory'; directoryId: number }
  | { kind: 'rename-note'; pageId: string };

type DirectoryClipboard =
  | { kind: 'note'; pageId: string; mode: 'move' }
  | { kind: 'directory'; directoryId: number; mode: 'move' | 'copy' };

interface JumpLocation {
  pageId: string;
  focusedId: string;
}

const JUMPLIST_LIMIT = 10;

function App() {
  const [state, dispatch] = useOutlineState();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'insert' | 'select'>('insert');
  const [searchScope, setSearchScope] = useState<'title' | 'fulltext'>('title');
  const [documentLinkQuery, setDocumentLinkQuery] = useState('');
  const [backendUrl, setBackendUrl] = useState('http://localhost:8080');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [centerColumn, setCenterColumn] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [userId, setUserId] = useState<number | null>(null);
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [directories, setDirectories] = useState<BackendDirectory[]>([]);
  const [todos, setTodos] = useState<BackendTodo[]>([]);
  const [todoFilter, setTodoFilter] = useState<TodoFilter>('all');
  const [activeTodoId, setActiveTodoId] = useState<number | null>(null);
  const [activeDirectoryId, setActiveDirectoryId] = useState<number | null>(null);
  const [activeDirectoryEntryKey, setActiveDirectoryEntryKey] = useState<string | null>(null);
  const [isToolbarMenuOpen, setIsToolbarMenuOpen] = useState(false);
  const [pendingDeleteNoteId, setPendingDeleteNoteId] = useState<string | null>(null);
  const [directoryClipboard, setDirectoryClipboard] = useState<DirectoryClipboard | null>(null);
  const [directoryPrompt, setDirectoryPrompt] = useState<DirectoryPrompt | null>(null);
  const [directoryPromptValue, setDirectoryPromptValue] = useState('');
  const [isSubmittingDirectoryPrompt, setIsSubmittingDirectoryPrompt] = useState(false);
  const [updatingTodoId, setUpdatingTodoId] = useState<number | null>(null);
  const [isLoadingTodos, setIsLoadingTodos] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [initialLoadResolved, setInitialLoadResolved] = useState(false);
  const [activeSearchResultId, setActiveSearchResultId] = useState<string | null>(null);
  const [isDocumentLinkPickerOpen, setIsDocumentLinkPickerOpen] = useState(false);
  const [activeDocumentLinkResultId, setActiveDocumentLinkResultId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const documentLinkInputRef = useRef<HTMLInputElement | null>(null);
  const directoryPromptInputRef = useRef<HTMLInputElement | null>(null);
  const toolbarMenuRef = useRef<HTMLDivElement | null>(null);
  const lastSearchJPressRef = useRef<number | null>(null);
  const lastTodoGPressRef = useRef<number | null>(null);
  const lastDirectoryDPressRef = useRef<number | null>(null);
  const pendingDirectoryMoveTimerRef = useRef<number | null>(null);
  const jumpBackRef = useRef<JumpLocation[]>([]);
  const jumpForwardRef = useRef<JumpLocation[]>([]);
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
  const notes = useMemo(() => state.pages.filter((entry) => entry.kind === 'note'), [state.pages]);
  const pagesByBackendId = useMemo(
    () => new Map(state.pages.filter((entry) => entry.backendId).map((entry) => [entry.backendId!, entry])),
    [state.pages],
  );
  const directoryMap = useMemo(() => new Map(directories.map((directory) => [directory.id, directory])), [directories]);
  const currentDirectory = activeDirectoryId ? directoryMap.get(activeDirectoryId) ?? null : null;
  const directoryPath = useMemo(() => {
    const path: BackendDirectory[] = [];
    let cursor = currentDirectory;
    const seen = new Set<number>();
    while (cursor && !seen.has(cursor.id)) {
      path.unshift(cursor);
      seen.add(cursor.id);
      cursor = cursor.parentId ? directoryMap.get(cursor.parentId) ?? null : null;
    }
    return path;
  }, [currentDirectory, directoryMap]);
  const activeNoteDirectoryPath = useMemo(() => {
    if (!page || page.kind !== 'note' || !page.directoryId) {
      return [] as BackendDirectory[];
    }

    const path: BackendDirectory[] = [];
    let cursor = directoryMap.get(page.directoryId) ?? null;
    const seen = new Set<number>();
    while (cursor && !seen.has(cursor.id)) {
      path.unshift(cursor);
      seen.add(cursor.id);
      cursor = cursor.parentId ? directoryMap.get(cursor.parentId) ?? null : null;
    }
    return path;
  }, [directoryMap, page]);
  const directoryEntries = useMemo<DirectoryEntry[]>(() => {
    const childDirectories = directories
      .filter((directory) => (directory.parentId || 0) === (activeDirectoryId || 0))
      .sort((left, right) => left.position - right.position || left.name.localeCompare(right.name) || left.id - right.id)
      .map((directory) => ({ key: `directory-${directory.id}`, kind: 'directory' as const, directory }));
    const childNotes = notes
      .filter((entry) => (entry.directoryId ?? 0) === (activeDirectoryId || 0))
      .sort((left, right) => getPageTitle(left).localeCompare(getPageTitle(right)) || left.id.localeCompare(right.id))
      .map((entry) => ({ key: `note-${entry.id}`, kind: 'note' as const, page: entry }));
    return [...childDirectories, ...childNotes];
  }, [activeDirectoryId, directories, notes]);
  const activeDirectoryEntry = useMemo(() => {
    if (directoryEntries.length === 0) {
      return null;
    }
    if (activeDirectoryEntryKey) {
      return directoryEntries.find((entry) => entry.key === activeDirectoryEntryKey) ?? directoryEntries[0];
    }
    return directoryEntries[0];
  }, [activeDirectoryEntryKey, directoryEntries]);
  const directoryClipboardPage = useMemo(
    () => directoryClipboard?.kind === 'note'
      ? state.pages.find((entry) => entry.id === directoryClipboard.pageId && entry.kind === 'note') ?? null
      : null,
    [directoryClipboard, state.pages],
  );
  const directoryClipboardDirectory = useMemo(
    () => directoryClipboard?.kind === 'directory'
      ? directories.find((entry) => entry.id === directoryClipboard.directoryId) ?? null
      : null,
    [directories, directoryClipboard],
  );
  const filteredTodos = useMemo(() => todos.filter((todo) => matchesTodoFilter(todo, todoFilter)), [todoFilter, todos]);
  const activeTodo = useMemo(() => {
    if (filteredTodos.length === 0) {
      return null;
    }
    if (activeTodoId != null) {
      return filteredTodos.find((todo) => todo.id === activeTodoId) ?? filteredTodos[0] ?? null;
    }
    return filteredTodos[0] ?? null;
  }, [activeTodoId, filteredTodos]);
  const matches = useMemo(() => findMatchingNotes(state, searchQuery), [searchQuery, state]);
  const titleMatches = useMemo(
    () => matches.filter(({ page }) => pageMatchesTitle(page, searchQuery)),
    [matches, searchQuery],
  );
  const fullTextMatches = useMemo(
    () => matches.filter(({ page }) => !pageMatchesTitle(page, searchQuery) && pageMatchesBody(page, searchQuery)),
    [matches, searchQuery],
  );
  const searchMatches = searchScope === 'fulltext' ? fullTextMatches : titleMatches;
  const visibleMatches = useMemo(() => searchMatches.slice(0, 8), [searchMatches]);
  const topMatch = useMemo(() => {
    const normalized = searchQuery.trim().toLowerCase();
    if (!normalized) {
      return searchMatches[0]?.page ?? null;
    }

    return searchMatches.find((entry) => getPageTitle(entry.page).trim().toLowerCase() === normalized)?.page ?? searchMatches[0]?.page ?? null;
  }, [searchMatches, searchQuery]);
  const activeSearchMatch = useMemo(() => {
    if (searchMode !== 'select') {
      return topMatch;
    }

    return visibleMatches.find((entry) => entry.page.id === activeSearchResultId)?.page ?? visibleMatches[0]?.page ?? null;
  }, [activeSearchResultId, searchMode, topMatch, visibleMatches]);
  const documentLinkMatches = useMemo(() => {
    const normalized = documentLinkQuery.trim().toLowerCase();
    return state.pages
      .filter((entry) => {
        if (!normalized) {
          return true;
        }
        return getPageTitle(entry).toLowerCase().includes(normalized);
      })
      .sort((left, right) => {
        const kindOrder = left.kind === right.kind ? 0 : left.kind === 'note' ? -1 : 1;
        if (kindOrder !== 0) {
          return kindOrder;
        }
        return getPageTitle(left).localeCompare(getPageTitle(right)) || left.id.localeCompare(right.id);
      })
      .slice(0, 8);
  }, [documentLinkQuery, state.pages]);
  const activeDocumentLinkMatch = useMemo(
    () => documentLinkMatches.find((entry) => entry.id === activeDocumentLinkResultId) ?? documentLinkMatches[0] ?? null,
    [activeDocumentLinkResultId, documentLinkMatches],
  );
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
      setSearchMode('insert');
      setSearchScope('title');
      setActiveSearchResultId(null);
      lastSearchJPressRef.current = null;
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  }, [state.activeView]);

  useEffect(() => {
    if (!isDocumentLinkPickerOpen) {
      return;
    }
    documentLinkInputRef.current?.focus();
    documentLinkInputRef.current?.select();
  }, [isDocumentLinkPickerOpen]);

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

  useEffect(() => () => {
    if (pendingDirectoryMoveTimerRef.current) {
      window.clearTimeout(pendingDirectoryMoveTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (searchMode !== 'select') {
      if (activeSearchResultId !== null) {
        setActiveSearchResultId(null);
      }
      return;
    }

    if (visibleMatches.length === 0) {
      if (activeSearchResultId !== null) {
        setActiveSearchResultId(null);
      }
      return;
    }

    if (!activeSearchResultId || !visibleMatches.some((entry) => entry.page.id === activeSearchResultId)) {
      setActiveSearchResultId(visibleMatches[0].page.id);
    }
  }, [activeSearchResultId, searchMode, visibleMatches]);

  useEffect(() => {
    if (!directoryPrompt) {
      return;
    }
    directoryPromptInputRef.current?.focus();
    directoryPromptInputRef.current?.select();
  }, [directoryPrompt]);

  useEffect(() => {
    if (!isDocumentLinkPickerOpen) {
      return;
    }

    if (documentLinkMatches.length === 0) {
      if (activeDocumentLinkResultId !== null) {
        setActiveDocumentLinkResultId(null);
      }
      return;
    }

    if (!activeDocumentLinkResultId || !documentLinkMatches.some((entry) => entry.id === activeDocumentLinkResultId)) {
      setActiveDocumentLinkResultId(documentLinkMatches[0].id);
    }
  }, [activeDocumentLinkResultId, documentLinkMatches, isDocumentLinkPickerOpen]);

  useEffect(() => {
    if (filteredTodos.length === 0) {
      if (activeTodoId !== null) {
        setActiveTodoId(null);
      }
      return;
    }

    if (activeTodoId == null || !filteredTodos.some((todo) => todo.id === activeTodoId)) {
      setActiveTodoId(filteredTodos[0].id);
    }
  }, [activeTodoId, filteredTodos]);

  useEffect(() => {
    if (activeDirectoryId != null && !directories.some((directory) => directory.id === activeDirectoryId)) {
      setActiveDirectoryId(null);
    }
  }, [activeDirectoryId, directories]);

  useEffect(() => {
    if (directoryEntries.length === 0) {
      if (activeDirectoryEntryKey !== null) {
        setActiveDirectoryEntryKey(null);
      }
      return;
    }
    if (!activeDirectoryEntryKey || !directoryEntries.some((entry) => entry.key === activeDirectoryEntryKey)) {
      setActiveDirectoryEntryKey(directoryEntries[0].key);
    }
  }, [activeDirectoryEntryKey, directoryEntries]);

  useEffect(() => {
    if (state.activeView !== 'todos' || !activeTodo) {
      return;
    }

    document.querySelector<HTMLElement>(`[data-todo-id="${activeTodo.id}"]`)?.scrollIntoView({
      block: 'nearest',
      behavior: 'smooth',
    });
  }, [activeTodo, state.activeView]);

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
    if (node.todoStatus === todo.status) {
      return;
    }
    dispatch({
      type: 'mergeRemotePage',
      page: {
        ...page,
        nodes: page.nodes.map((entry) => (
          entry.id === node.id
            ? { ...entry, todoStatus: todo.status, todoId: todo.id, updatedAt: todo.updatedAt || entry.updatedAt }
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

      const { documents, directories: nextDirectories } = await listDocuments(backendUrl, nextToken, nextWorkspaceId);
      const pages = documents.map(documentToOutlinePage);
      applyRemotePages(pages);
      setDirectories(nextDirectories);
      setWorkspaceId(nextWorkspaceId);
      setSyncMessage(`Loaded ${documents.length} document${documents.length === 1 ? '' : 's'} and ${nextDirectories.length} director${nextDirectories.length === 1 ? 'y' : 'ies'}.`);
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

  const flushDirtyPages = useCallback(async (snapshotOverride?: OutlinePage[]) => {
    if (!syncEnabled) {
      return;
    }

    if (flushPromiseRef.current) {
      await flushPromiseRef.current;
      if (!snapshotOverride) {
        return;
      }
    }

    const run = (async () => {
      const snapshot = snapshotOverride ?? pagesRef.current;
      let savedAnyPage = false;
      for (const nextPage of snapshot) {
        const nextHash = pageHash(nextPage);
        if (lastSavedHashesRef.current.get(nextPage.id) === nextHash) {
          continue;
        }

        const savedDocument = await saveDocument(backendUrl, authToken, outlinePageToDocument(nextPage, workspaceId!));
        const savedPage = documentToOutlinePage(savedDocument);
        dispatch({ type: 'mergeRemotePage', page: savedPage, previousPageId: nextPage.id });
        lastSavedHashesRef.current.set(savedPage.id, pageHash(savedPage));
        savedAnyPage = true;
      }

      if (savedAnyPage && userId) {
        await loadTodoList();
      }
    })();

    flushPromiseRef.current = run.finally(() => {
      flushPromiseRef.current = null;
    });
    await flushPromiseRef.current;
  }, [authToken, backendUrl, dispatch, loadTodoList, syncEnabled, userId, workspaceId]);

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
    const nextState = reduceOutlineState(stateRef.current, action);
    dispatch(action);

    if (!syncEnabled) {
      return;
    }

    void flushDirtyPages(getPagesForPersistence(nextState)).catch((error) => {
      setSyncMessage(error instanceof Error ? error.message : 'Save failed after navigation.');
    });
  }, [dispatch, flushDirtyPages, syncEnabled]);

  const getCurrentJumpLocation = useCallback((): JumpLocation | null => {
    const currentPage = stateRef.current.pages.find((entry) => entry.id === stateRef.current.activePageId) ?? null;
    if (!currentPage) {
      return null;
    }

    return {
      pageId: currentPage.id,
      focusedId: currentPage.nodes.some((entry) => entry.id === stateRef.current.focusedId)
        ? stateRef.current.focusedId
        : currentPage.nodes[0]?.id ?? '',
    };
  }, []);

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
  }, [dispatch, dispatchAfterFlush]);

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
  }, [dispatch, dispatchAfterFlush, getCurrentJumpLocation, pushJumpBack]);

  const openDirectoryBrowser = useCallback(() => {
    const activeNote = page?.kind === 'note' ? page : null;
    const nextDirectoryId = activeNote?.directoryId ?? null;
    setActiveDirectoryId(nextDirectoryId);
    setActiveDirectoryEntryKey(activeNote ? `note-${activeNote.id}` : null);
    dispatchAfterFlush({ type: 'openDirectory' });
  }, [dispatchAfterFlush, page]);

  const enterDirectory = useCallback((directoryId: number | null) => {
    setActiveDirectoryId(directoryId);
    setActiveDirectoryEntryKey(null);
  }, []);

  const openDirectoryEntry = useCallback((entry: DirectoryEntry | null) => {
    if (!entry) {
      return;
    }
    if (entry.kind === 'directory') {
      enterDirectory(entry.directory?.id ?? null);
      return;
    }
    if (entry.page) {
      navigateToPage(entry.page, { recordJump: true });
    }
  }, [enterDirectory, navigateToPage]);

  const openCreateDirectoryPrompt = useCallback(() => {
    setDirectoryPrompt({ kind: 'create-directory' });
    setDirectoryPromptValue('');
  }, []);

  const openRenameDirectoryPrompt = useCallback((directory: BackendDirectory) => {
    setDirectoryPrompt({ kind: 'rename-directory', directoryId: directory.id });
    setDirectoryPromptValue(directory.name);
  }, []);

  const openRenameNotePrompt = useCallback((entryPage: OutlinePage) => {
    setDirectoryPrompt({ kind: 'rename-note', pageId: entryPage.id });
    setDirectoryPromptValue(entryPage.title);
  }, []);

  const upsertDirectory = useCallback((directory: BackendDirectory) => {
    setDirectories((current) => {
      const existingIndex = current.findIndex((entry) => entry.id === directory.id);
      if (existingIndex === -1) {
        return [...current, directory];
      }
      return current.map((entry, index) => (index === existingIndex ? directory : entry));
    });
  }, []);

  const renameDirectoryEntry = useCallback(async () => {
    if (!activeDirectoryEntry) {
      return;
    }
    if (activeDirectoryEntry.kind === 'directory') {
      if (activeDirectoryEntry.directory) {
        openRenameDirectoryPrompt(activeDirectoryEntry.directory);
      }
      return;
    }

    if (!activeDirectoryEntry.page) {
      return;
    }
    openRenameNotePrompt(activeDirectoryEntry.page);
  }, [activeDirectoryEntry, openRenameDirectoryPrompt, openRenameNotePrompt]);

  const clearPendingDirectoryMove = useCallback(() => {
    if (pendingDirectoryMoveTimerRef.current) {
      window.clearTimeout(pendingDirectoryMoveTimerRef.current);
      pendingDirectoryMoveTimerRef.current = null;
    }
    lastDirectoryDPressRef.current = null;
  }, []);

  const createDirectoryHere = useCallback(async () => {
    if (isSubmittingDirectoryPrompt) {
      return;
    }
    const name = directoryPromptValue.trim();
    if (!name) {
      return;
    }
    if (!authToken || !workspaceId) {
      setSyncMessage('Log in first to create directories.');
      return;
    }
    setIsSubmittingDirectoryPrompt(true);
    try {
      const savedDirectory = await createDirectory(backendUrl, authToken, workspaceId, activeDirectoryId ?? 0, name);
      upsertDirectory(savedDirectory);
      setActiveDirectoryEntryKey(`directory-${savedDirectory.id}`);
      setDirectoryPrompt(null);
      setDirectoryPromptValue('');
      setSyncMessage(`Created ${savedDirectory.name}.`);
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Directory create failed.');
    } finally {
      setIsSubmittingDirectoryPrompt(false);
    }
  }, [activeDirectoryId, authToken, backendUrl, directoryPromptValue, isSubmittingDirectoryPrompt, upsertDirectory, workspaceId]);

  const submitDirectoryPrompt = useCallback(async () => {
    if (!directoryPrompt || isSubmittingDirectoryPrompt) {
      return;
    }
    if (directoryPrompt.kind === 'create-directory') {
      await createDirectoryHere();
      return;
    }
    if (directoryPrompt.kind === 'rename-directory') {
      const nextName = directoryPromptValue.trim();
      const target = directories.find((entry) => entry.id === directoryPrompt.directoryId);
      if (!target || !nextName || nextName === target.name) {
        setDirectoryPrompt(null);
        return;
      }
      if (!authToken) {
        setSyncMessage('Log in first to rename directories.');
        return;
      }
      setIsSubmittingDirectoryPrompt(true);
      try {
        const savedDirectory = await updateDirectory(backendUrl, authToken, target.id, nextName, target.parentId);
        upsertDirectory(savedDirectory);
        setDirectoryPrompt(null);
        setDirectoryPromptValue('');
        setSyncMessage(`Renamed directory to ${savedDirectory.name}.`);
      } catch (error) {
        setSyncMessage(error instanceof Error ? error.message : 'Directory rename failed.');
      } finally {
        setIsSubmittingDirectoryPrompt(false);
      }
      return;
    }
    const nextTitle = directoryPromptValue.trim();
    const pageToRename = stateRef.current.pages.find((entry) => entry.id === directoryPrompt.pageId && entry.kind === 'note');
    if (!pageToRename || !nextTitle || nextTitle === pageToRename.title) {
      setDirectoryPrompt(null);
      return;
    }
    const renamedPage = { ...pageToRename, title: nextTitle };
    dispatch({ type: 'mergeRemotePage', page: renamedPage, previousPageId: pageToRename.id });
    setIsSubmittingDirectoryPrompt(true);
    try {
      if (syncEnabled) {
        const savedDocument = await saveDocument(backendUrl, authToken, outlinePageToDocument(renamedPage, workspaceId!));
        dispatch({ type: 'mergeRemotePage', page: documentToOutlinePage(savedDocument), previousPageId: pageToRename.id });
      }
      setDirectoryPrompt(null);
      setDirectoryPromptValue('');
      setSyncMessage(`Renamed note to ${nextTitle}.`);
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Note rename failed.');
    } finally {
      setIsSubmittingDirectoryPrompt(false);
    }
  }, [authToken, backendUrl, createDirectoryHere, directories, directoryPrompt, directoryPromptValue, dispatch, isSubmittingDirectoryPrompt, syncEnabled, upsertDirectory, workspaceId]);

  const deleteSelectedDirectory = useCallback(async () => {
    if (!activeDirectoryEntry || activeDirectoryEntry.kind !== 'directory' || !activeDirectoryEntry.directory) {
      return;
    }
    if (!authToken) {
      setSyncMessage('Log in first to delete directories.');
      return;
    }
    try {
      await deleteDirectory(backendUrl, authToken, activeDirectoryEntry.directory.id);
      setDirectories((current) => current.filter((entry) => entry.id !== activeDirectoryEntry.directory?.id));
      setActiveDirectoryEntryKey(null);
      setSyncMessage(`Deleted ${activeDirectoryEntry.directory.name}.`);
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Directory delete failed.');
    }
  }, [activeDirectoryEntry, authToken, backendUrl]);

  const duplicateNoteIntoDirectory = useCallback(async (sourcePage: OutlinePage, targetDirectoryId: number | null) => {
    if (!authToken || !workspaceId) {
      throw new Error('Log in first to copy directories.');
    }

    const nodeIdMap = new Map<string, string>();
    for (const node of sourcePage.nodes) {
      nodeIdMap.set(node.id, `node-${crypto.randomUUID()}`);
    }

    const duplicatedPage: OutlinePage = {
      ...sourcePage,
      id: `note-${crypto.randomUUID()}`,
      backendId: undefined,
      workspaceId,
      directoryId: targetDirectoryId,
      createdAt: undefined,
      updatedAt: undefined,
      nodes: sourcePage.nodes.map((node) => ({
        ...node,
        id: nodeIdMap.get(node.id) ?? `node-${crypto.randomUUID()}`,
        backendId: undefined,
        todoId: null,
        createdAt: undefined,
        updatedAt: undefined,
        parentId: node.parentId ? (nodeIdMap.get(node.parentId) ?? null) : null,
      })),
    };

    const savedDocument = await saveDocument(backendUrl, authToken, outlinePageToDocument(duplicatedPage, workspaceId));
    const savedPage = documentToOutlinePage(savedDocument);
    dispatch({ type: 'mergeRemotePage', page: savedPage });
    return savedPage;
  }, [authToken, backendUrl, dispatch, workspaceId]);

  const duplicateDirectoryIntoParent = useCallback(async (sourceDirectory: BackendDirectory, targetParentId: number | null) => {
    if (!authToken || !workspaceId) {
      throw new Error('Log in first to copy directories.');
    }

    const savedDirectory = await createDirectory(backendUrl, authToken, workspaceId, targetParentId ?? 0, sourceDirectory.name);
    upsertDirectory(savedDirectory);

    const childNotes = stateRef.current.pages
      .filter((entry) => entry.kind === 'note' && (entry.directoryId ?? 0) === sourceDirectory.id)
      .sort((left, right) => getPageTitle(left).localeCompare(getPageTitle(right)) || left.id.localeCompare(right.id));
    for (const childNote of childNotes) {
      await duplicateNoteIntoDirectory(childNote, savedDirectory.id);
    }

    const childDirectories = directories
      .filter((entry) => (entry.parentId || 0) === sourceDirectory.id)
      .sort((left, right) => left.position - right.position || left.name.localeCompare(right.name) || left.id - right.id);
    for (const childDirectory of childDirectories) {
      await duplicateDirectoryIntoParent(childDirectory, savedDirectory.id);
    }

    return savedDirectory;
  }, [authToken, backendUrl, directories, duplicateNoteIntoDirectory, upsertDirectory, workspaceId]);

  const pasteClipboardHere = useCallback(async () => {
    if (!directoryClipboard) {
      setSyncMessage('Clipboard is empty. Use d on a note or directory, or y on a directory first.');
      return;
    }

    if (directoryClipboard.kind === 'note') {
      const clipboardPage = stateRef.current.pages.find((entry) => entry.id === directoryClipboard.pageId && entry.kind === 'note');
      if (!clipboardPage) {
        setSyncMessage('Clipboard note is no longer available.');
        return;
      }
      const movedPage = { ...clipboardPage, directoryId: activeDirectoryId ?? null };
      dispatch({ type: 'mergeRemotePage', page: movedPage, previousPageId: clipboardPage.id });
      try {
        if (syncEnabled) {
          const savedDocument = await saveDocument(backendUrl, authToken, outlinePageToDocument(movedPage, workspaceId!));
          dispatch({ type: 'mergeRemotePage', page: documentToOutlinePage(savedDocument), previousPageId: clipboardPage.id });
        }
        setActiveDirectoryEntryKey(`note-${movedPage.id}`);
        setDirectoryClipboard(null);
        setSyncMessage(`Moved ${getPageTitle(movedPage)}.`);
      } catch (error) {
        setSyncMessage(error instanceof Error ? error.message : 'Move failed.');
      }
      return;
    }

    const sourceDirectory = directories.find((entry) => entry.id === directoryClipboard.directoryId);
    if (!sourceDirectory) {
      setSyncMessage('Clipboard directory is no longer available.');
      return;
    }

    if (directoryClipboard.mode === 'move') {
      if (!authToken) {
        setSyncMessage('Log in first to move directories.');
        return;
      }
      try {
        const savedDirectory = await updateDirectory(
          backendUrl,
          authToken,
          sourceDirectory.id,
          sourceDirectory.name,
          activeDirectoryId ?? 0,
        );
        upsertDirectory(savedDirectory);
        setDirectoryClipboard(null);
        setActiveDirectoryEntryKey(`directory-${savedDirectory.id}`);
        setSyncMessage(`Moved ${savedDirectory.name}.`);
      } catch (error) {
        setSyncMessage(error instanceof Error ? error.message : 'Directory move failed.');
      }
      return;
    }

    try {
      const savedDirectory = await duplicateDirectoryIntoParent(sourceDirectory, activeDirectoryId ?? null);
      setActiveDirectoryEntryKey(`directory-${savedDirectory.id}`);
      setSyncMessage(`Copied ${sourceDirectory.name}.`);
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Directory copy failed.');
    }
  }, [activeDirectoryId, authToken, backendUrl, directories, directoryClipboard, dispatch, duplicateDirectoryIntoParent, syncEnabled, upsertDirectory, workspaceId]);

  const cutSelectedNoteToClipboard = useCallback(() => {
    if (!activeDirectoryEntry || activeDirectoryEntry.kind !== 'note' || !activeDirectoryEntry.page) {
      setSyncMessage('Select a note to move.');
      return;
    }
    setDirectoryClipboard({ kind: 'note', pageId: activeDirectoryEntry.page.id, mode: 'move' });
    setSyncMessage(`Ready to move ${getPageTitle(activeDirectoryEntry.page)}. Press p in the destination directory.`);
  }, [activeDirectoryEntry]);

  const copySelectedDirectoryToClipboard = useCallback(() => {
    if (!activeDirectoryEntry || activeDirectoryEntry.kind !== 'directory' || !activeDirectoryEntry.directory) {
      setSyncMessage('Select a directory to copy.');
      return;
    }
    clearPendingDirectoryMove();
    setDirectoryClipboard({ kind: 'directory', directoryId: activeDirectoryEntry.directory.id, mode: 'copy' });
    setSyncMessage(`Ready to copy ${activeDirectoryEntry.directory.name}. Press p in the destination directory.`);
  }, [activeDirectoryEntry, clearPendingDirectoryMove]);

  const moveSelectedDirectoryToClipboard = useCallback(() => {
    if (!activeDirectoryEntry || activeDirectoryEntry.kind !== 'directory' || !activeDirectoryEntry.directory) {
      setSyncMessage('Select a directory to move.');
      return;
    }
    clearPendingDirectoryMove();
    setDirectoryClipboard({ kind: 'directory', directoryId: activeDirectoryEntry.directory.id, mode: 'move' });
    setSyncMessage(`Ready to move ${activeDirectoryEntry.directory.name}. Press p in the destination directory.`);
  }, [activeDirectoryEntry, clearPendingDirectoryMove]);

  const activeNotePage = page?.kind === 'note' ? page : null;
  const canDeleteNote = state.activeView === 'note' && activeNotePage !== null;
  const pendingDeleteNote = pendingDeleteNoteId
    ? state.pages.find((entry) => entry.id === pendingDeleteNoteId && entry.kind === 'note') ?? null
    : null;

  const handleDeleteNote = useCallback(() => {
    console.log('[toolbar] delete note pressed', {
      activeView: state.activeView,
      activePageId: state.activePageId,
      activeNotePageId: activeNotePage?.id ?? null,
      activeNoteBackendId: activeNotePage?.backendId ?? null,
      syncEnabled,
    });

    if (!activeNotePage || state.activeView !== 'note') {
      console.log('[toolbar] delete note blocked: no active note view');
      setIsToolbarMenuOpen(false);
      setSyncMessage('Open a note to delete it.');
      return;
    }

    setIsToolbarMenuOpen(false);

    console.log('[toolbar] opening inline delete confirmation');
    setPendingDeleteNoteId(activeNotePage.id);
  }, [activeNotePage, syncEnabled, state.activeView, state.activePageId]);

  const confirmDeleteNote = useCallback(() => {
    if (!pendingDeleteNote) {
      setPendingDeleteNoteId(null);
      return;
    }

    setPendingDeleteNoteId(null);

    if (pendingDeleteNote.backendId && syncEnabled) {
      console.log('[toolbar] deleting synced note', { backendId: pendingDeleteNote.backendId });
      void (async () => {
        try {
          await flushDirtyPages();
          await deleteDocument(backendUrl, authToken, pendingDeleteNote.backendId!);
          dispatch({ type: 'deleteNote', pageId: pendingDeleteNote.id });
          setSyncMessage(`Deleted ${getPageTitle(pendingDeleteNote)}.`);
        } catch (error) {
          console.error('[toolbar] synced delete failed', error);
          setSyncMessage(error instanceof Error ? error.message : 'Delete failed.');
        }
      })();
      return;
    }

    console.log('[toolbar] deleting local note', { pageId: pendingDeleteNote.id });
    dispatch({ type: 'deleteNote', pageId: pendingDeleteNote.id });
    setSyncMessage(`Deleted ${getPageTitle(pendingDeleteNote)}.`);
  }, [authToken, backendUrl, dispatch, flushDirtyPages, pendingDeleteNote, syncEnabled]);

  const openSettingsFromMenu = useCallback(() => {
    setIsToolbarMenuOpen(false);
    dispatchAfterFlush({ type: 'openSettings' });
  }, [dispatchAfterFlush]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const isFormTarget = target instanceof HTMLElement && (
        target.isContentEditable
        || target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.tagName === 'SELECT'
      );

      if (event.key === 'Escape' && isToolbarMenuOpen) {
        event.preventDefault();
        setIsToolbarMenuOpen(false);
        return;
      }

      if (event.key === 'Escape' && pendingDeleteNoteId) {
        event.preventDefault();
        setPendingDeleteNoteId(null);
        return;
      }

      if (event.key === 'Escape' && isDocumentLinkPickerOpen) {
        event.preventDefault();
        setIsDocumentLinkPickerOpen(false);
        setDocumentLinkQuery('');
        setActiveDocumentLinkResultId(null);
        return;
      }

      if (event.key === 'Escape' && (state.activeView === 'search' || state.activeView === 'settings' || state.activeView === 'todos' || state.activeView === 'directory')) {
        event.preventDefault();
        setSearchQuery('');
        setDirectoryPrompt(null);
        lastTodoGPressRef.current = null;
        dispatchAfterFlush({ type: 'selectJournal' });
        return;
      }

      if (state.activeView === 'directory' && directoryPrompt && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (event.key === 'Escape') {
          event.preventDefault();
          setDirectoryPrompt(null);
          setDirectoryPromptValue('');
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          void submitDirectoryPrompt();
          return;
        }
      }

      if (state.activeView === 'directory' && !event.metaKey && !event.ctrlKey && !event.altKey && !isFormTarget) {
        const currentIndex = activeDirectoryEntry ? directoryEntries.findIndex((entry) => entry.key === activeDirectoryEntry.key) : -1;
        const lowerKey = event.key.length === 1 ? event.key.toLowerCase() : event.key;
        const moveSelection = (direction: 1 | -1) => {
          if (directoryEntries.length === 0) {
            return;
          }
          const nextIndex = currentIndex === -1
            ? 0
            : Math.max(0, Math.min(directoryEntries.length - 1, currentIndex + direction));
          setActiveDirectoryEntryKey(directoryEntries[nextIndex]?.key ?? null);
        };

        if (lowerKey === 'a') {
          event.preventDefault();
          openCreateDirectoryPrompt();
          return;
        }

        if (lowerKey === 'r') {
          event.preventDefault();
          void renameDirectoryEntry();
          return;
        }

        if (lowerKey === 'p') {
          event.preventDefault();
          clearPendingDirectoryMove();
          void pasteClipboardHere();
          return;
        }

        if (lowerKey === 'd') {
          event.preventDefault();
          if (activeDirectoryEntry?.kind === 'directory') {
            if (lastDirectoryDPressRef.current && Date.now() - lastDirectoryDPressRef.current <= 320) {
              clearPendingDirectoryMove();
              void deleteSelectedDirectory();
              return;
            }

            clearPendingDirectoryMove();
            lastDirectoryDPressRef.current = Date.now();
            pendingDirectoryMoveTimerRef.current = window.setTimeout(() => {
              moveSelectedDirectoryToClipboard();
              pendingDirectoryMoveTimerRef.current = null;
              lastDirectoryDPressRef.current = null;
            }, 320);
            return;
          }

          clearPendingDirectoryMove();
          cutSelectedNoteToClipboard();
          return;
        }

        if (lowerKey === 'y') {
          event.preventDefault();
          clearPendingDirectoryMove();
          copySelectedDirectoryToClipboard();
          return;
        }

        clearPendingDirectoryMove();

        if (event.key === 'j' || event.key === 'ArrowDown') {
          event.preventDefault();
          moveSelection(1);
          return;
        }

        if (event.key === 'k' || event.key === 'ArrowUp') {
          event.preventDefault();
          moveSelection(-1);
          return;
        }

        if (event.key === 'h' || event.key === 'ArrowLeft') {
          if (!currentDirectory) {
            return;
          }
          event.preventDefault();
          enterDirectory(currentDirectory.parentId || null);
          return;
        }

        if (event.key === 'l' || event.key === 'ArrowRight') {
          if (!activeDirectoryEntry || activeDirectoryEntry.kind !== 'directory') {
            return;
          }
          event.preventDefault();
          openDirectoryEntry(activeDirectoryEntry);
          return;
        }

        if (event.key === 'Enter') {
          if (!activeDirectoryEntry) {
            return;
          }
          event.preventDefault();
          openDirectoryEntry(activeDirectoryEntry);
          return;
        }
      }

      if (state.activeView === 'todos' && !event.metaKey && !event.ctrlKey && !event.altKey && !isFormTarget) {
        const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

        if (key === 'g') {
          event.preventDefault();
          if (lastTodoGPressRef.current && Date.now() - lastTodoGPressRef.current <= 320) {
            if (filteredTodos.length > 0) {
              setActiveTodoId(filteredTodos[0].id);
            }
            lastTodoGPressRef.current = null;
            return;
          }

          lastTodoGPressRef.current = Date.now();
          return;
        }

        lastTodoGPressRef.current = null;

        if (event.key === 'j' || event.key === 'ArrowDown') {
          if (filteredTodos.length === 0) {
            return;
          }
          event.preventDefault();
          const currentIndex = activeTodo ? filteredTodos.findIndex((todo) => todo.id === activeTodo.id) : -1;
          const nextTodo = filteredTodos[Math.min(filteredTodos.length - 1, currentIndex + 1)] ?? filteredTodos[0];
          setActiveTodoId(nextTodo.id);
          return;
        }

        if (event.key === 'k' || event.key === 'ArrowUp') {
          if (filteredTodos.length === 0) {
            return;
          }
          event.preventDefault();
          const currentIndex = activeTodo ? filteredTodos.findIndex((todo) => todo.id === activeTodo.id) : filteredTodos.length;
          const nextTodo = filteredTodos[Math.max(0, currentIndex - 1)] ?? filteredTodos[0];
          setActiveTodoId(nextTodo.id);
          return;
        }

        if (event.key === 'Enter' && activeTodo) {
          event.preventDefault();
          openTodoSource(activeTodo);
          return;
        }
      } else {
        lastTodoGPressRef.current = null;
      }

      if (state.activeView === 'todos' && (event.metaKey || event.ctrlKey) && event.shiftKey && !isFormTarget) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          cycleActiveTodoStatus(1);
          return;
        }

        if (event.key === 'ArrowUp') {
          event.preventDefault();
          cycleActiveTodoStatus(-1);
          return;
        }
      }

      if (!event.metaKey && event.ctrlKey && !event.altKey && !isFormTarget) {
        const lowerKey = event.key.toLowerCase();
        if (lowerKey === 'o') {
          event.preventDefault();
          jumpBack();
          return;
        }

        if (lowerKey === 'i' || event.key === 'Tab') {
          event.preventDefault();
          jumpForward();
          return;
        }
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
        setSearchMode('insert');
        setSearchScope('title');
        setActiveSearchResultId(null);
        lastSearchJPressRef.current = null;
        dispatchAfterFlush({ type: 'openSearch' });
        return;
      }

      if (event.key.toLowerCase() === 'o') {
        event.preventDefault();
        openDirectoryBrowser();
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
  }, [
    activeDirectoryEntry,
    activeTodo,
    clearPendingDirectoryMove,
    copySelectedDirectoryToClipboard,
    createDirectoryHere,
    currentDirectory,
    cycleActiveTodoStatus,
    cutSelectedNoteToClipboard,
    deleteSelectedDirectory,
    directoryEntries,
    directoryPrompt,
    dispatchAfterFlush,
    enterDirectory,
    filteredTodos,
    isToolbarMenuOpen,
    isDocumentLinkPickerOpen,
    jumpBack,
    jumpForward,
    moveSelectedDirectoryToClipboard,
    pendingDeleteNoteId,
    openDirectoryBrowser,
    openCreateDirectoryPrompt,
    openDirectoryEntry,
    moveActiveSearchResult,
    pasteClipboardHere,
    renameDirectoryEntry,
    state.activeView,
    submitDirectoryPrompt,
  ]);

  const toolbarMenu = (
    <div className="toolbar-menu-shell" ref={toolbarMenuRef}>
      <button
        type="button"
        className="settings-trigger"
        aria-label="Open menu"
        aria-expanded={isToolbarMenuOpen}
        onClick={() => setIsToolbarMenuOpen((current) => !current)}
      >
        <span />
        <span />
        <span />
      </button>

      {isToolbarMenuOpen ? (
        <div className="toolbar-menu-dropdown" role="menu" aria-label="Workspace menu">
          <button
            type="button"
            className="toolbar-menu-item"
            role="menuitem"
            data-disabled={canDeleteNote ? 'false' : 'true'}
            onMouseDown={(event) => {
              console.log('[toolbar] delete note mouse down');
              event.preventDefault();
              handleDeleteNote();
            }}
          >
            Delete Note
          </button>
          <button type="button" className="toolbar-menu-item" role="menuitem" disabled>
            Export to Markdown
          </button>
          <button type="button" className="toolbar-menu-item" role="menuitem" disabled>
            See properties
          </button>
          <button type="button" className="toolbar-menu-item" role="menuitem" disabled>
            Reindex for AI
          </button>
          <button type="button" className="toolbar-menu-item toolbar-menu-item-settings" role="menuitem" onClick={openSettingsFromMenu}>
            Settings
          </button>
        </div>
      ) : null}
    </div>
  );

  const openDocumentLinkTarget = useCallback((targetDocumentId: number) => {
    const targetPage = stateRef.current.pages.find((entry) => entry.backendId === targetDocumentId) ?? null;
    if (!targetPage) {
      setSyncMessage('Linked document is not loaded locally yet. Sync to refresh documents.');
      return;
    }
    navigateToPage(targetPage, { recordJump: true });
  }, [navigateToPage]);

  if (!page) {
    return (
      <main className="app-shell">
        <section className="page-shell" data-center-column={centerColumn}>
          <header className="workspace-toolbar">{toolbarMenu}</header>

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
    const targetPage = state.pages.find((entry) => entry.id === pageId) ?? null;
    if (targetPage) {
      navigateToPage(targetPage, { recordJump: true });
    }
    setSearchQuery('');
    setSearchMode('insert');
    setActiveSearchResultId(null);
  };

  const openDocumentLinkPicker = () => {
    setDocumentLinkQuery('');
    setActiveDocumentLinkResultId(null);
    setIsDocumentLinkPickerOpen(true);
  };

  const closeDocumentLinkPicker = () => {
    setIsDocumentLinkPickerOpen(false);
    setDocumentLinkQuery('');
    setActiveDocumentLinkResultId(null);
  };

  const moveActiveDocumentLinkResult = (direction: 1 | -1) => {
    if (documentLinkMatches.length === 0) {
      return;
    }

    setActiveDocumentLinkResultId((current) => {
      const currentIndex = current ? documentLinkMatches.findIndex((entry) => entry.id === current) : -1;
      const baseIndex = currentIndex === -1 ? 0 : currentIndex;
      const nextIndex = Math.max(0, Math.min(documentLinkMatches.length - 1, baseIndex + direction));
      return documentLinkMatches[nextIndex]?.id ?? documentLinkMatches[0].id;
    });
  };

  const insertDocumentLink = (targetPage: OutlinePage | null) => {
    if (!targetPage || !targetPage.backendId) {
      return;
    }

    dispatch({ type: 'insertTextAtCursor', text: `[[doc:${targetPage.backendId}|${getPageTitle(targetPage)}]]` });
    closeDocumentLinkPicker();
  };

  const followDocumentLink = () => {
    const currentPage = stateRef.current.pages.find((entry) => entry.id === stateRef.current.activePageId) ?? null;
    const currentNode = currentPage?.nodes.find((entry) => entry.id === stateRef.current.focusedId) ?? null;
    if (!currentNode) {
      return;
    }

    const link = findDocumentLinkAtCursor(currentNode.text, stateRef.current.normalCursor);
    if (!link) {
      setSyncMessage('No document link under cursor.');
      return;
    }

    openDocumentLinkTarget(link.targetDocumentId);
  };

  const submitSearch = () => {
    const nextTitle = searchQuery.trim();
    if (!nextTitle) {
      return;
    }

    if (activeSearchMatch) {
      openSearchResult(activeSearchMatch.id);
      return;
    }

    dispatch({ type: 'createNote', title: nextTitle });
    setSearchQuery('');
    setSearchMode('insert');
    setActiveSearchResultId(null);
  };

  function moveActiveSearchResult(direction: 1 | -1) {
    if (visibleMatches.length === 0) {
      return;
    }

    setSearchMode('select');
    setActiveSearchResultId((current) => {
      const currentIndex = current ? visibleMatches.findIndex((entry) => entry.page.id === current) : -1;
      const baseIndex = currentIndex === -1 ? 0 : currentIndex;
      const nextIndex = Math.max(0, Math.min(visibleMatches.length - 1, baseIndex + direction));
      return visibleMatches[nextIndex]?.page.id ?? visibleMatches[0].page.id;
    });
  }

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
    setDirectories([]);
    setTodos([]);
    setSyncMessage('Logged out.');
    bootSyncRef.current = false;
  };

  const openTodoSource = (todo: BackendTodo) => {
    if (!todo.sourceDocumentId) {
      if (todo.createdAtRecordingName) {
        setSyncMessage('Opening recording sources is not available yet in the native app.');
      }
      return;
    }
    const sourcePage = state.pages.find((entry) => entry.backendId === todo.sourceDocumentId);
    if (!sourcePage) {
      setSyncMessage('Source page is not loaded locally yet. Sync to refresh documents.');
      return;
    }

    if (!todo.sourceBlockId) {
      navigateToPage(sourcePage, { recordJump: true });
      return;
    }

    const node = sourcePage.nodes.find((entry) => entry.backendId === todo.sourceBlockId || entry.todoId === todo.id);
    navigateToPage(sourcePage, { focusNodeId: node?.id, recordJump: true });
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

  function cycleActiveTodoStatus(direction: 1 | -1) {
    if (!activeTodo || updatingTodoId === activeTodo.id) {
      return;
    }
    void handleTodoStatusChange(activeTodo, cycleTodoStatus(activeTodo.status, direction));
  }

  return (
    <main className="app-shell">
      <section className="page-shell" data-center-column={centerColumn}>
        <header className="workspace-toolbar">{toolbarMenu}</header>

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
                      <OutlineEditor
                        page={journal}
                        state={state}
                        dispatch={dispatch}
                        onOpenDocumentLinkPicker={openDocumentLinkPicker}
                        onFollowDocumentLink={followDocumentLink}
                        onOpenDocumentLink={openDocumentLinkTarget}
                      />
                    ) : (
                      <div className="journal-preview">
                        {journal.nodes.map((node) => (
                          <div
                            key={node.id}
                            className="row journal-preview-row"
                            data-has-status={Boolean(node.todoStatus)}
                            data-focused="false"
                            data-selected="false"
                            data-editing="false"
                            style={{ paddingLeft: `${12 + getNodeDepth(journal.nodes, node.id) * 24}px` }}
                          >
                            <span className="row-gutter" aria-hidden="true">
                              •
                            </span>
                            {node.todoStatus ? (
                              <span
                                role="button"
                                tabIndex={-1}
                                className="status-chip status-chip-button"
                                data-status={node.todoStatus}
                                onClick={() => dispatch({ type: 'toggleNodeStatus', nodeId: node.id })}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    dispatch({ type: 'toggleNodeStatus', nodeId: node.id });
                                  }
                                }}
                              >
                                {formatInlineTodoStatus(node.todoStatus)}
                              </span>
                            ) : null}
                            <div className="row-content journal-preview-content">
                              <p className="row-text" data-status={node.todoStatus ?? 'none'}>
                                <OutlineText
                                  text={node.text}
                                  pagesByBackendId={pagesByBackendId}
                                  onOpenDocumentLink={openDocumentLinkTarget}
                                />
                              </p>
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
            <header className="page-header note-header-sticky">
              {page.kind === 'note' ? <p className="page-date">{getPageDateLabel(page)}</p> : null}
              <div className="page-heading-row">
                <input
                  className="page-title-input"
                  type="text"
                  value={page.title}
                  placeholder="Untitled note"
                  onChange={(event) => dispatch({ type: 'updatePageTitle', title: event.target.value })}
                />
                {activeNoteDirectoryPath.length > 0 ? (
                  <span className="page-kind">{activeNoteDirectoryPath.map((entry) => entry.name).join(' / ')}</span>
                ) : null}
              </div>
            </header>

             <OutlineEditor
               page={page}
               state={state}
               dispatch={dispatch}
               onOpenDocumentLinkPicker={openDocumentLinkPicker}
               onFollowDocumentLink={followDocumentLink}
               onOpenDocumentLink={openDocumentLinkTarget}
             />
          </>
        ) : null}

        {state.activeView === 'directory' ? (
          <section className="directory-shell">
            <header className="page-header">
              <p className="page-date">Open note</p>
              <div className="page-heading-row page-heading-row-directory">
                <div>
                  <h2 className="page-title settings-title">Directories</h2>
                  <p className="directory-breadcrumb">
                    Root{directoryPath.length > 0 ? ` / ${directoryPath.map((entry) => entry.name).join(' / ')}` : ''}
                  </p>
                </div>
                <span className="page-kind">{directoryEntries.length}</span>
              </div>
            </header>

            <div className="directory-panel">
              {directoryPrompt ? (
                <div className="settings-card directory-inline-form">
                  <label className="settings-label" htmlFor="directory-prompt-input">
                    {directoryPrompt.kind === 'create-directory'
                      ? 'New directory'
                      : directoryPrompt.kind === 'rename-directory'
                        ? 'Rename directory'
                        : 'Rename note'}
                  </label>
                  <input
                    id="directory-prompt-input"
                    ref={directoryPromptInputRef}
                    className="settings-input"
                    type="text"
                    value={directoryPromptValue}
                    onChange={(event) => setDirectoryPromptValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        event.stopPropagation();
                        void submitDirectoryPrompt();
                      }
                    }}
                  />
                </div>
              ) : null}

              <div className="directory-toolbar">
                {directoryClipboardPage ? <span className="settings-message">Move note: {getPageTitle(directoryClipboardPage)}</span> : null}
                {directoryClipboardDirectory && directoryClipboard?.mode === 'move' ? <span className="settings-message">Move dir: {directoryClipboardDirectory.name}</span> : null}
                {directoryClipboardDirectory && directoryClipboard?.mode === 'copy' ? <span className="settings-message">Copy dir: {directoryClipboardDirectory.name}</span> : null}
              </div>

              <div className="search-results">
                {directoryEntries.length > 0 ? directoryEntries.map((entry, index) => {
                  const isActive = activeDirectoryEntry?.key === entry.key;
                  const previousEntry = index > 0 ? directoryEntries[index - 1] : null;
                  const startsNoteGroup = entry.kind === 'note' && previousEntry?.kind === 'directory';
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      className="search-result directory-result"
                      data-active={isActive ? 'true' : 'false'}
                      data-kind={entry.kind}
                      data-starts-note-group={startsNoteGroup ? 'true' : 'false'}
                      onClick={() => {
                        setActiveDirectoryEntryKey(entry.key);
                        openDirectoryEntry(entry);
                      }}
                    >
                      <span className="directory-result-icon" data-kind={entry.kind} aria-hidden="true">
                        <span className="directory-result-icon-shape" />
                      </span>
                      <span className="search-result-title">{entry.kind === 'directory' ? entry.directory?.name : getPageTitle(entry.page!)}</span>
                      <span className="search-result-date">{entry.kind === 'directory' ? 'Directory' : 'Note'}</span>
                    </button>
                  );
                }) : (
                  <div className="search-empty">Nothing here yet. Root-level notes still show up outside any directory.</div>
                )}
              </div>
            </div>
          </section>
        ) : null}

        {state.activeView === 'search' ? (
          <section className="search-shell">
            <header className="page-header search-header">
              <p className="page-date">New or existing note</p>
              <div className="page-heading-row page-heading-row-search">
                <span className="page-kind">{searchScope === 'title' ? 'Title' : 'Full text'}</span>
                <input
                  ref={searchInputRef}
                  className="page-title-input search-input"
                  type="text"
                  value={searchQuery}
                  placeholder="Type a note title"
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    const isPlainKey = !event.metaKey && !event.ctrlKey && !event.altKey;

                    if (event.key === 'Tab') {
                      event.preventDefault();
                      setSearchScope((current) => (current === 'title' ? 'fulltext' : 'title'));
                      setActiveSearchResultId(null);
                      return;
                    }

                    if (searchMode === 'select') {
                      if (event.key === 'j' || event.key === 'ArrowDown') {
                        event.preventDefault();
                        moveActiveSearchResult(1);
                        return;
                      }

                      if (event.key === 'k' || event.key === 'ArrowUp') {
                        event.preventDefault();
                        moveActiveSearchResult(-1);
                        return;
                      }

                      if (event.key === 'Enter') {
                        event.preventDefault();
                        submitSearch();
                        return;
                      }

                      if (isPlainKey && event.key.length === 1) {
                        setSearchMode('insert');
                        setActiveSearchResultId(null);
                        lastSearchJPressRef.current = event.key === 'j' ? Date.now() : null;
                      }

                      return;
                    }

                    if (isPlainKey && event.key === 'j') {
                      lastSearchJPressRef.current = Date.now();
                    } else if (
                      isPlainKey
                      && event.key === 'k'
                      && lastSearchJPressRef.current
                      && Date.now() - lastSearchJPressRef.current <= 250
                    ) {
                      event.preventDefault();
                      setSearchQuery((current) => (current.endsWith('j') ? current.slice(0, -1) : current));
                      setSearchMode('select');
                      setActiveSearchResultId(visibleMatches[0]?.page.id ?? null);
                      lastSearchJPressRef.current = null;
                      return;
                    } else {
                      lastSearchJPressRef.current = null;
                    }

                    if (event.key === 'Enter') {
                      event.preventDefault();
                      submitSearch();
                    }
                  }}
                />
              </div>
            </header>

            <div className="search-results">
              {visibleMatches.length > 0 ? (
                visibleMatches.map(({ page: match }) => (
                  <button
                    key={match.id}
                    type="button"
                    className="search-result"
                    data-active={activeSearchMatch?.id === match.id ? 'true' : 'false'}
                    onClick={() => openSearchResult(match.id)}
                  >
                    <span className="search-result-title">{getPageTitle(match)}</span>
                    <span className="search-result-date">{getPageDateLabel(match)}</span>
                  </button>
                ))
              ) : searchQuery.trim() && searchScope === 'title' ? (
                <button type="button" className="search-result search-result-create" data-active="true" onClick={submitSearch}>
                  <span className="search-result-title">Create "{searchQuery.trim()}"</span>
                  <span className="search-result-date">Press Enter to make a new page</span>
                </button>
              ) : searchQuery.trim() ? (
                <div className="search-empty">No full text matches. Press Shift+Tab for title matches.</div>
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

            <div className="todo-list-panel">
              <div className="todo-filter-row">
                {(['all', 'open', 'done', 'blocked', 'skipped'] as TodoFilter[]).map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    className="todo-filter-button"
                    data-active={todoFilter === filter}
                    onClick={() => {
                      setTodoFilter(filter);
                      setActiveTodoId(null);
                    }}
                  >
                    {filter}
                  </button>
                ))}
              </div>
              <div className="todo-list-scroll">
                <div className="search-results">
                  {!authToken || !userId ? (
                    <div className="search-empty">Log in again to load your todos.</div>
                  ) : isLoadingTodos ? (
                    <div className="search-empty">Loading todos...</div>
                  ) : filteredTodos.length === 0 ? (
                    <div className="search-empty">No todos yet. Mark a block as a task and it will show up here.</div>
                  ) : (
                    filteredTodos.map((todo) => (
                      <article
                        key={todo.id}
                        className="todo-card"
                        data-active={activeTodo?.id === todo.id ? 'true' : 'false'}
                        data-todo-id={todo.id}
                        onClick={() => setActiveTodoId(todo.id)}
                      >
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
                              <option value="todo">Todo</option>
                              <option value="doing">Doing</option>
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
              </div>
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
                <p className="settings-message">`Cmd+J` journals. `Cmd+K` note search. `Cmd+O` directories. `Cmd+T` todos. `Cmd+,` settings. `v` enters row selection. `[[` inserts a doc link. `gd` follows it. `Ctrl+O` / `Ctrl+I` move through jumps.</p>
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

        {isDocumentLinkPickerOpen ? (
          <div className="confirm-overlay" role="presentation" onClick={closeDocumentLinkPicker}>
            <div className="confirm-dialog document-link-dialog" role="dialog" aria-modal="true" aria-label="Insert document link" onClick={(event) => event.stopPropagation()}>
              <p className="page-date">Insert document link</p>
              <div className="page-heading-row page-heading-row-search">
                <h2 className="page-title settings-title">[[ target ]]</h2>
                <span className="page-kind">{documentLinkMatches.length}</span>
              </div>
              <input
                ref={documentLinkInputRef}
                className="page-title-input search-input"
                type="text"
                value={documentLinkQuery}
                placeholder="Find a note or journal"
                onChange={(event) => setDocumentLinkQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || event.key === 'j') {
                    event.preventDefault();
                    moveActiveDocumentLinkResult(1);
                    return;
                  }

                  if (event.key === 'ArrowUp' || event.key === 'k') {
                    event.preventDefault();
                    moveActiveDocumentLinkResult(-1);
                    return;
                  }

                  if (event.key === 'Enter') {
                    event.preventDefault();
                    insertDocumentLink(activeDocumentLinkMatch);
                    return;
                  }

                  if (event.key === 'Escape') {
                    event.preventDefault();
                    closeDocumentLinkPicker();
                  }
                }}
              />
              <div className="search-results document-link-results">
                {documentLinkMatches.length > 0 ? (
                  documentLinkMatches.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className="search-result document-link-result"
                      data-active={activeDocumentLinkMatch?.id === entry.id ? 'true' : 'false'}
                      data-kind={entry.kind}
                      onClick={() => insertDocumentLink(entry)}
                    >
                      <span className="search-result-title">{getPageTitle(entry)}</span>
                      <span className="search-result-date">{entry.kind === 'journal' ? 'Journal' : 'Note'} - {getPageDateLabel(entry)}</span>
                    </button>
                  ))
                ) : (
                  <div className="search-empty">No matching documents.</div>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {pendingDeleteNote ? (
          <div className="confirm-overlay" role="presentation" onClick={() => setPendingDeleteNoteId(null)}>
            <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label="Delete note confirmation" onClick={(event) => event.stopPropagation()}>
              <p className="page-date">Delete note</p>
              <h2 className="page-title settings-title">{getPageTitle(pendingDeleteNote)}</h2>
              <p className="settings-message">This deletes the note and its blocks.</p>
              <div className="confirm-actions">
                <button type="button" className="settings-button settings-button-secondary" onClick={() => setPendingDeleteNoteId(null)}>
                  Cancel
                </button>
                <button type="button" className="settings-button settings-button-danger" onClick={confirmDeleteNote}>
                  Delete Note
                </button>
              </div>
            </div>
          </div>
        ) : null}
        </div>
      </section>
    </main>
  );
}

export default App;
