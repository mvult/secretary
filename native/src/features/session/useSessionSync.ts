import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject } from 'react';
import { BackendError, createWorkspace, getDocument, listDocuments, listWorkspaces, login, onAuthFailure, saveDocument, type BackendDirectory } from '../../lib/backend';
import { backendIdentity, draftScope, DraftStorage, openDraftDatabase, type DraftRecord } from '../../lib/draftStorage';
import { documentToOutlinePage, outlinePageToDocument } from '../outline/remote';
import { getPageTitle, getPagesForPersistence } from '../outline/tree';
import { reduceOutlineState, type OutlineAction } from '../outline/state';
import type { OutlinePage, OutlineState } from '../outline/types';
import { findPageForPersistence, normalizePageForSave, pageHash, pagePersistenceKey, validatePageForSave } from '../../app/pagePersistence';
import { SETTINGS_STORAGE_KEY, type PageSaveIndicator, type StoredSettings } from '../../app/types';
import { reconcileSavedPage } from './saveReconciliation';
import { useSaveStatus } from './useSaveStatus';
import { draftConflicts, mergeWorkspace, recoveryCopy, trackDrafts } from './draftReconciliation';

type SessionStatus = 'restoring' | 'signed-out' | 'validating' | 'loading' | 'ready' | 'reauth-required' | 'unavailable';
type LoadStage = 'restoring' | 'authenticating' | 'documents' | 'merging' | 'persisting';
type LoadStatus = 'idle' | LoadStage | 'ready' | 'failed';
const loadLabels: Record<LoadStage, string> = {
  restoring: 'Restoring local drafts', authenticating: 'Validating session',
  documents: 'Loading documents', merging: 'Reconciling drafts', persisting: 'Saving local cache',
};
interface Options {
  state: OutlineState;
  dispatch: Dispatch<OutlineAction>;
  onPagesSavedRef?: MutableRefObject<(() => Promise<void>) | null>;
}

function readSettings(): StoredSettings {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  }
  catch { return {}; }
}

function message(error: unknown) { return error instanceof Error ? error.message : 'Request failed.'; }

// Only used AFTER a successful authenticated RPC, never as session validation itself.
function tokenUser(token: string) {
  const payload = token.split('.')[1];
  return Number(JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).sub);
}

