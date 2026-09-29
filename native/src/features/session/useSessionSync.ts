import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject } from 'react';
import { BackendError, createWorkspace, deleteDocument, getDocument, listDocumentIndex, login, moveDocumentTodosToRepository, pullOnDeckTodosToToday, onAuthFailure, saveDocument, updateTodo, type BackendDirectory, type TodoPatch, type DocumentMetadata } from '../../lib/backend';
import { loadIndexedWorkspace, navigationPages } from './documentIndex';
import { getCurrentJournalDate, getDateKey } from '../outline/sampleData';
import { backendIdentity, draftScope, DraftStorage, openDraftDatabase, type DraftRecord, type TodoCommandEnvelope } from '../../lib/draftStorage';
import { documentToOutlinePage, outlinePageToDocument } from '../outline/remote';
import { getPageTitle, getPagesForPersistence, getJournalPages } from '../outline/tree';
import { getVisibleNodes } from '../outline/folding';
import { reduceOutlineState, type OutlineAction } from '../outline/state';
import type { OutlinePage, OutlineState } from '../outline/types';
import { findPageForPersistence, normalizePageForSave, pageHash, pagePersistenceKey, validatePageForSave } from '../../app/pagePersistence';
import { SETTINGS_STORAGE_KEY, type PageSaveIndicator, type StoredSettings } from '../../app/types';
import { reconcileSavedPage } from './saveReconciliation';
import { useSaveStatus } from './useSaveStatus';
import { adoptSnapshotIdentity, draftConflicts, isDraftDirty, mergeWorkspace, recoveryCopy, trackDrafts } from './draftReconciliation';
import { assertVersionedPage, DocumentSaveController, draftId, prepareDelete, sendRetainedDelete, sendRetainedSave } from './documentSaveController';
import { getCommandDate, prepareTodoCommand, prepareTodoUpdate, sendTodoCommand } from './todoCommandController';
import { DocumentQueries } from './documentQueries';
import { boundCleanBodies } from './bodyCache';

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
  loadWorkspace?: typeof loadIndexedWorkspace;
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

