import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { useOutlineState } from '../src/features/outline/state';
import { useSessionSync } from '../src/features/session/useSessionSync';
import { DraftStorage, draftScope, openDraftDatabase } from '../src/lib/draftStorage';
import { documentToOutlinePage } from '../src/features/outline/remote';
import { pageHash } from '../src/app/pagePersistence';
import { mergeWorkspace } from '../src/features/session/draftReconciliation';

const backend = 'https://example.com';
const token = `e30.${btoa(JSON.stringify({ sub: '1' }))}.signature`;
const doc = { id: 1, workspaceId: 1, clientKey: 'document-1', kind: 'note' as const, title: 'Remote', journalDate: '', directoryId: 0,
  createdAt: '', updatedAt: '', blocks: [{ id: 1, clientKey: 'block-1', documentId: 1, parentBlockId: 0, parentClientKey: '', sortOrder: 1, text: 'Server text', todoId: 0, createdAt: '', updatedAt: '' }] };
const page = documentToOutlinePage(doc);

async function environment(cached = true) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, indexedDB: new IDBFactory() });
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { setTimeout, clearTimeout }) });
  localStorage.setItem('secretary-native-settings', JSON.stringify({ backendUrl: backend, token, userId: 1, workspaceId: 1 }));
  if (cached) {
    const db = await openDraftDatabase();
    const storage = new DraftStorage(db, draftScope(backend, 1, 1));
    await storage.load();
    await storage.save({ records: [{ page, baseline: page, savedHash: pageHash(page) }], directories: [] });
    db.close();
  }
}

type Session = ReturnType<typeof useSessionSync>;
async function mount() {
  let session: Session;
  let renderer: ReactTestRenderer;
  function Harness() {
    const [state, dispatch] = useOutlineState();
    session = useSessionSync({ state, dispatch });
    return null;
  }
  await act(async () => { renderer = create(createElement(Harness)); });
  return { current: () => session!, unmount: async () => { await act(async () => renderer!.unmount()); } };
}

async function until(predicate: () => boolean) {
  // Status text deliberately settles after a 3.5-second presentation debounce.
  for (let attempt = 0; attempt < 850; attempt++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    if (predicate()) return;
  }
  throw new Error('Timed out waiting for session state.');
}

function respond(url: string) {
  if (url.endsWith('ListWorkspaces')) return Response.json({ workspaces: [{ id: 1, name: 'Personal' }] });
  if (url.endsWith('ListDocuments')) return Response.json({ documents: [doc], directories: [] });
  throw new Error(`Unexpected request: ${url}`);
}

test('loading stages and timings stay accurate while saves wait for the retained baseline', async () => {
  await environment();
  let finishAuth!: () => void;
  let finishDocuments!: () => void;
  let finishCache!: () => void;
  const auth = new Promise<void>((resolve) => { finishAuth = resolve; });
  const documents = new Promise<void>((resolve) => { finishDocuments = resolve; });
  const cache = new Promise<void>((resolve) => { finishCache = resolve; });
  let holdCache = false;
  let saves = 0;
  const original = DraftStorage.prototype.save;
  DraftStorage.prototype.save = async function (snapshot) {
    if (holdCache) await cache;
    return original.call(this, snapshot);
  };
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith('ListWorkspaces')) await auth;
    if (String(url).endsWith('ListDocuments')) await documents;
    if (String(url).endsWith('SaveDocument')) {
      saves++;
      return Response.json({ document: doc });
    }
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().loadStatus === 'authenticating');
    assert.equal(app.current().sessionLabel, 'Validating session');
    await act(async () => app.current().dispatch({ type: 'updatePageTitle', title: 'Local edit during load' }));
    await until(() => app.current().activePageSaveMessage.startsWith('Retained locally'));
    assert.match(app.current().activePageSaveMessage, /validating session/);

    await act(async () => finishAuth());
    await until(() => app.current().loadStatus === 'documents');
    assert.equal(app.current().sessionStatus, 'loading');
    assert.equal(app.current().sessionLabel, 'Loading documents');
    assert.match(app.current().activePageSaveMessage, /loading documents/);
    assert.equal(app.current().isSyncing, true);
    assert.equal(app.current().syncEnabled, false);
    await act(async () => app.current().flushDirtyPages());
    assert.equal(saves, 0);

    holdCache = true;
    await act(async () => finishDocuments());
    await until(() => app.current().loadStatus === 'persisting');
    assert.equal(app.current().sessionLabel, 'Saving local cache');
    assert.equal(app.current().initialLoadResolved, false);
    assert.equal(app.current().syncEnabled, false);
    await act(async () => app.current().flushDirtyPages());
    assert.equal(saves, 0);

    await act(async () => finishCache());
    await until(() => app.current().sessionStatus === 'ready');
    assert.equal(app.current().syncEnabled, true);
    assert.equal(app.current().pagesRef.current[0].title, 'Local edit during load');
    for (const stage of ['restoring', 'authenticating', 'documents', 'merging', 'persisting', 'total'] as const) {
      assert.ok(Number.isFinite(app.current().loadTimings[stage]), `missing timing: ${stage}`);
      assert.ok(app.current().loadTimings[stage]! >= 0);
    }
    assert.match(app.current().loadTimingMessage, /Loading documents: \d+ ms/);
    assert.match(app.current().loadTimingMessage, /Saving local cache: \d+ ms/);
  } finally {
    finishAuth(); finishDocuments(); finishCache();
    DraftStorage.prototype.save = original;
    await app.unmount();
  }
});

