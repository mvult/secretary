import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject } from 'react';
import {
  createWorkspace,
  getDocument,
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
import { describeInvalidBlockTree, describeSaveFailure, findPageForPersistence, normalizePageForSave, pageHash, pagePersistenceKey, validatePageForSave } from '../../app/pagePersistence';
import { SETTINGS_STORAGE_KEY, type PageSaveIndicator, type StoredSettings } from '../../app/types';

interface UseSessionSyncOptions {
  state: OutlineState;
  dispatch: Dispatch<OutlineAction>;
  onPagesSavedRef?: MutableRefObject<(() => Promise<void>) | null>;
}

type StaleBlockRecovery = {
  pageId: string;
  pageTitle: string;
  blockId: number;
  hash: string;
  message: string;
};

type PausedSaveState = {
  hash: string;
  blockId: number;
};

function logSaveDebug(label: string, details: Record<string, unknown>) {
  console.debug(`[save-debug] ${label}`, details);
}

function buildRequestToSavedNodeMap(requestPage: OutlinePage, savedPage: OutlinePage) {
  const byBackendId = new Map(savedPage.nodes.filter((node) => node.backendId).map((node) => [node.backendId!, node]));
  const result = new Map<string, OutlinePage['nodes'][number]>();

  requestPage.nodes.forEach((node, index) => {
    const savedNode = (node.backendId ? byBackendId.get(node.backendId) : null) ?? savedPage.nodes[index] ?? null;
    if (savedNode) {
      result.set(node.id, savedNode);
    }
  });

  return result;
}

function mergeSavedIdentitiesIntoPage(requestPage: OutlinePage, latestPage: OutlinePage, savedPage: OutlinePage): OutlinePage {
  const requestToSaved = buildRequestToSavedNodeMap(requestPage, savedPage);

  return {
    ...latestPage,
    backendId: savedPage.backendId,
    workspaceId: savedPage.workspaceId,
    directoryId: latestPage.directoryId,
    createdAt: savedPage.createdAt,
    updatedAt: savedPage.updatedAt,
    nodes: latestPage.nodes.map((node) => {
      const savedNode = requestToSaved.get(node.id);
      if (!savedNode) {
        return node;
      }

      return {
        ...node,
        backendId: savedNode.backendId,
        todoId: savedNode.todoId,
        createdAt: savedNode.createdAt,
        updatedAt: savedNode.updatedAt,
      };
    }),
  };
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
  saveFailureAlert: { pageTitle: string; message: string } | null;
  dismissSaveFailureAlert: () => void;
  staleBlockRecovery: StaleBlockRecovery | null;
  dismissStaleBlockRecovery: () => void;
  repairStalePageInPlace: () => Promise<void>;
  reloadStalePageFromServer: () => Promise<void>;
  pendingSyncConfirmation: { reason: 'startup' | 'login' | 'manual'; dirtyPages: { pageId: string; title: string; kind: OutlinePage['kind'] }[] } | null;
  confirmPendingSync: () => Promise<void>;
  cancelPendingSync: () => void;
  stateRef: MutableRefObject<OutlineState>;
  pagesRef: MutableRefObject<OutlinePage[]>;
  flushDirtyPages: (snapshotOverride?: OutlinePage[]) => Promise<void>;
  dispatchAfterFlush: (action: OutlineAction) => void;
  runLogin: () => Promise<void>;
  runSync: () => Promise<void>;
  handleLogout: () => void;
}

function clearInvalidServerBlockIds(page: OutlinePage, validBlockIds: Set<number>): OutlinePage {
  return {
    ...page,
    nodes: page.nodes.map((node) => (
      node.backendId && !validBlockIds.has(node.backendId)
        ? {
            ...node,
            backendId: undefined,
            todoId: null,
            createdAt: undefined,
            updatedAt: undefined,
          }
        : node
    )),
  };
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
  const [saveFailureAlert, setSaveFailureAlert] = useState<{ pageTitle: string; message: string } | null>(null);
  const [staleBlockRecovery, setStaleBlockRecovery] = useState<StaleBlockRecovery | null>(null);
  const [pendingSyncConfirmation, setPendingSyncConfirmation] = useState<{ reason: 'startup' | 'login' | 'manual'; dirtyPages: { pageId: string; title: string; kind: OutlinePage['kind'] }[] } | null>(null);
  const stateRef = useRef(state);
  const pagesForPersistence = useMemo(() => getPagesForPersistence(state), [state]);
  const pagesRef = useRef(pagesForPersistence);
  const lastSavedHashesRef = useRef<Map<string, string>>(new Map());
  const saveTimerRef = useRef<number | null>(null);
  const flushPromiseRef = useRef<Promise<void> | null>(null);
  const pendingFlushRef = useRef(false);
  const bootSyncRef = useRef(false);
  const pendingSyncRequestRef = useRef<{ tokenOverride?: string; workspaceOverride?: number | null } | null>(null);
  const pausedSaveStateRef = useRef<Map<string, PausedSaveState>>(new Map());
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
    dispatch({ type: 'hydrate', pages: nextPages, source: 'session:applyRemotePages' });
    const hashes = new Map<string, string>();
    for (const nextPage of nextPages) {
      hashes.set(nextPage.id, pageHash(nextPage));
    }
    lastSavedHashesRef.current = hashes;
    setPageSaveIndicators({});
  }, [dispatch]);

  const getDirtyPages = useCallback(() => {
    const snapshot = getPagesForPersistence(stateRef.current);
    return snapshot
      .filter((page) => lastSavedHashesRef.current.get(page.id) !== pageHash(page))
      .map((page) => ({
        pageId: page.id,
        title: getPageTitle(page),
        kind: page.kind,
      }));
  }, [stateRef]);

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

  const requestSyncConfirmation = useCallback((reason: 'startup' | 'login' | 'manual', tokenOverride?: string, workspaceOverride?: number | null) => {
    pendingSyncRequestRef.current = { tokenOverride, workspaceOverride };
    setPendingSyncConfirmation({
      reason,
      dirtyPages: getDirtyPages(),
    });
  }, [getDirtyPages]);

  const confirmPendingSync = useCallback(async () => {
    const request = pendingSyncRequestRef.current;
    pendingSyncRequestRef.current = null;
    setPendingSyncConfirmation(null);
    setInitialLoadResolved(false);
    await syncFromBackend(request?.tokenOverride, request?.workspaceOverride ?? null);
    if (onPagesSavedRef?.current) {
      await onPagesSavedRef.current();
    }
  }, [onPagesSavedRef, syncFromBackend]);

  const cancelPendingSync = useCallback(() => {
    pendingSyncRequestRef.current = null;
    setPendingSyncConfirmation(null);
    setInitialLoadResolved(true);
    setSyncMessage('Sync cancelled.');
  }, []);

  const dismissSaveFailureAlert = useCallback(() => {
    setSaveFailureAlert(null);
  }, []);

  const dismissStaleBlockRecovery = useCallback(() => {
    setStaleBlockRecovery(null);
  }, []);

  const clearPausedSaveState = useCallback((pageId: string) => {
    pausedSaveStateRef.current.delete(pageId);
  }, []);

  const repairPageWithServerBlockIds = useCallback(async (pageToRepair: OutlinePage) => {
    if (!authToken || !pageToRepair.backendId) {
      return null;
    }

    const serverDocument = await getDocument(backendUrl, authToken, pageToRepair.backendId);
    const existingServerBlockIds = new Set(serverDocument.blocks.map((block) => block.id));
    const repairedPage = clearInvalidServerBlockIds(pageToRepair, existingServerBlockIds);
    return pageHash(repairedPage) === pageHash(pageToRepair) ? null : repairedPage;
  }, [authToken, backendUrl]);

  const reloadStalePageFromServer = useCallback(async () => {
    if (!staleBlockRecovery || !authToken) {
      return;
    }

    const sourcePage = stateRef.current.pages.find((entry) => entry.id === staleBlockRecovery.pageId) ?? null;
    if (!sourcePage?.backendId) {
      setSyncMessage('This page does not have a server copy to reload.');
      return;
    }

    const serverDocument = await getDocument(backendUrl, authToken, sourcePage.backendId);
    const savedPage = documentToOutlinePage(serverDocument);
    dispatch({ type: 'mergeRemotePage', page: savedPage, previousPageId: sourcePage.id, source: 'session:reloadStalePageFromServer' });
    clearPausedSaveState(sourcePage.id);
    clearPausedSaveState(savedPage.id);
    lastSavedHashesRef.current.delete(sourcePage.id);
    lastSavedHashesRef.current.set(savedPage.id, pageHash(savedPage));
    setPageSaveIndicators((current) => {
      const next = { ...current };
      delete next[pagePersistenceKey(sourcePage)];
      next[pagePersistenceKey(savedPage)] = {
        status: 'saved',
        message: `Reloaded ${formatPanelTimestamp(savedPage.updatedAt || savedPage.createdAt || '')}`,
        hash: pageHash(savedPage),
      };
      return next;
    });
    setStaleBlockRecovery(null);
    setSaveFailureAlert(null);
    setSyncMessage(`Reloaded ${getPageTitle(savedPage)} from the server.`);
  }, [authToken, backendUrl, clearPausedSaveState, dispatch, staleBlockRecovery, stateRef]);

  useEffect(() => {
    if (!bootstrapped || bootSyncRef.current || !authToken || !backendUrl.trim()) {
      return;
    }
    bootSyncRef.current = true;
    requestSyncConfirmation('startup');
  }, [authToken, backendUrl, bootstrapped, requestSyncConfirmation]);

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
          const pausedSave = pausedSaveStateRef.current.get(currentPage.id) ?? null;
          if (pausedSave && pausedSave.hash === currentHash) {
            logSaveDebug('skip blocked page', {
              pageId: currentPage.id,
              backendDocumentId: currentPage.backendId ?? null,
              title: getPageTitle(currentPage),
              hash: currentHash,
              missingBlockId: pausedSave.blockId,
            });
            continue;
          }
          if (pausedSave && pausedSave.hash !== currentHash) {
            clearPausedSaveState(currentPage.id);
            if (staleBlockRecovery?.pageId === currentPage.id) {
              setStaleBlockRecovery(null);
            }
            logSaveDebug('resume page after edit', {
              pageId: currentPage.id,
              backendDocumentId: currentPage.backendId ?? null,
              title: getPageTitle(currentPage),
              previousPausedHash: pausedSave.hash,
              nextHash: currentHash,
            });
          }
          if (lastSavedHashesRef.current.get(currentPage.id) === currentHash) {
            continue;
          }

          const pageKey = pagePersistenceKey(currentPage);
          setPageSaveIndicators((current) => ({
            ...current,
            [pageKey]: { status: 'saving', message: 'Saving...', hash: currentHash },
          }));

          try {
            const pageToSave = normalizePageForSave(currentPage);
            if (pageHash(pageToSave) !== currentHash) {
              logSaveDebug('normalized page before save', {
                pageId: currentPage.id,
                backendDocumentId: currentPage.backendId ?? null,
                title: getPageTitle(currentPage),
                originalNodeOrder: currentPage.nodes.map((node) => ({
                  id: node.id,
                  backendId: node.backendId ?? null,
                  parentId: node.parentId,
                  text: node.text.trim() || '(blank block)',
                })),
                normalizedNodeOrder: pageToSave.nodes.map((node) => ({
                  id: node.id,
                  backendId: node.backendId ?? null,
                  parentId: node.parentId,
                  text: node.text.trim() || '(blank block)',
                })),
              });
            }

            const validationMessage = validatePageForSave(pageToSave);
            if (validationMessage) {
              logSaveDebug('invalid block tree after normalization', {
                pageId: currentPage.id,
                backendDocumentId: currentPage.backendId ?? null,
                title: getPageTitle(currentPage),
                issue: describeInvalidBlockTree(pageToSave),
              });
              throw new Error(validationMessage);
            }

            const requestHash = pageHash(pageToSave);
            const requestPageId = currentPage.id;
            const outgoingBlockIds = pageToSave.nodes
              .filter((node) => node.backendId)
              .map((node) => node.backendId);
            logSaveDebug('save request', {
              pageId: requestPageId,
              backendDocumentId: currentPage.backendId ?? null,
              title: getPageTitle(currentPage),
              nodeCount: pageToSave.nodes.length,
              outgoingBlockIds,
            });
            const savedDocument = await saveDocument(backendUrl, authToken, outlinePageToDocument(pageToSave, workspaceId!));
            const savedPage = documentToOutlinePage(savedDocument);
            const latestPage = findPageForPersistence(pagesRef.current, currentPage) ?? findPageForPersistence(pagesRef.current, savedPage);
            const latestHash = latestPage ? pageHash(latestPage) : null;

            if (latestHash === requestHash || !currentPage.backendId) {
              logSaveDebug('save response merge', {
                pageId: requestPageId,
                backendDocumentId: savedPage.backendId ?? null,
                title: getPageTitle(savedPage),
                latestHashMatchesRequest: latestHash === requestHash,
                forcedBecauseNewDocument: !currentPage.backendId,
                returnedBlockIds: savedPage.nodes.filter((node) => node.backendId).map((node) => node.backendId),
              });
              dispatch({ type: 'mergeRemotePage', page: savedPage, previousPageId: requestPageId, source: 'session:saveResponseMerge' });
              clearPausedSaveState(requestPageId);
              clearPausedSaveState(savedPage.id);
              lastSavedHashesRef.current.delete(requestPageId);
              lastSavedHashesRef.current.set(savedPage.id, pageHash(savedPage));
            } else {
              const identityMergedPage = latestPage
                ? mergeSavedIdentitiesIntoPage(pageToSave, latestPage, savedPage)
                : savedPage;
              logSaveDebug('save response skipped merge', {
                pageId: requestPageId,
                backendDocumentId: currentPage.backendId ?? null,
                title: getPageTitle(currentPage),
                latestHash,
                requestHash,
                latestPageId: latestPage?.id ?? null,
                latestOutgoingBlockIds: latestPage?.nodes.filter((node) => node.backendId).map((node) => node.backendId) ?? [],
                returnedBlockIds: savedPage.nodes.filter((node) => node.backendId).map((node) => node.backendId),
                mergedBlockIds: identityMergedPage.nodes.filter((node) => node.backendId).map((node) => node.backendId),
              });
              dispatch({ type: 'mergeRemotePage', page: identityMergedPage, previousPageId: latestPage?.id ?? requestPageId, source: 'session:saveResponseIdentityMerge' });
              clearPausedSaveState(requestPageId);
              clearPausedSaveState(identityMergedPage.id);
              lastSavedHashesRef.current.delete(requestPageId);
              lastSavedHashesRef.current.set(identityMergedPage.id, pageHash(identityMergedPage));
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
            const staleMatch = message.match(/block\s+(\d+)\s+does not belong to document/i);
            if (staleMatch && currentPage.backendId) {
              try {
                const repairedPage = await repairPageWithServerBlockIds(currentPage);
                if (repairedPage) {
                  logSaveDebug('auto-repaired stale block ids', {
                    pageId: currentPage.id,
                    backendDocumentId: currentPage.backendId ?? null,
                    title: getPageTitle(currentPage),
                    removedBlockIds: currentPage.nodes
                      .filter((node, index) => node.backendId && !repairedPage.nodes[index]?.backendId)
                      .map((node) => node.backendId),
                  });
                  dispatch({ type: 'mergeRemotePage', page: repairedPage, previousPageId: currentPage.id, source: 'session:autoRepairStaleBlockIds' });
                  clearPausedSaveState(currentPage.id);
                  clearPausedSaveState(repairedPage.id);
                  setStaleBlockRecovery(null);
                  setSaveFailureAlert(null);
                  setSyncMessage(`Recovered stale block ids in ${getPageTitle(currentPage)}. Retrying save.`);
                  pendingFlushRef.current = true;
                  continue;
                }
              } catch {
                // Fall through to the normal save failure handling if the repair lookup fails.
              }
            }
            console.error('Document save failed', describeSaveFailure(currentPage, error));
            logSaveDebug('save failure', {
              pageId: currentPage.id,
              backendDocumentId: currentPage.backendId ?? null,
              title: getPageTitle(currentPage),
              message,
              missingBlockId: staleMatch ? Number(staleMatch[1]) : null,
              outgoingBlockIds: currentPage.nodes.filter((node) => node.backendId).map((node) => node.backendId),
            });
            setPageSaveIndicators((current) => ({
              ...current,
              [pageKey]: { status: 'failed', message, hash: currentHash },
            }));
            if (staleMatch) {
              pausedSaveStateRef.current.set(currentPage.id, {
                hash: currentHash,
                blockId: Number(staleMatch[1]),
              });
              setStaleBlockRecovery({
                pageId: currentPage.id,
                pageTitle: getPageTitle(currentPage),
                blockId: Number(staleMatch[1]),
                hash: currentHash,
                message,
              });
            }
            setSaveFailureAlert({ pageTitle: getPageTitle(currentPage), message });
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

  const repairStalePageInPlace = useCallback(async () => {
    if (!staleBlockRecovery || !authToken || !workspaceId) {
      return;
    }

    const sourcePage = stateRef.current.pages.find((entry) => entry.id === staleBlockRecovery.pageId) ?? null;
    if (!sourcePage) {
      setSyncMessage('The failed local page is no longer available.');
      setStaleBlockRecovery(null);
      return;
    }

    if (!sourcePage.backendId) {
      setSyncMessage('This page does not have a server copy to repair against.');
      return;
    }

    const repairedPage = (await repairPageWithServerBlockIds(sourcePage)) ?? sourcePage;

    dispatch({ type: 'mergeRemotePage', page: repairedPage, previousPageId: sourcePage.id, source: 'session:repairStalePageInPlace' });
    clearPausedSaveState(sourcePage.id);
    clearPausedSaveState(repairedPage.id);
    setStaleBlockRecovery(null);
    setSaveFailureAlert(null);
    setSyncMessage(`Repaired missing server block ids in ${getPageTitle(sourcePage)}. Autosave can retry now.`);
    await flushDirtyPages([repairedPage]);
  }, [authToken, clearPausedSaveState, dispatch, flushDirtyPages, repairPageWithServerBlockIds, staleBlockRecovery, stateRef, workspaceId]);

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
      setInitialLoadResolved(true);
      requestSyncConfirmation('login', response.token, null);
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Login failed.');
    } finally {
      setIsSyncing(false);
    }
  }, [backendUrl, email, onPagesSavedRef, password, syncFromBackend]);

  const runSync = useCallback(async () => {
    try {
      await flushDirtyPages();
      requestSyncConfirmation('manual');
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Sync failed.');
    }
  }, [flushDirtyPages, requestSyncConfirmation]);

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
    saveFailureAlert,
    dismissSaveFailureAlert,
    staleBlockRecovery,
    dismissStaleBlockRecovery,
    repairStalePageInPlace,
    reloadStalePageFromServer,
    pendingSyncConfirmation,
    confirmPendingSync,
    cancelPendingSync,
    stateRef,
    pagesRef,
    flushDirtyPages,
    dispatchAfterFlush,
    runLogin,
    runSync,
    handleLogout,
  };
}