export function useSessionSync({ state, dispatch: rawDispatch, onPagesSavedRef }: Options) {
  const [settings] = useState(readSettings);
  const [backendUrl, updateBackendUrl] = useState(settings.backendUrl ?? 'http://localhost:8091');
  const [email, setEmail] = useState(settings.email ?? '');
  const [password, setPassword] = useState('');
  const [authToken, setAuthToken] = useState(settings.token ?? '');
  const [userId, setUserId] = useState<number | null>(settings.userId ?? null);
  const [workspaceId, setWorkspaceId] = useState<number | null>(settings.workspaceId ?? null);
  const [centerColumn, setCenterColumn] = useState(settings.centerColumn ?? false);
  const [editorFontScale, setEditorFontScale] = useState(settings.editorFontScale ?? 1);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('restoring');
  const [loadStatus, setLoadStatus] = useState<LoadStatus>('idle');
  const [loadTimings, setLoadTimings] = useState<Partial<Record<LoadStage | 'total', number>>>({});
  const [localReady, setLocalReady] = useState(false);
  const [localError, setLocalError] = useState('');
  const [persistedHashes, setPersistedHashes] = useState<Record<string, string>>({});
  const [syncMessage, setSyncMessage] = useState('');
  const [directories, setDirectories] = useState<BackendDirectory[]>([]);
  const [pageSaveIndicators, setPageSaveIndicators] = useState<Record<string, PageSaveIndicator>>({});
  const [saveFailureAlert, setSaveFailureAlert] = useState<{ pageTitle: string; message: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const stateRef = useRef(state);
  const pagesForPersistence = useMemo(() => getPagesForPersistence(state), [state.pages, state.draftText, state.editingId]);
  const pagesRef = useRef(pagesForPersistence);
  const recordsRef = useRef<DraftRecord[]>([]);
  const directoriesRef = useRef(directories);
  const storageRef = useRef<DraftStorage | null>(null);
  const epochRef = useRef(0);
  const savingRef = useRef<Promise<void> | null>(null);
  const writableRef = useRef(false);
  const syncRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const scopeReadyRef = useRef(false);
  const refreshWaiters = useRef<(() => void)[]>([]);
  const persistRequestRef = useRef(0);

  const apply = useCallback((action: OutlineAction) => {
    stateRef.current = reduceOutlineState(stateRef.current, action);
    pagesRef.current = getPagesForPersistence(stateRef.current);
    recordsRef.current = trackDrafts(recordsRef.current, pagesRef.current,
      action.type === 'createTodayJournal' || action.type === 'selectJournal');
    // Reducers create UUIDs for new pages/blocks. Apply the computed state rather
    // than executing the action a second time with different identities in React.
    rawDispatch({ type: 'applySessionState', state: stateRef.current });
  }, [rawDispatch]);

  useEffect(() => {
    stateRef.current = state;
    pagesRef.current = pagesForPersistence;
    directoriesRef.current = directories;
  }, [state, pagesForPersistence, directories]);

  const currentRecords = useCallback((pages = pagesRef.current) => trackDrafts(recordsRef.current, pages), []);

  const persist = useCallback(async (records = currentRecords()) => {
    const storage = storageRef.current;
    if (!storage) throw new Error('Local draft storage is not ready.');
    const epoch = epochRef.current;
    const request = ++persistRequestRef.current;
    try {
      await storage.save({ records, directories: directoriesRef.current });
      if (epoch === epochRef.current && request === persistRequestRef.current) {
        setPersistedHashes(Object.fromEntries(records.map((record) => [record.page.id, pageHash(record.page)])));
        setLocalError('');
      }
    } catch (error) {
      if (epoch === epochRef.current && request === persistRequestRef.current) {
        setLocalError(message(error));
        setSessionStatus('unavailable');
        setSyncMessage('Local draft storage failed. Retry after storage is available.');
        syncRef.current = false;
      }
      throw error;
    }
  }, [currentRecords]);

  const failSession = useCallback((error: unknown) => {
    syncRef.current = false;
    setSessionStatus(error instanceof BackendError && error.status === 401 ? 'reauth-required' : 'unavailable');
    setLoadStatus('failed');
    setSyncMessage(message(error));
  }, []);

  useEffect(() => onAuthFailure((failure) => {
    if (failure.baseUrl === backendUrl && failure.token === authToken && authToken) {
      failSession(new BackendError('Session expired. Log in to resume saving; local drafts are retained.', 401));
    }
  }), [authToken, backendUrl, failSession]);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ backendUrl, email, token: authToken || undefined,
        userId: userId ?? undefined, workspaceId: workspaceId ?? undefined, centerColumn, editorFontScale }));
    } catch { setSyncMessage('Settings could not be retained on this device.'); }
  }, [backendUrl, email, authToken, userId, workspaceId, centerColumn, editorFontScale]);

  useEffect(() => {
    const epoch = ++epochRef.current;
    let cancelled = false;
    const active = () => !cancelled && epoch === epochRef.current;
    scopeReadyRef.current = false;
    writableRef.current = false;
    syncRef.current = false;
    setLocalReady(false);
    setLoadStatus('restoring');
    setSessionStatus('restoring');
    setSyncMessage('');
    setLoadTimings({});
    const started = performance.now();
    let stageStarted = started;
    let stage: LoadStage = 'restoring';
    const timings: Partial<Record<LoadStage | 'total', number>> = {};
    const finishStage = () => {
      const now = performance.now();
      timings[stage] = now - stageStarted;
      timings.total = now - started;
      if (active()) setLoadTimings({ ...timings });
    };
    const beginStage = (next: LoadStage) => {
      finishStage();
      stage = next;
      stageStarted = performance.now();
      setLoadStatus(next);
    };

    const restore = async () => {
      try {
        if (userId && workspaceId) {
          // Manual refresh reuses the live repository so edits made during refresh survive.
          if (!storageRef.current) {
            const db = await openDraftDatabase();
            const storage = new DraftStorage(db, draftScope(backendUrl, userId, workspaceId));
            const cached = await storage.load();
            if (!active()) { db.close(); return; }
            storageRef.current = storage;
            recordsRef.current = cached.records;
            directoriesRef.current = cached.directories;
            setDirectories(cached.directories);
            apply({ type: 'hydrate', pages: cached.records.map((entry) => entry.page), source: 'session:restoreDrafts' });
            setPersistedHashes(Object.fromEntries(cached.records.map((entry) => [entry.page.id, pageHash(entry.page)])));
          }
          scopeReadyRef.current = true;
          writableRef.current = true;
          setLocalReady(true);
        }
        if (!authToken) {
          setSessionStatus(userId ? 'reauth-required' : 'signed-out');
          setLoadStatus('idle');
          return;
        }
        setSessionStatus('validating');
        beginStage('authenticating');
        let workspaces = await listWorkspaces(backendUrl, authToken);
        if (!active()) return;
        if (!userId || tokenUser(authToken) !== userId) throw new BackendError('Log in to validate this account.', 401);
        if (!workspaceId) {
          if (!workspaces.length) workspaces = [await createWorkspace(backendUrl, authToken, 'Personal')];
          if (active()) setWorkspaceId(workspaces[0].id);
          return;
        }
        if (!workspaces.some((workspace) => workspace.id === workspaceId)) throw new BackendError('Workspace access denied. Local drafts are retained.', 403);
        setSessionStatus('loading');
        beginStage('documents');
        const remote = await listDocuments(backendUrl, authToken, workspaceId);
        if (!active()) return;
        beginStage('merging');
        const records = mergeWorkspace(currentRecords(), remote.documents.map(documentToOutlinePage));
        recordsRef.current = records;
        directoriesRef.current = remote.directories;
        setDirectories(remote.directories);
        apply({ type: 'refreshPages', pages: records.map((entry) => entry.page) });
        beginStage('persisting');
        await persist(records);
        if (!active()) return;
        syncRef.current = true;
        setSessionStatus('ready');
        setLoadStatus('ready');
        setSyncMessage(`Loaded ${remote.documents.length} documents${records.some((entry) => entry.conflict) ? '; local conflicts retained' : ''}.`);
        if (!pagesRef.current.length) apply({ type: 'createTodayJournal' });
      } catch (error) {
        if (!active()) return;
        if (!storageRef.current && userId && workspaceId) setLocalError(message(error));
        failSession(error);
      }
    };
    void restore().finally(() => {
      finishStage();
      if (active()) refreshWaiters.current.splice(0).forEach((resolve) => resolve());
    });
    return () => {
      cancelled = true;
      syncRef.current = false;
      if (epochRef.current === epoch) ++epochRef.current;
    };
  }, [backendUrl, userId, workspaceId, authToken, refresh, apply, currentRecords, persist, failSession]);

  // No network debounce here: retain every editor snapshot, including active draft text.
  useEffect(() => {
    if (!localReady || !scopeReadyRef.current) return;
    void persist().catch(() => undefined);
  }, [pagesForPersistence, directories, localReady, persist]);

  const flushDirtyPages = useCallback(async (snapshotOverride?: OutlinePage[]) => {
    if (!userId || !workspaceId || JSON.stringify(storageRef.current?.scope) !== JSON.stringify(draftScope(backendUrl, userId, workspaceId))) return;
    if (savingRef.current) return savingRef.current;
    if (!syncRef.current || !scopeReadyRef.current) return;
    if (!currentRecords().some((entry) => !entry.pending && !entry.conflict && entry.savedHash !== pageHash(entry.page))) return;
    const epoch = epochRef.current;
    const run = async () => {
      setSaving(true);
      for (const candidate of snapshotOverride ?? pagesRef.current) {
        if (epoch !== epochRef.current || !syncRef.current) break;
        const page = findPageForPersistence(pagesRef.current, candidate);
        if (!page) continue;
        const record = currentRecords().find((entry) => entry.page.id === page.id)!;
        if (record.pending || record.conflict || record.savedHash === pageHash(page)) continue;
        const requestPage = normalizePageForSave(page);
        const validation = validatePageForSave(requestPage);
        if (validation) { setSaveFailureAlert({ pageTitle: getPageTitle(page), message: validation }); continue; }
        const key = pagePersistenceKey(page);
        let sent = false;
        try {
          // A legacy request has no receipt: after interruption it must be compared, not replayed.
          recordsRef.current = currentRecords().map((entry) => entry.page.id === page.id ? { ...entry, pending: true } : entry);
          await persist(recordsRef.current);
          if (epoch !== epochRef.current || !syncRef.current) break;
          setPageSaveIndicators((value) => ({ ...value, [key]: { status: 'saving', message: 'Saving…', hash: pageHash(page) } }));
          sent = true;
          const saved = documentToOutlinePage(await saveDocument(backendUrl, authToken, outlinePageToDocument(requestPage, workspaceId!)));
          if (epoch !== epochRef.current) break;
          const latest = findPageForPersistence(pagesRef.current, page);
          if (!latest) break;
          const reconciled = reconcileSavedPage(requestPage, normalizePageForSave(latest), saved);
          const other = currentRecords().filter((entry) => entry.page.id !== page.id);
          recordsRef.current = [...other, { page: reconciled.page, baseline: saved, savedHash: reconciled.savedHash }];
          apply({ type: 'mergeRemotePage', page: reconciled.page, previousPageId: page.id, source: 'session:saveResponse' });
          await persist();
          if (epoch !== epochRef.current) break;
          setPageSaveIndicators((value) => ({ ...value, [pagePersistenceKey(reconciled.page)]: { status: 'saved', message: 'Saved', hash: reconciled.savedHash } }));
        } catch (error) {
          if (epoch !== epochRef.current) break;
          const uncertain = sent && (!(error instanceof BackendError) || error.status >= 500);
          const authFailure = error instanceof BackendError && [401, 403].includes(error.status);
          recordsRef.current = currentRecords().map((entry) => entry.page.id === page.id ? {
            ...entry, pending: uncertain,
            conflict: authFailure ? undefined : uncertain ? 'The save outcome is unknown. Compare the server copy before retrying.' : message(error),
          } : entry);
          await persist().catch(() => undefined);
          setPageSaveIndicators((value) => ({ ...value, [key]: { status: 'failed', message: message(error), hash: pageHash(page) } }));
          setSaveFailureAlert({ pageTitle: getPageTitle(page), message: message(error) });
          if (error instanceof BackendError && [401, 403].includes(error.status)) failSession(error);
        }
      }
      if (epoch === epochRef.current) await onPagesSavedRef?.current?.().catch(() => undefined);
    };
    const promise = run().finally(() => {
      if (savingRef.current === promise) savingRef.current = null;
      if (epoch === epochRef.current) setSaving(false);
    });
    savingRef.current = promise;
    return promise;
  }, [apply, authToken, backendUrl, currentRecords, failSession, onPagesSavedRef, persist, userId, workspaceId]);

  const syncEnabled = sessionStatus === 'ready' && loadStatus === 'ready' && localReady && !localError;
  useEffect(() => {
    if (!syncEnabled) return;
    const timer = window.setTimeout(() => { void flushDirtyPages(); }, 10000);
    return () => window.clearTimeout(timer);
  }, [pagesForPersistence, syncEnabled, saving, flushDirtyPages]);

  const runSync = useCallback(async () => {
    if (savingRef.current) await savingRef.current;
    if (storageRef.current) {
      try { await persist(); } catch { return; }
    }
    await new Promise<void>((resolve) => {
      refreshWaiters.current.push(resolve);
      setRefresh((value) => value + 1);
    });
  }, [persist]);

  useEffect(() => {
    const reconnect = () => { void runSync(); };
    window.addEventListener('online', reconnect);
    return () => window.removeEventListener('online', reconnect);
  }, [runSync]);

  const detach = useCallback(async () => {
    syncRef.current = false;
    writableRef.current = false;
    ++epochRef.current;
    if (storageRef.current) {
      try { await persist(); }
      catch (error) { writableRef.current = true; setSessionStatus('unavailable'); setLoadStatus('failed'); throw error; }
    }
    scopeReadyRef.current = false;
    savingRef.current = null;
    refreshWaiters.current.splice(0).forEach((resolve) => resolve());
    storageRef.current = null;
    recordsRef.current = [];
    setLocalReady(false);
    setLocalError('');
    setPersistedHashes({});
    setPageSaveIndicators({});
    setLoadTimings({});
    setLoadStatus('idle');
    setSaving(false);
    setDirectories([]);
    apply({ type: 'hydrate', pages: [], source: 'session:detach' });
  }, [apply, persist]);

  const runLogin = useCallback(async () => {
    const epoch = epochRef.current;
    setSessionStatus('validating');
    setLoadStatus('authenticating');
    setSyncMessage('');
    syncRef.current = false;
    try {
      const response = await login(backendUrl, email, password);
      if (epoch !== epochRef.current) return;
      await detach();
      setUserId(response.user.id);
      setWorkspaceId(response.user.id === userId ? workspaceId : null);
      setAuthToken(response.token);
      setPassword('');
      setRefresh((value) => value + 1);
    } catch (error) { if (epoch === epochRef.current) failSession(error); }
  }, [backendUrl, detach, email, failSession, password, userId, workspaceId]);

  const handleLogout = useCallback(() => {
    void detach().then(() => {
      setAuthToken(''); setUserId(null); setWorkspaceId(null); setPassword('');
      setSessionStatus('signed-out'); setSyncMessage('Logged out. Local drafts retained for this account.');
    }).catch((error) => setSyncMessage(`Logout paused: ${message(error)}`));
  }, [detach]);

  // Backend settings are applied on blur in SettingsView, not for every keystroke.
  const setBackendUrl = useCallback((value: string) => {
    if (value === backendUrl) return;
    void (async () => {
      try {
        const normalized = backendIdentity(value);
        let previous: string | null = null;
        try { previous = backendIdentity(backendUrl); } catch { /* Allow repairing invalid stored settings. */ }
        if (normalized === previous) { updateBackendUrl(normalized); return; }
        await detach();
        setAuthToken(''); setUserId(null); setWorkspaceId(null);
        updateBackendUrl(normalized);
      } catch (error) { setSyncMessage(message(error)); }
    })();
  }, [backendUrl, detach]);

  const dispatch = useCallback((action: OutlineAction) => {
    if (!writableRef.current && !['openSettings', 'openAI', 'openPomodoro'].includes(action.type)) return;
    if (storageRef.current && (!userId || !workspaceId || JSON.stringify(storageRef.current.scope) !== JSON.stringify(draftScope(backendUrl, userId, workspaceId)))) return;
    apply(action);
  }, [apply, backendUrl, userId, workspaceId]);

  const updateDirectories: Dispatch<React.SetStateAction<BackendDirectory[]>> = useCallback((value) => {
    if (!userId || !workspaceId || JSON.stringify(storageRef.current?.scope) !== JSON.stringify(draftScope(backendUrl, userId, workspaceId))) return;
    setDirectories(value);
  }, [backendUrl, userId, workspaceId]);

  const dispatchAfterFlush = useCallback((action: OutlineAction) => {
    dispatch(action);
    if (scopeReadyRef.current) void persist().catch(() => undefined);
    void flushDirtyPages();
  }, [dispatch, flushDirtyPages, persist]);

  const resolveConflict = useCallback(async (pageId: string, resolution: 'reload' | 'copy') => {
    if (!authToken || savingRef.current) return;
    const epoch = epochRef.current;
    try {
      const record = currentRecords().find((entry) => entry.page.id === pageId);
      if (!record) return;
      const serverId = record.serverCopy?.backendId ?? record.page.backendId;
      const document = serverId
        ? await getDocument(backendUrl, authToken, serverId).catch((error) => {
          if (error instanceof BackendError && error.status === 404) return null;
          throw error;
        })
        : null;
      const remote = document ? documentToOutlinePage(document) : null;
      if (epoch !== epochRef.current) return;
      const latest = currentRecords().find((entry) => entry.page.id === pageId)!;
      let records = currentRecords().filter((entry) => entry.page.id !== pageId);
      if (resolution === 'copy') records.push({ page: recoveryCopy(latest.page) });
      if (remote) records.push({ page: remote, baseline: remote, savedHash: pageHash(remote) });
      if (resolution === 'reload' && !remote) throw new Error('No identified server copy. Save a recovery copy instead.');
      // Freeze editor actions while committing this explicit discard/copy decision.
      writableRef.current = false;
      try { await persist(records); }
      finally { if (epoch === epochRef.current) writableRef.current = true; }
      if (epoch !== epochRef.current) return;
      recordsRef.current = records;
      apply({ type: 'hydrate', pages: records.map((entry) => entry.page), source: 'session:resolveConflict' });
    } catch (error) { setSyncMessage(message(error)); throw error; }
  }, [apply, authToken, backendUrl, currentRecords, persist]);

  const page = pagesForPersistence.find((entry) => entry.id === state.activePageId);
  const conflicts = draftConflicts(currentRecords(), saving);
  const record = page ? currentRecords().find((entry) => entry.page.id === page.id) : undefined;
  const activePageIsDirty = Boolean(page && pageHash(page) !== record?.savedHash);
  const indicator = page ? pageSaveIndicators[pagePersistenceKey(page)] : undefined;
  const localMessage = localError ? `Local storage failed: ${localError}`
    : page && persistedHashes[page.id] !== pageHash(page) ? 'Retaining locally…' : 'Retained locally';
  const hasActiveConflict = conflicts.some((entry) => entry.page.id === page?.id);
  const sessionLabel = sessionStatus === 'restoring' || sessionStatus === 'validating' || sessionStatus === 'loading'
    ? loadLabels[loadStatus as LoadStage] ?? 'Validating session'
    : sessionStatus === 'reauth-required' || sessionStatus === 'signed-out' ? 'Login required'
      : sessionStatus === 'unavailable' ? 'Sync unavailable' : 'Ready';
  const loadTimingMessage = Object.entries(loadTimings).map(([key, ms]) =>
    `${key === 'total' ? 'Total' : loadLabels[key as LoadStage]}: ${Math.round(ms!)} ms`).join(' · ');
  const saveMessage = hasActiveConflict ? `${localMessage} · conflict`
    : activePageIsDirty ? `${localMessage} · ${indicator?.status === 'saving' ? 'saving…' : sessionStatus === 'ready' ? 'pending save' : sessionLabel.toLowerCase()}`
      : localError ? localMessage : 'Saved';
  const activePageSaveMessage = useSaveStatus(
    JSON.stringify([backendUrl, userId, workspaceId, page?.id]), saveMessage,
    Boolean(localError || hasActiveConflict || indicator?.status === 'failed' || sessionStatus !== 'ready'),
  );

  return {
    backendUrl, setBackendUrl, email, setEmail, password, setPassword, authToken, userId, workspaceId,
    centerColumn, setCenterColumn, editorFontScale, setEditorFontScale, syncMessage, setSyncMessage,
    directories, setDirectories: updateDirectories, stateRef, pagesRef, pagesForPersistence, pageSaveIndicators,
    sessionStatus, sessionLabel, loadStatus, loadTimings, loadTimingMessage, localReady, localError,
    conflicts,
    resolveConflict, dispatch,
    isSyncing: sessionStatus === 'restoring' || sessionStatus === 'validating' || sessionStatus === 'loading' || saving,
    bootstrapped: sessionStatus !== 'restoring', initialLoadResolved: loadStatus === 'ready', syncEnabled,
    activePageSaveMessage, activePageIsDirty, activePageHasNewerEdits: Boolean(page && indicator?.hash !== pageHash(page)),
    saveFailureAlert, dismissSaveFailureAlert: () => setSaveFailureAlert(null),
    flushDirtyPages, dispatchAfterFlush, runLogin, runSync, handleLogout,
  };
}