export function useSessionSync({ state, dispatch: rawDispatch, onPagesSavedRef, loadWorkspace = loadIndexedWorkspace }: Options) {
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
  const [documentIndex, setDocumentIndex] = useState<DocumentMetadata[]>([]);
  const indexRef = useRef<DocumentMetadata[]>([]);
  const [bodyQueries] = useState(() => new DocumentQueries());
  const fetchIndex = useCallback<typeof listDocumentIndex>((base, token, workspace, before, query) => {
    if (!userId) return Promise.reject(new Error('An account is required to read the document index.'));
    return bodyQueries.index(draftScope(base, userId, workspace), token, before, query);
  }, [bodyQueries, userId]);
  const bodyLoads = useRef(new Map<number, Promise<OutlinePage>>());
  const selectionTicket = useRef(0);
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
  const controllerRef = useRef<DocumentSaveController | null>(null);
  const commandRef = useRef<object | null>(null);
  const retainedCommandRef = useRef<TodoCommandEnvelope | undefined>(undefined);

  const apply = useCallback((action: OutlineAction) => {
    stateRef.current = reduceOutlineState(stateRef.current, action);
    pagesRef.current = getPagesForPersistence(stateRef.current);
    recordsRef.current = trackDrafts(recordsRef.current, pagesRef.current,
      action.type === 'createTodayJournal' || action.type === 'selectJournal');
    if (action.type === 'selectNote' || action.type === 'selectJournalPage' || action.type === 'selectJournal') {
      recordsRef.current = recordsRef.current.map(record => record.page.id === stateRef.current.activePageId
        ? { ...record, lastAccessedAt: Date.now() } : record);
    }
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

  const persist = useCallback(async (supplied?: DraftRecord[]) => {
    let records = supplied ?? currentRecords();
    const storage = storageRef.current;
    if (!storage) throw new Error('Local draft storage is not ready.');
    if (!supplied && !savingRef.current && !commandRef.current && !retainedCommandRef.current && !bodyLoads.current.size) {
      const bounded = boundCleanBodies(records, new Set([stateRef.current.activePageId]));
      if (bounded.evicted.size) {
        // Preserve metadata for bodies first encountered through creation or links.
        const index = new Map(indexRef.current.map(entry => [entry.id, entry]));
        for (const record of records) if (bounded.evicted.has(record.page.id)) {
          const { blocks: _, ...metadata } = outlinePageToDocument(record.baseline!, record.page.workspaceId!);
          if (!index.has(metadata.id)) index.set(metadata.id, { ...metadata, clientKey: record.baseline!.clientKey!, revision: record.baseline!.revision });
        }
        indexRef.current = [...index.values()];
        setDocumentIndex(indexRef.current);
        recordsRef.current = bounded.records;
        apply({ type: 'evictPages', ids: bounded.evicted });
        records = currentRecords();
      }
    }
    const epoch = epochRef.current;
    const request = ++persistRequestRef.current;
    try {
      await storage.save({ records, directories: directoriesRef.current, command: retainedCommandRef.current, index: indexRef.current }, true);
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
  }, [currentRecords, apply]);

  const failSession = useCallback((error: unknown) => {
    syncRef.current = false;
    setSessionStatus(error instanceof BackendError && error.status === 401 ? 'reauth-required' : 'unavailable');
    setLoadStatus('failed');
    setSyncMessage(message(error));
  }, []);

  const removeDraft = useCallback(async (id: string) => {
    const epoch = epochRef.current;
    const records = currentRecords();
    const record = records.find((entry) => draftId(entry) === id);
    if (!record) return;
    const remaining = records.filter((entry) => entry !== record);
    writableRef.current = false;
    try { await persist(remaining); }
    finally { if (epoch === epochRef.current) writableRef.current = true; }
    if (epoch !== epochRef.current) return;
    recordsRef.current = remaining;
    apply({ type: 'deleteNote', pageId: record.page.id });
  }, [apply, currentRecords, persist]);

  const createSaveController = useCallback((epoch: number) => {
    const scope = draftScope(backendUrl, userId!, workspaceId!);
    const active = () => epoch === epochRef.current && JSON.stringify(storageRef.current?.scope) === JSON.stringify(scope);
    const getServer = async (id: number) => {
      try { return documentToOutlinePage(await getDocument(backendUrl, authToken, id)); }
      catch (error) { if (error instanceof BackendError && error.status === 404) return null; throw error; }
    };
    return new DocumentSaveController({ scope, active, canSend: () => syncRef.current,
      read: (id) => currentRecords().find((record) => draftId(record) === id),
      change: (id, update) => {
        if (!active()) return;
        const records = currentRecords();
        const previous = records.find((record) => draftId(record) === id);
        if (!previous) return;
        const next = update(previous);
        recordsRef.current = records.map((record) => record === previous ? next : record);
        if (next.page !== previous.page) apply({ type: 'mergeRemotePage', page: next.page, previousPageId: previous.page.id, source: 'session:versionedSave', acknowledged: next.baseline });
      },
      persist: () => persist(),
      send: (body) => sendRetainedSave(backendUrl, authToken, body),
      sendDelete: (body) => sendRetainedDelete(backendUrl, authToken, body),
      remove: removeDraft,
      getServer,
      effects: async (ids, primary) => {
        for (const id of new Set(ids.filter((id) => id !== primary))) {
          if (!active()) return;
          recordsRef.current = currentRecords().map((record) => record.page.backendId === id ? { ...record, needsRefresh: true } : record);
          await persist();
          const remote = await getServer(id);
          if (!active()) return;
          if (remote) assertVersionedPage(remote);
          const records = currentRecords();
          const related = records.find((record) => record.page.backendId === id);
          if (!related) continue;
          recordsRef.current = [...records.filter((record) => record !== related), ...mergeWorkspace([related], remote ? [remote] : [])];
          apply({ type: 'refreshPages', pages: recordsRef.current.map((record) => record.page) });
          await persist();
        }
      },
      status: (id, status, text) => {
        if (!active()) return;
        const record = currentRecords().find((record) => draftId(record) === id);
        if (!record) return;
        setPageSaveIndicators((value) => ({ ...value, [pagePersistenceKey(record.page)]: {
          status, message: text, hash: status === 'saved' ? record.savedHash ?? '' : pageHash(record.page),
        } }));
        if (status === 'failed') setSaveFailureAlert({ pageTitle: getPageTitle(record.page), message: text });
      },
      failure: (error) => { if (active() && error instanceof BackendError && [401, 403].includes(error.status)) failSession(error); },
    });
  }, [apply, authToken, backendUrl, currentRecords, failSession, persist, removeDraft, userId, workspaceId]);

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
    bodyQueries.clear();
    let cancelled = false;
    const active = () => !cancelled && epoch === epochRef.current;
    scopeReadyRef.current = false;
    writableRef.current = false;
    syncRef.current = false;
    controllerRef.current = null;
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
            indexRef.current = cached.index ?? [];
            setDocumentIndex(indexRef.current);
            retainedCommandRef.current = cached.command;
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
        let workspaces = await bodyQueries.workspaces(backendUrl, authToken, userId);
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
        const fetchBody: typeof getDocument = (_base, token, id) => bodyQueries.get(draftScope(backendUrl, userId, workspaceId!), token, id);
        let remote = await loadWorkspace(backendUrl, authToken, workspaceId, currentRecords, active, fetchBody, fetchIndex);
        if (!active()) return;
        if (![0, 1].includes(remote.persistenceProtocolVersion)) throw new Error('Unsupported server persistence protocol. Drafts are retained.');
        if (remote.persistenceProtocolVersion !== 1 && (retainedCommandRef.current || currentRecords().some((record) => record.envelope || (record.baseline?.revision && record.baseline.revision !== '0')))) {
          throw new Error('The server does not support the retained versioned drafts. Automatic downgrade is paused.');
        }
        const retainedCommand = retainedCommandRef.current;
        let rejectedCommand = '';
        if (retainedCommand) {
          // A crash may have interrupted local retention, the response, or cache refresh.
          // Replay exact bytes only after authenticated membership/capability checks.
          await persist();
          if (!active()) return;
          try { await sendTodoCommand(backendUrl, authToken, draftScope(backendUrl, userId, workspaceId), retainedCommand); }
          catch (error) {
            // Receipt lookup precedes target existence checks: a typed not_found
            // proves this command did not commit. Still refresh before releasing it.
            if (!(error instanceof BackendError) || error.status !== 404 || error.code !== 'not_found') throw error;
            rejectedCommand = message(error);
          }
          if (!active()) return;
          bodyQueries.clear();
          remote = await loadWorkspace(backendUrl, authToken, workspaceId, currentRecords, active, fetchBody, fetchIndex);
          if (!active()) return;
          if (remote.persistenceProtocolVersion !== 1) throw new Error('Command recovery requires versioned live snapshots.');
        }
        const remotePages = [...remote.documents.map(documentToOutlinePage), ...remote.unchangedPages];
        if (remote.persistenceProtocolVersion === 1) remotePages.forEach(assertVersionedPage);
        beginStage('merging');
        indexRef.current = remote.entries;
        setDocumentIndex(remote.entries);
        const records = mergeWorkspace(currentRecords(), remotePages);
        recordsRef.current = records;
        directoriesRef.current = remote.directories;
        setDirectories(remote.directories);
        apply({ type: 'refreshPages', pages: records.map((entry) => entry.page) });
        beginStage('persisting');
        retainedCommandRef.current = undefined;
        try { await persist(records); }
        catch (error) { if (active()) retainedCommandRef.current = retainedCommand; throw error; }
        if (!active()) return;
        syncRef.current = true;
        controllerRef.current = remote.persistenceProtocolVersion === 1 ? createSaveController(epoch) : null;
        setSessionStatus('ready');
        setLoadStatus('ready');
        setSyncMessage(rejectedCommand ? `Command rejected: ${rejectedCommand}` : `Indexed ${remote.entries.length} documents; loaded ${remote.documents.length} bodies${records.some((entry) => entry.conflict) ? '; local conflicts retained' : ''}.`);
        if (!pagesRef.current.length) apply({ type: 'createTodayJournal' });
        if (retainedCommand) await onPagesSavedRef?.current?.().catch(() => undefined);
        if (!active()) return;
        const controller = controllerRef.current;
        if (controller && records.some((record) => record.envelope && !record.conflict)) {
          setSaving(true);
          const replay = Promise.all(records.filter((record) => record.envelope && !record.conflict).map((record) => controller.flush(draftId(record), true))).then(() => undefined);
          savingRef.current = replay;
          try { await replay; }
          finally { if (savingRef.current === replay) savingRef.current = null; if (active()) setSaving(false); }
        }
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
      bodyQueries.clear();
      cancelled = true;
      syncRef.current = false;
      if (epochRef.current === epoch) ++epochRef.current;
    };
  }, [backendUrl, userId, workspaceId, authToken, refresh, apply, currentRecords, persist, failSession, createSaveController, onPagesSavedRef, loadWorkspace, bodyQueries, fetchIndex]);

  // No network debounce here: retain every editor snapshot, including active draft text.
  useEffect(() => {
    if (!localReady || !scopeReadyRef.current) return;
    void persist().catch(() => undefined);
  }, [pagesForPersistence, directories, localReady, persist]);

  const flushDirtyPages = useCallback(async (snapshotOverride?: OutlinePage[], commandFlush = false) => {
    if (retainedCommandRef.current) return;
    if (commandRef.current && !commandFlush) return;
    if (!userId || !workspaceId || JSON.stringify(storageRef.current?.scope) !== JSON.stringify(draftScope(backendUrl, userId, workspaceId))) return;
    if (savingRef.current) return savingRef.current;
    if (!syncRef.current || !scopeReadyRef.current) return;
    const controller = controllerRef.current;
    if (controller) {
      const epoch = epochRef.current;
      const records = currentRecords().filter((record) => !snapshotOverride || record.envelope || snapshotOverride.some((page) => pagePersistenceKey(page) === pagePersistenceKey(record.page)));
      setSaving(true);
      const promise = Promise.all(records.map((record) => controller.flush(draftId(record)))).then(async () => {
        if (epoch === epochRef.current) {
          bodyQueries.clearLists();
          await onPagesSavedRef?.current?.().catch(() => undefined);
        }
      }).finally(() => {
        if (savingRef.current === promise) savingRef.current = null;
        if (epoch === epochRef.current) setSaving(false);
      });
      savingRef.current = promise;
      return promise;
    }
    if (!currentRecords().some((entry) => !entry.pending && !entry.conflict && entry.savedHash !== pageHash(entry.page))) return;
    const epoch = epochRef.current;
    const run = async () => {
      setSaving(true);
      for (const candidate of snapshotOverride ?? pagesRef.current) {
        if (epoch !== epochRef.current || !syncRef.current) break;
        const page = findPageForPersistence(pagesRef.current, candidate);
        if (!page) continue;
        const record = currentRecords().find((entry) => entry.page.id === page.id)!;
        if (record.pending || record.envelope || record.conflict || record.needsRefresh || record.savedHash === pageHash(page)) continue;
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
      if (epoch === epochRef.current) {
        bodyQueries.clearLists();
        await onPagesSavedRef?.current?.().catch(() => undefined);
      }
    };
    const promise = run().finally(() => {
      if (savingRef.current === promise) savingRef.current = null;
      if (epoch === epochRef.current) setSaving(false);
    });
    savingRef.current = promise;
    return promise;
  }, [apply, authToken, backendUrl, currentRecords, failSession, onPagesSavedRef, persist, userId, workspaceId, bodyQueries]);

  const syncEnabled = sessionStatus === 'ready' && loadStatus === 'ready' && localReady && !localError;
  useEffect(() => {
    if (!syncEnabled) return;
    const timer = window.setTimeout(() => { void flushDirtyPages(); }, 10000);
    return () => window.clearTimeout(timer);
  }, [pagesForPersistence, syncEnabled, saving, flushDirtyPages]);

  const refreshWorkspace = useCallback(async () => {
    if (savingRef.current) await savingRef.current;
    if (storageRef.current) {
      try { await persist(); } catch { return; }
    }
    await new Promise<void>((resolve) => {
      refreshWaiters.current.push(resolve);
      setRefresh((value) => value + 1);
    });
  }, [persist]);

  const runSync = useCallback(async () => {
    if (commandRef.current) { setSyncMessage('A document command is still running.'); return; }
    await refreshWorkspace();
  }, [refreshWorkspace]);

  const runDocumentCommand = useCallback(async <T,>(command: () => Promise<T>): Promise<T> => {
    if (retainedCommandRef.current) throw new Error('Sync to recover the retained command before starting another.');
    if (commandRef.current) throw new Error('A document command is already running.');
    const epoch = epochRef.current;
    const ticket = {};
    const storage = storageRef.current;
    const check = () => {
      if (epoch !== epochRef.current || !syncRef.current || !scopeReadyRef.current) throw new Error('Connect to the workspace before running this command.');
    };
    check();
    commandRef.current = ticket;
    let invalidated = false;
    try {
      // Await the current flight, then drain edits that arrived during that flight.
      // Autosave's best-effort completion is not proof that a command may proceed.
      for (let attempt = 0; attempt < 3; attempt++) {
        await flushDirtyPages(undefined, true);
        check();
        const blocked = currentRecords().filter((record) => isDraftDirty(record) || record.needsRefresh);
        if (!blocked.length) break;
        if (attempt === 2 || blocked.some((record) => record.pending || record.envelope || record.conflict || record.retry || record.needsRefresh)) {
          throw new Error('Resolve pending saves or refresh conflicts before running this command.');
        }
      }
      // Commands can affect linked TODOs in other documents. Retain invalidation
      // before sending, and keep snapshot saves paused through the body refresh.
      recordsRef.current = currentRecords().map((record) => record.page.backendId ? { ...record, needsRefresh: true } : record);
      invalidated = true;
      await persist();
      check();
      if (currentRecords().some(isDraftDirty)) throw new Error('New edits arrived before the command. Save them and retry.');
      const result = await command();
      check();
      return result;
    } finally {
      try {
        if (invalidated && epoch === epochRef.current && syncRef.current) await refreshWorkspace();
      } finally {
        if (commandRef.current === ticket) commandRef.current = null;
      }
      if (storageRef.current !== storage || (invalidated && !syncRef.current)) throw new Error('Command outcome needs a workspace refresh; retained drafts were preserved.');
    }
  }, [currentRecords, flushDirtyPages, persist, refreshWorkspace]);

  const runTodoCommand = useCallback(async (operation: 'repository' | 'pull', documentId?: number) => {
    const epoch = epochRef.current;
    return runDocumentCommand(async () => {
      if (!controllerRef.current) {
        return operation === 'repository'
          ? { movedCount: await moveDocumentTodosToRepository(backendUrl, authToken, documentId!), pulledCount: 0, documentId: 0 }
          : { ...await pullOnDeckTodosToToday(backendUrl, authToken, workspaceId!), movedCount: 0 };
      }
      const scope = draftScope(backendUrl, userId!, workspaceId!);
      const target = operation === 'repository' ? documentId! : await getCommandDate(backendUrl, authToken, scope[2]);
      if (epoch !== epochRef.current || !syncRef.current) throw new Error('The session changed before command preparation.');
      if (currentRecords().some(isDraftDirty)) throw new Error('New edits arrived during command preparation. Save them and retry.');
      const envelope = prepareTodoCommand(scope, operation, target);
      retainedCommandRef.current = envelope;
      await persist();
      if (epoch !== epochRef.current || !syncRef.current) throw new Error('Command retained; reconnect to recover it.');
      return sendTodoCommand(backendUrl, authToken, scope, envelope);
    });
  }, [authToken, backendUrl, currentRecords, persist, runDocumentCommand, userId, workspaceId, bodyQueries]);

  const runTodoUpdate = useCallback(async (id: number, input: TodoPatch) => {
    const patch = structuredClone(input);
    const storage = storageRef.current;
    const epoch = epochRef.current;
    await runDocumentCommand(async () => {
      const current = (await bodyQueries.todos(backendUrl, authToken, userId!)).find((todo) => todo.id === id);
      if (epoch !== epochRef.current || !syncRef.current) throw new Error('The session changed during TODO preparation.');
      if (!current) throw new Error('This TODO no longer exists. Refresh the list.');
      if (currentRecords().some(isDraftDirty)) throw new Error('New edits arrived during TODO preparation. Save them and retry.');
      if (!controllerRef.current) {
        const legacy = { ...current, ...patch };
        if (patch.status && patch.bucket === undefined) legacy.bucket = patch.status === 'done' ? 'done' : patch.status === 'blocked' ? 'blocked'
          : (current.bucket === 'done' || current.bucket === 'blocked' ? '' : current.bucket);
        await updateTodo(backendUrl, authToken, legacy);
        return;
      }
      const scope = draftScope(backendUrl, userId!, workspaceId!);
      const envelope = prepareTodoUpdate(scope, current, patch);
      retainedCommandRef.current = envelope;
      await persist();
      if (epoch !== epochRef.current || !syncRef.current) throw new Error('TODO update retained; reconnect to recover it.');
      await sendTodoCommand(backendUrl, authToken, scope, envelope);
    });
    // The receipt is historical. Fetch the live TODO instead of installing it in the UI.
    if (storageRef.current !== storage) throw new Error('The TODO session changed.');
    const current = (await bodyQueries.todos(backendUrl, authToken, userId!)).find((todo) => todo.id === id);
    if (storageRef.current !== storage) throw new Error('The TODO session changed.');
    if (!current) throw new Error('The TODO was deleted after this command.');
    return current;
  }, [authToken, backendUrl, currentRecords, persist, runDocumentCommand, userId, workspaceId, bodyQueries]);

  const deleteNote = useCallback(async (pageId: string) => {
    const epoch = epochRef.current;
    const original = currentRecords().find((record) => record.page.id === pageId);
    if (!original || original.page.kind !== 'note') throw new Error('Open a note to delete it.');
    const id = draftId(original);
    if (!original.page.backendId) {
      if (savingRef.current || original.pending || original.envelope || commandRef.current) throw new Error('Resolve the pending save before deleting this local note.');
      await removeDraft(id);
      return;
    }
    await runDocumentCommand(async () => {
      const record = currentRecords().find((entry) => draftId(entry) === id);
      if (!record?.page.backendId) throw new Error('Refresh the note before deleting it.');
      const controller = controllerRef.current;
      if (controller) {
        // This flag was set by this command's invalidation, after the strict barrier.
        const envelope = prepareDelete({ ...record, needsRefresh: false }, draftScope(backendUrl, userId!, workspaceId!));
        recordsRef.current = currentRecords().map((entry) => draftId(entry) === id ? { ...entry, envelope } : entry);
        await controller.flush(id, true);
        if (currentRecords().some((entry) => draftId(entry) === id)) throw new Error('Deletion is unresolved or newer edits were retained. Sync or review the retained draft.');
      } else {
        await deleteDocument(backendUrl, authToken, record.page.backendId);
        if (epoch !== epochRef.current) throw new Error('The session changed while deleting the note.');
        const latest = currentRecords().find((entry) => draftId(entry) === id);
        if (latest && pageHash(latest.page) !== pageHash(record.page)) {
          recordsRef.current = currentRecords().map((entry) => draftId(entry) === id ? { ...entry, conflict: 'The note was deleted; newer local edits are retained for recovery.', serverCopy: null } : entry);
          await persist();
          throw new Error('The note was deleted; newer local edits are retained for recovery.');
        } else await removeDraft(id);
      }
    });
  }, [authToken, backendUrl, currentRecords, persist, removeDraft, runDocumentCommand, userId, workspaceId]);

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
    controllerRef.current = null;
    commandRef.current = null;
    retainedCommandRef.current = undefined;
    recordsRef.current = [];
    setDocumentIndex([]);
    indexRef.current = [];
    bodyQueries.clear();
    bodyLoads.current.clear();
    setLocalReady(false);
    setLocalError('');
    setPersistedHashes({});
    setPageSaveIndicators({});
    setLoadTimings({});
    setLoadStatus('idle');
    setSaving(false);
    setDirectories([]);
    apply({ type: 'hydrate', pages: [], source: 'session:detach' });
  }, [apply, persist, bodyQueries]);

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

  const ensurePageLoaded = useCallback(async (pageId: string): Promise<OutlinePage> => {
    recordsRef.current = currentRecords().map(record => record.page.id === pageId ? { ...record, lastAccessedAt: Date.now() } : record);
    const existing = pagesRef.current.find(page => page.id === pageId);
    if (existing) return existing;
    const metadata = documentIndex.find(entry => `document-${entry.id}` === pageId);
    const id = metadata?.id ?? (/^document-[1-9][0-9]*$/.test(pageId) ? Number(pageId.slice(9)) : 0);
    if (!Number.isSafeInteger(id) || !id || !syncRef.current || !workspaceId) throw new Error('Document is not cached. Connect and Sync to open it.');
    const prior = bodyLoads.current.get(id);
    if (prior) return prior;
    const epoch = epochRef.current;
    const request = (async () => {
      const document = await bodyQueries.get(draftScope(backendUrl, userId!, workspaceId), authToken, id);
      if (epoch !== epochRef.current || !syncRef.current) throw new Error('Document loading scope changed.');
      if (document.id !== id || document.workspaceId !== workspaceId) throw new Error('Document identity does not match this workspace.');
      const remote = documentToOutlinePage(document);
      assertVersionedPage(remote);
      const records = currentRecords();
      const related = records.filter(record => record.page.backendId === id || record.page.clientKey === remote.clientKey);
      const merged = mergeWorkspace(related, [remote]).map(record => ({ ...record, lastAccessedAt: Date.now() }));
      recordsRef.current = [...records.filter(record => !related.includes(record)), ...merged];
      apply({ type: 'refreshPages', pages: recordsRef.current.map(record => record.page) });
      await persist();
      if (epoch !== epochRef.current) throw new Error('Document loading scope changed.');
      return pagesRef.current.find(page => page.backendId === id)!;
    })();
    bodyLoads.current.set(id, request);
    try { return await request; }
    finally {
      if (bodyLoads.current.get(id) === request) {
        bodyLoads.current.delete(id);
        if (epoch === epochRef.current) await persist();
      }
    }
  }, [documentIndex, workspaceId, backendUrl, authToken, currentRecords, apply, persist, bodyQueries, userId]);

  const dispatch = useCallback((action: OutlineAction) => {
    if (!writableRef.current && !['openSettings', 'openAI', 'openPomodoro'].includes(action.type)) return;
    if (storageRef.current && (!userId || !workspaceId || JSON.stringify(storageRef.current.scope) !== JSON.stringify(draftScope(backendUrl, userId, workspaceId)))) return;
    const ticket = ++selectionTicket.current;
    let adjacentJournal: string | undefined;
    const current = stateRef.current;
    if (action.type === 'moveFocus' && !action.extendSelection && current.activeView === 'journals') {
      const page = current.pages.find(page => page.id === current.activePageId);
      const nodes = getVisibleNodes(page?.nodes ?? [], current.collapsedNodeIds);
      const position = nodes.findIndex(node => node.id === current.focusedId);
      if (position >= 0 && (action.direction === 1 ? position === nodes.length - 1 : position === 0)) {
        const journals = getJournalPages({ ...current, pages: navigationPages(documentIndex, current.pages) });
        adjacentJournal = journals[journals.findIndex(page => page.id === current.activePageId) + action.direction]?.id;
      }
    }
    const target = adjacentJournal ?? (action.type === 'selectNote' || action.type === 'selectJournalPage' ? action.pageId
      : action.type === 'selectJournal' || action.type === 'createTodayJournal'
        ? documentIndex.find(entry => entry.kind === 'journal' && entry.journalDate === getDateKey(getCurrentJournalDate()))?.id : undefined);
    const targetId = typeof target === 'number' ? `document-${target}` : target;
    if (targetId && !pagesRef.current.some(page => page.id === targetId)) {
      const epoch = epochRef.current;
      void ensurePageLoaded(targetId).then(() => {
        if (epoch === epochRef.current && ticket === selectionTicket.current && writableRef.current) apply(action);
      }).catch(error => { if (epoch === epochRef.current && ticket === selectionTicket.current) setSyncMessage(message(error)); });
      return;
    }
    apply(action);
  }, [apply, backendUrl, userId, workspaceId, documentIndex, ensurePageLoaded]);

  const updateDirectories: Dispatch<React.SetStateAction<BackendDirectory[]>> = useCallback((value) => {
    if (!userId || !workspaceId || JSON.stringify(storageRef.current?.scope) !== JSON.stringify(draftScope(backendUrl, userId, workspaceId))) return;
    setDirectories(value);
  }, [backendUrl, userId, workspaceId]);

  const dispatchAfterFlush = useCallback((action: OutlineAction) => {
    dispatch(action);
    if (scopeReadyRef.current) void persist().catch(() => undefined);
    void flushDirtyPages();
  }, [dispatch, flushDirtyPages, persist]);

  const resolveConflict = useCallback(async (pageId: string, resolution: 'reload' | 'copy' | 'save', reviewed?: OutlinePage) => {
    if (commandRef.current) throw new Error('Wait for the document command before resolving this draft.');
    if (!authToken || savingRef.current) return;
    const epoch = epochRef.current;
    try {
      const record = currentRecords().find((entry) => entry.page.id === pageId);
      if (!record) return;
      if (record.envelope && !record.conflict) throw new Error('Resolve the retained save request before discarding or copying this draft.');
      const serverId = record.serverCopy?.backendId ?? record.page.backendId;
      const document = serverId
        ? await getDocument(backendUrl, authToken, serverId).catch((error) => {
          if (error instanceof BackendError && error.status === 404) return null;
          throw error;
        })
        : null;
      const remote = document ? documentToOutlinePage(document) : null;
      if (remote && controllerRef.current) assertVersionedPage(remote);
      if (epoch !== epochRef.current) return;
      const latest = currentRecords().find((entry) => entry.page.id === pageId)!;
      if (resolution === 'save') {
        const compared = reviewed ?? record.serverCopy;
        if (!controllerRef.current || !compared?.revision || !remote) throw new Error('A versioned server copy must be reviewed before saving.');
        if (remote.backendId !== compared.backendId || remote.revision !== compared.revision) {
          recordsRef.current = currentRecords().map((entry) => entry.page.id === pageId ? { ...entry, serverCopy: remote,
            conflict: 'The server changed again. Review the refreshed server copy before saving.' } : entry);
          await persist();
          throw new Error('The server changed again. Review the refreshed server copy before saving.');
        }
        const resolved = { ...latest, page: adoptSnapshotIdentity(latest.page, remote), baseline: remote, savedHash: pageHash(remote),
          acknowledgedGeneration: undefined,
          envelope: undefined, pending: false, conflict: undefined, serverCopy: undefined, retry: undefined, needsRefresh: false };
        const records = currentRecords().map((entry) => entry.page.id === pageId ? resolved : entry);
        writableRef.current = false;
        try { await persist(records); }
        finally { if (epoch === epochRef.current) writableRef.current = true; }
        if (epoch !== epochRef.current) return;
        recordsRef.current = records;
        apply({ type: 'mergeRemotePage', page: resolved.page, previousPageId: pageId, source: 'session:reviewedResolution' });
        await flushDirtyPages();
        return;
      }
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
    } catch (error) { if (epoch === epochRef.current) setSyncMessage(message(error)); throw error; }
  }, [apply, authToken, backendUrl, currentRecords, persist, flushDirtyPages]);

  const page = pagesForPersistence.find((entry) => entry.id === state.activePageId);
  const conflicts = draftConflicts(currentRecords(), saving);
  const record = page ? currentRecords().find((entry) => entry.page.id === page.id) : undefined;
  const activePageIsDirty = Boolean(record && isDraftDirty(record));
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
    : record?.envelope?.operation === 'delete' ? `${localMessage} · ${record.retry ? 'deletion unresolved; Sync now to retry' : 'deletion pending'}`
    : record?.needsRefresh ? `${localMessage} · refresh required; Sync now`
    : activePageIsDirty && record?.retry && sessionStatus === 'ready' ? `${localMessage} · ${record.retry.attempts >= 3 ? 'retry paused; Sync now to retry' : 'save failed; retry pending'}`
    : activePageIsDirty ? `${localMessage} · ${indicator?.status === 'saving' ? 'saving…' : sessionStatus === 'ready' ? 'pending save' : sessionLabel.toLowerCase()}`
      : localError ? localMessage : 'Saved';
  const activePageSaveMessage = useSaveStatus(
    JSON.stringify([backendUrl, userId, workspaceId, page?.id]), saveMessage,
    Boolean(localError || hasActiveConflict || indicator?.status === 'failed' || sessionStatus !== 'ready'),
  );

  const availablePages = useMemo(() => navigationPages(documentIndex, pagesForPersistence), [documentIndex, pagesForPersistence]);
  return {
    queries: bodyQueries, fetchIndex,
    documentIndex, navigationPages: availablePages, ensurePageLoaded,
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
    flushDirtyPages, runDocumentCommand, runTodoCommand, runTodoUpdate, deleteNote, dispatchAfterFlush, runLogin, runSync, handleLogout,
  };
}