test('expired-token startup retains cached content and never creates an empty journal', async () => {
  await environment();
  globalThis.fetch = (async () => Response.json({ error: 'expired' }, { status: 401 })) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().sessionStatus === 'reauth-required');
    assert.equal(app.current().pagesRef.current[0].nodes[0].text, 'Server text');
    assert.equal(app.current().pagesRef.current.length, 1);
    assert.equal(app.current().syncEnabled, false);
    assert.equal(app.current().initialLoadResolved, false);
  } finally { await app.unmount(); }
});

test('cold network failure does not create or report an empty successful workspace', async () => {
  await environment(false);
  globalThis.fetch = (async () => { throw new TypeError('Offline'); }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().loadStatus === 'failed');
    assert.equal(app.current().pagesRef.current.length, 0);
    assert.equal(app.current().authToken, token);
    assert.equal(app.current().initialLoadResolved, false);
    assert.equal(app.current().sessionLabel, 'Sync unavailable');
    assert.ok(Number.isFinite(app.current().loadTimings.authenticating));
    assert.equal(app.current().loadTimings.documents, undefined);
  } finally { await app.unmount(); }
});

test('offline active editor text survives restart and refresh does not overwrite it', async () => {
  await environment();
  globalThis.fetch = (async () => { throw new TypeError('Offline'); }) as typeof fetch;
  let app = await mount();
  try {
    await until(() => app.current().loadStatus === 'failed');
    await act(async () => {
      app.current().dispatch({ type: 'startEditing' });
      app.current().dispatch({ type: 'updateDraft', text: 'Offline unsent text' });
    });
    await until(() => app.current().activePageSaveMessage.startsWith('Retained locally'));
    await app.unmount();
    globalThis.fetch = (async (url) => respond(String(url))) as typeof fetch;
    app = await mount();
    await until(() => app.current().sessionStatus === 'ready');
    assert.equal(app.current().pagesRef.current[0].nodes[0].text, 'Offline unsent text');
    assert.equal(app.current().activePageIsDirty, true);
  } finally { await app.unmount(); }
});

test('storage failure is visible and does not send a save without local retention', async () => {
  await environment();
  globalThis.fetch = (async (url) => respond(String(url))) as typeof fetch;
  const app = await mount();
  const original = DraftStorage.prototype.save;
  try {
    await until(() => app.current().sessionStatus === 'ready');
    DraftStorage.prototype.save = async () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); };
    await act(async () => app.current().dispatch({ type: 'updatePageTitle', title: 'Unsaved title' }));
    await until(() => !!app.current().localError);
    assert.match(app.current().activePageSaveMessage, /Local storage failed/);
    assert.equal(app.current().syncEnabled, false);
    assert.equal(app.current().pagesRef.current[0].title, 'Unsaved title');
  } finally { DraftStorage.prototype.save = original; await app.unmount(); }
});

