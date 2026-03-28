import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject } from 'react';
import {
  createWorkspace,
  listDocuments,
  listWorkspaces,
  login,
  saveDocument,
  type BackendDirectory,
} from '../../lib/backend';
import { documentToOutlinePage, outlinePageToDocument } from '../outline/remote';
import { getPageTitle, getPagesForPersistence } from '../outline/tree';
import { reduceOutlineState, type OutlineAction } from '../outline/state';
import type { OutlinePage, OutlineState } from '../outline/types';
import { formatPanelTimestamp } from '../../app/format';
import { describeSaveFailure, findPageForPersistence, pageHash, pagePersistenceKey } from '../../app/pagePersistence';
import { SETTINGS_STORAGE_KEY, type PageSaveIndicator, type StoredSettings } from '../../app/types';

interface UseSessionSyncOptions {
  state: OutlineState;
  dispatch: Dispatch<OutlineAction>;
  onPagesSavedRef?: MutableRefObject<(() => Promise<void>) | null>;
}

export interface SessionSyncState {
  backendUrl: string;
  setBackendUrl: Dispatch<React.SetStateAction<string>>;
  email: string;
  setEmail: Dispatch<React.SetStateAction<string>>;
  password: string;
  setPassword: Dispatch<React.SetStateAction<string>>;
  centerColumn: boolean;
  setCenterColumn: Dispatch<React.SetStateAction<boolean>>;
  syncMessage: string;
  setSyncMessage: Dispatch<React.SetStateAction<string>>;
  authToken: string;
  userId: number | null;
  workspaceId: number | null;
  directories: BackendDirectory[];
  setDirectories: Dispatch<React.SetStateAction<BackendDirectory[]>>;
  isSyncing: boolean;
  bootstrapped: boolean;
  initialLoadResolved: boolean;
  syncEnabled: boolean;
  pagesForPersistence: OutlinePage[];
  pageSaveIndicators: Record<string, PageSaveIndicator>;
  activePageSaveMessage: string;
  activePageIsDirty: boolean;
  activePageHasNewerEdits: boolean;
  stateRef: MutableRefObject<OutlineState>;
  pagesRef: MutableRefObject<OutlinePage[]>;
  flushDirtyPages: (snapshotOverride?: OutlinePage[]) => Promise<void>;
  dispatchAfterFlush: (action: OutlineAction) => void;
  runLogin: () => Promise<void>;
  runSync: () => Promise<void>;
  handleLogout: () => void;
}