test('saving an active new row between children neither moves it nor copies its draft to another row', async () => {
  await environment();
  const sentRows: string[][] = [];
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('SaveDocument')) {
      const incoming = (JSON.parse(String(init?.body)) as { document: typeof doc }).document;
      sentRows.push(incoming.blocks.map((block) => block.text));
      return Response.json({ document: { ...incoming, id: 1,
        blocks: incoming.blocks.map((block) => ({ ...block, id: block.id || 4 })),
      } });
    }
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount();
  const expected = ['Parent', 'First child', 'Polish camera flow', 'Still not feeling smooth after scanning'];
  try {
    await until(() => app.current().sessionStatus === 'ready');
    await act(async () => {
      app.current().dispatch({ type: 'hydrate', pages: [{ ...page, nodes: [
        { id: 'block-1', backendId: 1, parentId: null, text: expected[0] },
        { id: 'block-2', backendId: 2, parentId: 'block-1', text: expected[1] },
        { id: 'local-polish', parentId: null, text: expected[2] },
        { id: 'block-3', backendId: 3, parentId: 'block-1', text: expected[3], todoStatus: 'todo' },
      ] }] });
      app.current().dispatch({ type: 'focus', nodeId: 'local-polish' });
      app.current().dispatch({ type: 'startEditing' });
    });
    await act(async () => app.current().flushDirtyPages());
    assert.deepEqual(sentRows, [expected]);
    assert.deepEqual(app.current().pagesRef.current[0].nodes.map((node) => node.text), expected);
    assert.equal(app.current().stateRef.current.editingId, 'block-4');
    assert.equal(app.current().activePageIsDirty, false);

    // Continue typing into that same row and save again with its assigned server ID.
    await act(async () => app.current().dispatch({ type: 'updateDraft', text: 'Polish camera flow — updated' }));
    await act(async () => app.current().flushDirtyPages());
    const updated = [...expected];
    updated[2] = 'Polish camera flow — updated';
    assert.deepEqual(sentRows[1], updated);
    assert.deepEqual(app.current().pagesRef.current[0].nodes.map((node) => node.text), updated);
    assert.equal(app.current().stateRef.current.editingId, 'block-4');
  } finally { await app.unmount(); }
});

test('logout hides drafts and a late save response cannot restore them', async () => {
  await environment();
  let finishSave: (response: Response) => void = () => undefined;
  let saveStarted = false;
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith('SaveDocument')) {
      saveStarted = true;
      return new Promise<Response>((resolve) => { finishSave = resolve; });
    }
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().sessionStatus === 'ready');
    await act(async () => app.current().dispatch({ type: 'updatePageTitle', title: 'Local title' }));
    let saving: Promise<void>;
    await act(async () => { saving = app.current().flushDirtyPages(); });
    await until(() => saveStarted);
    await act(async () => app.current().handleLogout());
    await until(() => app.current().sessionStatus === 'signed-out');
    await act(async () => { finishSave(Response.json({ document: { ...doc, title: 'Local title' } })); await saving!; });
    assert.equal(app.current().pagesRef.current.length, 0);
    await act(async () => {
      const db = await openDraftDatabase();
      const retained = await new DraftStorage(db, draftScope(backend, 1, 1)).load();
      assert.equal(retained.records[0].page.title, 'Local title');
      assert.equal(retained.records[0].pending, true);
      db.close();
    });
  } finally { await app.unmount(); }
});

test('reauthentication restores the original account draft without blanket hydration', async () => {
  await environment();
  let expired = true;
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith('/api/login')) {
      expired = false;
      return Response.json({ token, user: { id: 1, firstName: 'User' } });
    }
    return expired ? Response.json({ error: 'expired' }, { status: 401 }) : respond(String(url));
  }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().sessionStatus === 'reauth-required');
    await act(async () => app.current().dispatch({ type: 'updatePageTitle', title: 'Retain through login' }));
    await until(() => app.current().activePageSaveMessage.startsWith('Retained locally'));
    await act(async () => { await app.current().runLogin(); });
    await until(() => app.current().sessionStatus === 'ready');
    assert.equal(app.current().pagesRef.current[0].title, 'Retain through login');
    assert.equal(app.current().activePageIsDirty, true);
    assert.equal(app.current().conflicts.length, 0);
  } finally { await app.unmount(); }
});

test('switching accounts never rebinds old drafts or accepts old editor callbacks', async () => {
  await environment();
  const secondToken = `e30.${btoa(JSON.stringify({ sub: '2' }))}.signature`;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('/api/login')) return Response.json({ token: secondToken, user: { id: 2 } });
    const second = new Headers(init?.headers).get('Authorization') === `Bearer ${secondToken}`;
    if (second && String(url).endsWith('ListDocuments')) return Response.json({ documents: [{ ...doc, title: 'Second account' }] });
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().sessionStatus === 'ready');
    const oldDispatch = app.current().dispatch;
    await act(async () => app.current().dispatch({ type: 'updatePageTitle', title: 'First account draft' }));
    await until(() => app.current().activePageSaveMessage.startsWith('Retained locally'));
    await act(async () => { await app.current().runLogin(); });
    await until(() => app.current().sessionStatus === 'ready' && app.current().userId === 2);
    await act(async () => oldDispatch({ type: 'updatePageTitle', title: 'Late old response' }));
    assert.equal(app.current().pagesRef.current[0].title, 'Second account');
    await act(async () => {
      const db = await openDraftDatabase();
      assert.equal((await new DraftStorage(db, draftScope(backend, 1, 1)).load()).records[0].page.title, 'First account draft');
      db.close();
    });
  } finally { await app.unmount(); }
});

test('edits during a save remain dirty and durable after the older acknowledgment', async () => {
  await environment();
  let finish: (response: Response) => void = () => undefined;
  let started = false;
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith('SaveDocument')) { started = true; return new Promise<Response>((resolve) => { finish = resolve; }); }
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().sessionStatus === 'ready');
    await act(async () => app.current().dispatch({ type: 'updatePageTitle', title: 'Submitted' }));
    let saving: Promise<void>;
    await act(async () => { saving = app.current().flushDirtyPages(); });
    await until(() => started);
    await act(async () => app.current().dispatch({ type: 'updatePageTitle', title: 'Newer edit' }));
    await act(async () => { finish(Response.json({ document: { ...doc, title: 'Submitted' } })); await saving!; });
    await until(() => app.current().activePageSaveMessage.startsWith('Retained locally'));
    assert.equal(app.current().pagesRef.current[0].title, 'Newer edit');
    assert.equal(app.current().activePageIsDirty, true);
    await act(async () => {
      const db = await openDraftDatabase();
      const retained = (await new DraftStorage(db, draftScope(backend, 1, 1)).load()).records[0];
      assert.equal(retained.page.title, 'Newer edit');
      assert.equal(retained.baseline?.title, 'Submitted');
      assert.equal(retained.pending, undefined);
      db.close();
    });
  } finally { await app.unmount(); }
});

test('a remotely deleted dirty draft can be retained as a fresh note', async () => {
  await environment();
  const db = await openDraftDatabase();
  const storage = new DraftStorage(db, draftScope(backend, 1, 1));
  await storage.load();
  await storage.save({ records: [{ page: { ...page, title: 'Keep this' }, baseline: page, savedHash: pageHash(page) }], directories: [] });
  db.close();
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith('ListDocuments')) return Response.json({ documents: [] });
    if (String(url).endsWith('GetDocument')) return Response.json({ message: 'not found' }, { status: 404 });
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().conflicts.length === 1);
    await act(async () => { await app.current().resolveConflict(page.id, 'copy'); });
    assert.equal(app.current().pagesRef.current[0].title, 'Keep this (recovered)');
    assert.equal(app.current().pagesRef.current[0].backendId, undefined);
    assert.equal(app.current().conflicts.length, 0);
  } finally { await app.unmount(); }
});