export function useSessionSync({ state, dispatch, onPagesSavedRef }: UseSessionSyncOptions): SessionSyncState {
  const [backendUrl, setBackendUrl] = useState('http://localhost:8080');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [centerColumn, setCenterColumn] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [userId, setUserId] = useState<number | null>(null);
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [directories, setDirectories] = useState<BackendDirectory[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [pageSaveIndicators, setPageSaveIndicators] = useState<Record<string, PageSaveIndicator>>({});
  const [bootstrapped, setBootstrapped] = useState(false);
  const [initialLoadResolved, setInitialLoadResolved] = useState(false);
  const stateRef = useRef(state);
  const pagesForPersistence = useMemo(() => getPagesForPersistence(state), [state]);
  const pagesRef = useRef(pagesForPersistence);
  const lastSavedHashesRef = useRef<Map<string, string>>(new Map());
  const saveTimerRef = useRef<number | null>(null);
  const flushPromiseRef = useRef<Promise<void> | null>(null);
  const pendingFlushRef = useRef(false);
  const bootSyncRef = useRef(false);
  const page = useMemo(
    () => state.pages.find((entry) => entry.id === state.activePageId) ?? null,
    [state.activePageId, state.pages],
  );
  const syncEnabled = Boolean(backendUrl.trim() && authToken && workspaceId);

  const activePagePersistenceKey = page ? pagePersistenceKey(page) : null;
  const activePageHash = useMemo(() => {
    if (!page) {
      return null;
    }
    const persistedPage = pagesForPersistence.find((entry) => entry.id === page.id) ?? page;
    return pageHash(persistedPage);
  }, [page, pagesForPersistence]);
  const activePageIsDirty = useMemo(() => {
    if (!page) {
      return false;
    }
    const persistedPage = pagesForPersistence.find((entry) => entry.id === page.id) ?? page;
    return lastSavedHashesRef.current.get(persistedPage.id) !== pageHash(persistedPage);
  }, [page, pagesForPersistence]);
  const activePageSaveIndicator = activePagePersistenceKey ? pageSaveIndicators[activePagePersistenceKey] ?? null : null;
  const activePageHasNewerEdits = Boolean(
    activePageHash
      && activePageSaveIndicator?.hash
      && activePageSaveIndicator.hash !== activePageHash,
  );
  const activePageSaveMessage = !page
    ? ''
    : activePageIsDirty
      ? activePageSaveIndicator?.status === 'failed' && !activePageHasNewerEdits
        ? `Save failed: ${activePageSaveIndicator.message}`
        : activePageSaveIndicator?.status === 'saving'
          ? 'Saving...'
          : 'Unsaved changes'
      : activePageSaveIndicator?.status === 'saving'
        ? 'Saving...'
        : activePageSaveIndicator?.status === 'failed'
          ? `Save failed: ${activePageSaveIndicator.message}`
          : activePageSaveIndicator?.status === 'saved'
            ? activePageSaveIndicator.message
            : '';

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

  const applyRemotePages = useCallback((nextPages: OutlinePage[]) => {
    dispatch({ type: 'hydrate', pages: nextPages });
    const hashes = new Map<string, string>();
    for (const nextPage of nextPages) {
      hashes.set(nextPage.id, pageHash(nextPage));
    }
    lastSavedHashesRef.current = hashes;
    setPageSaveIndicators({});
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
      applyRemotePages(documents.map(documentToOutlinePage));
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

  const flushDirtyPages = useCallback(async (snapshotOverride?: OutlinePage[]) => {
    if (!syncEnabled) {
      return;
    }

    if (flushPromiseRef.current) {
      pendingFlushRef.current = true;
      await flushPromiseRef.current;
    }

    const run = (async () => {
      let nextSnapshotOverride = snapshotOverride;

      do {
        pendingFlushRef.current = false;
        const snapshot = nextSnapshotOverride ?? pagesRef.current;
        nextSnapshotOverride = undefined;
        let savedAnyPage = false;

        for (const snapshotPage of snapshot) {
          const currentPage = findPageForPersistence(pagesRef.current, snapshotPage) ?? snapshotPage;
          const currentHash = pageHash(currentPage);
          if (lastSavedHashesRef.current.get(currentPage.id) === currentHash) {
            continue;
          }

          const pageKey = pagePersistenceKey(currentPage);
          setPageSaveIndicators((current) => ({
            ...current,
            [pageKey]: { status: 'saving', message: 'Saving...', hash: currentHash },
          }));

          try {
            const requestHash = currentHash;
            const requestPageId = currentPage.id;
            const savedDocument = await saveDocument(backendUrl, authToken, outlinePageToDocument(currentPage, workspaceId!));
            const savedPage = documentToOutlinePage(savedDocument);
            const latestPage = findPageForPersistence(pagesRef.current, currentPage) ?? findPageForPersistence(pagesRef.current, savedPage);
            const latestHash = latestPage ? pageHash(latestPage) : null;

            if (latestHash === requestHash || !currentPage.backendId) {
              dispatch({ type: 'mergeRemotePage', page: savedPage, previousPageId: requestPageId });
              lastSavedHashesRef.current.delete(requestPageId);
              lastSavedHashesRef.current.set(savedPage.id, pageHash(savedPage));
            } else {
              pendingFlushRef.current = true;
            }

            const savedKey = pagePersistenceKey(savedPage);
            setPageSaveIndicators((current) => ({
              ...current,
              [savedKey]: {
                status: 'saved',
                message: `Saved ${formatPanelTimestamp(savedPage.updatedAt || savedPage.createdAt || '')}`,
                hash: pageHash(savedPage),
              },
            }));
            if (savedKey !== pageKey) {
              setPageSaveIndicators((current) => {
                const next = { ...current };
                delete next[pageKey];
                return next;
              });
            }
            savedAnyPage = true;
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Save failed.';
            console.error('Document save failed', describeSaveFailure(currentPage, error));
            setPageSaveIndicators((current) => ({
              ...current,
              [pageKey]: { status: 'failed', message, hash: currentHash },
            }));
            setSyncMessage(`Save failed for ${getPageTitle(currentPage)}: ${message}`);
          }
        }

        if (savedAnyPage && onPagesSavedRef?.current) {
          try {
            await onPagesSavedRef.current();
          } catch {
            // Ignore follow-up refresh failures after document persistence.
          }
        }
      } while (pendingFlushRef.current);
    })();

    flushPromiseRef.current = run.finally(() => {
      flushPromiseRef.current = null;
    });
    await flushPromiseRef.current;
  }, [authToken, backendUrl, dispatch, onPagesSavedRef, syncEnabled, workspaceId]);

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

  const dispatchAfterFlush = useCallback((action: OutlineAction) => {
    const nextState = reduceOutlineState(stateRef.current, action);
    dispatch(action);

    if (!syncEnabled) {
      return;
    }

    void flushDirtyPages(getPagesForPersistence(nextState)).catch((error) => {
      setSyncMessage(error instanceof Error ? error.message : 'Save failed after navigation.');
    });
  }, [dispatch, flushDirtyPages, syncEnabled]);

  const runLogin = useCallback(async () => {
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
      if (onPagesSavedRef?.current) {
        await onPagesSavedRef.current();
      }
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Login failed.');
    } finally {
      setIsSyncing(false);
    }
  }, [backendUrl, email, onPagesSavedRef, password, syncFromBackend]);

  const runSync = useCallback(async () => {
    try {
      await flushDirtyPages();
      await syncFromBackend();
      if (onPagesSavedRef?.current) {
        await onPagesSavedRef.current();
      }
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Sync failed.');
    }
  }, [flushDirtyPages, onPagesSavedRef, syncFromBackend]);

  const handleLogout = useCallback(() => {
    setAuthToken('');
    setUserId(null);
    setWorkspaceId(null);
    setDirectories([]);
    setPageSaveIndicators({});
    setSyncMessage('Logged out.');
    bootSyncRef.current = false;
  }, []);

  return {
    backendUrl,
    setBackendUrl,
    email,
    setEmail,
    password,
    setPassword,
    centerColumn,
    setCenterColumn,
    syncMessage,
    setSyncMessage,
    authToken,
    userId,
    workspaceId,
    directories,
    setDirectories,
    isSyncing,
    bootstrapped,
    initialLoadResolved,
    syncEnabled,
    pagesForPersistence,
    pageSaveIndicators,
    activePageSaveMessage,
    activePageIsDirty,
    activePageHasNewerEdits,
    stateRef,
    pagesRef,
    flushDirtyPages,
    dispatchAfterFlush,
    runLogin,
    runSync,
    handleLogout,
  };
}