test('restored journal conflicts expose the server copy offline and reload using its server ID', async () => {
  await environment();
  const serverDocument = { ...doc, id: 225, kind: 'journal' as const, title: '2026-09-23', journalDate: '2026-09-23',
    blocks: [{ ...doc.blocks[0], documentId: 225, text: 'The long journal on the server.' }] };
  const serverPage = documentToOutlinePage(serverDocument);
  const localPage = { ...serverPage, id: 'local-journal', backendId: undefined,
    nodes: [{ id: 'empty-1', parentId: null, text: '' }, { id: 'empty-2', parentId: null, text: '' }] };
  const db = await openDraftDatabase();
  const storage = new DraftStorage(db, draftScope(backend, 1, 1));
  await storage.load();
  await storage.save({ records: mergeWorkspace([{ page: localPage }], [serverPage]), directories: [] });
  db.close();
  let offline = true;
  const writes: string[] = [];
  globalThis.fetch = (async (url, init) => {
    if (offline) throw new TypeError('Offline');
    if (String(url).endsWith('GetDocument')) {
      assert.equal(JSON.parse(String(init?.body)).id, 225);
      return Response.json({ document: serverDocument });
    }
    writes.push(String(url));
    throw new Error('Unexpected request');
  }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().loadStatus === 'failed');
    assert.equal(app.current().conflicts.length, 1);
    assert.equal(app.current().conflicts[0].serverCopy?.nodes[0].text, 'The long journal on the server.');
    assert.match(app.current().activePageSaveMessage, /conflict/);
    assert.equal(app.current().activePageSaveMessage.includes('review below'), false);
    offline = false;
    await act(async () => { await app.current().resolveConflict(localPage.id, 'reload'); });
    assert.equal(app.current().pagesRef.current[0].backendId, 225);
    assert.equal(app.current().pagesRef.current[0].nodes[0].text, 'The long journal on the server.');
    assert.equal(app.current().activePageIsDirty, false);
    assert.equal(app.current().conflicts.length, 0);
    assert.deepEqual(writes, []);
  } finally { await app.unmount(); }
});

test('a legacy blank journal fetches and retains a same-date server copy for explicit recovery', async () => {
  await environment();
  const serverDocument = { ...doc, id: 225, kind: 'journal' as const, title: '2026-09-23', journalDate: '2026-09-23' };
  const localPage = { ...documentToOutlinePage(serverDocument), id: 'local-journal', backendId: undefined,
    nodes: [{ id: 'blank', parentId: null, text: '' }] };
  const db = await openDraftDatabase();
  const storage = new DraftStorage(db, draftScope(backend, 1, 1));
  await storage.load();
  await storage.save({ records: [{ page: localPage, conflict: 'Previous conflict' }], directories: [] });
  db.close();
  globalThis.fetch = (async (url) => String(url).endsWith('ListDocuments')
    ? Response.json({ documents: [serverDocument] }) : respond(String(url))) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().sessionStatus === 'ready');
    assert.equal(app.current().conflicts.length, 1);
    assert.equal(app.current().conflicts[0].serverCopy?.backendId, 225);
    assert.equal(app.current().conflicts[0].serverCopy?.nodes[0].text, 'Server text');
    await act(async () => { await app.current().flushDirtyPages(); });
    assert.equal(app.current().conflicts[0].page.nodes[0].text, '');
  } finally { await app.unmount(); }
});

test('opening today during startup does not hide the populated journal when loading finishes', async () => {
  await environment(false);
  let finishLoading: (response: Response) => void = () => undefined;
  let loading = false;
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith('ListDocuments')) {
      loading = true;
      return new Promise<Response>((resolve) => { finishLoading = resolve; });
    }
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().localReady && loading);
    await act(async () => app.current().dispatch({ type: 'selectJournal' }));
    const placeholder = app.current().pagesRef.current.find((entry) => entry.id === app.current().stateRef.current.activePageId)!;
    assert.ok(placeholder);
    await act(async () => finishLoading(Response.json({ documents: [{ ...doc, id: 225, kind: 'journal',
      journalDate: placeholder.date, title: placeholder.date,
      blocks: [{ ...doc.blocks[0], documentId: 225, text: 'Existing populated journal' }] }] })));
    await until(() => app.current().sessionStatus === 'ready');
    const journal = app.current().pagesRef.current.find((entry) => entry.date === placeholder.date)!;
    assert.equal(journal.backendId, 225);
    assert.equal(journal.nodes[0].text, 'Existing populated journal');
    assert.equal(app.current().conflicts.length, 0);
    assert.equal(app.current().pagesRef.current.some((entry) => entry.id === placeholder.id), false);
  } finally { await app.unmount(); }
});
