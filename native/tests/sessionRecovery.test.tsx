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
import { prepareDelete, prepareSave } from '../src/features/session/documentSaveController';
import { useTodos } from '../src/features/todos/useTodos';
import type { BackendTodo } from '../src/lib/backend';
import { prepareTodoCommand, prepareTodoUpdate } from '../src/features/session/todoCommandController';
import { useDirectoryBrowser } from '../src/features/directory/useDirectoryBrowser';
import { listDocuments } from '../src/lib/backend';
import { loadIndexedWorkspace } from '../src/features/session/documentIndex';
import { useSearchView } from '../src/features/search/useSearchView';

// Existing protocol-0/1 recovery scenarios keep their snapshot fixture loader.
// Indexed production loading is exercised separately below with the same hook.
const snapshotWorkspace: typeof loadIndexedWorkspace = async (base, token, workspace) => {
  const result = await listDocuments(base, token, workspace);
  return { ...result, entries: result.documents.map(({ blocks: _, ...entry }) => entry), unchangedPages: [] };
};

const backend = 'https://example.com';
const token = `e30.${btoa(JSON.stringify({ sub: '1' }))}.signature`;
const doc = { id: 1, workspaceId: 1, clientKey: 'document-1', kind: 'note' as const, title: 'Remote', journalDate: '', directoryId: 0,
  createdAt: '', updatedAt: '', blocks: [{ id: 1, clientKey: 'block-1', documentId: 1, parentBlockId: 0, parentClientKey: '', sortOrder: 1, text: 'Server text', todoId: 0, createdAt: '', updatedAt: '' }] };
const page = documentToOutlinePage(doc);

test('indexed startup keeps later-page metadata out of drafts and opens its body on demand', async () => {
  await environment(false);
  const bodies: number[] = [];
  const notes = [3, 2, 1].map(id => ({ ...doc, id, clientKey: `document-${id}`, revision: '1', blocks: [{ ...doc.blocks[0], documentId: id }] }));
  globalThis.fetch = (async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (String(url).endsWith('ListDocumentIndex')) return Response.json({ entries: (body.beforeId ? notes.slice(2) : notes.slice(0, 2)).map(({ blocks: _, ...entry }) => entry), nextBeforeId: body.beforeId ? '0' : '2', persistenceProtocolVersion: 1 });
    if (String(url).endsWith('GetDocument')) { bodies.push(Number(body.id)); return Response.json({ document: notes.find(note => note.id === Number(body.id)) }); }
    if (String(url).endsWith('ListDocuments')) throw new Error('Full-workspace bodies must not be requested');
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount(loadIndexedWorkspace);
  try {
    await until(() => app.current().sessionStatus === 'ready');
    assert.deepEqual(bodies, [3]);
    assert.equal(app.current().navigationPages.length, 3);
    assert.equal(app.directory().directoryEntries.filter(entry => entry.kind === 'note').length, 3);
    assert.equal((await retainedWorkspace()).records.length, 1);
    let opened = false;
    await act(async () => { void app.current().ensurePageLoaded('document-1').then(() => { opened = true; }); });
    await until(() => opened);
    assert.deepEqual(bodies, [3, 1]);
    assert.equal(app.current().pagesRef.current.find(page => page.backendId === 1)?.nodes[0].text, 'Server text');
    assert.equal((await retainedWorkspace()).records.length, 2);
    assert.equal((await retainedWorkspace()).records.some(record => record.page.metadataOnly), false);
  } finally { await app.unmount(); }
});

test('indexed body loading rejects late responses after logout', async () => {
  await environment(false);
  const notes = [2, 1].map(id => ({ ...doc, id, clientKey: `document-${id}`, revision: '1' }));
  let release: (() => void) | undefined;
  globalThis.fetch = (async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (String(url).endsWith('ListDocumentIndex')) return Response.json({ entries: notes, persistenceProtocolVersion: 1 });
    if (String(url).endsWith('GetDocument')) {
      if (body.id === '1') await new Promise<void>(resolve => { release = resolve; });
      return Response.json({ document: notes.find(note => note.id === Number(body.id)) });
    }
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount(loadIndexedWorkspace);
  try {
    await until(() => app.current().sessionStatus === 'ready');
    let rejected = false;
    await act(async () => { void app.current().ensurePageLoaded('document-1').catch(() => { rejected = true; }); });
    await until(() => Boolean(release));
    await act(async () => { app.current().handleLogout(); });
    await until(() => app.current().sessionStatus === 'signed-out');
    release!();
    await until(() => rejected);
    assert.equal(app.current().pagesRef.current.length, 0);
    assert.equal((await retainedWorkspace()).records.some(record => record.page.backendId === 1), false);
  } finally { release?.(); await app.unmount(); }
});

test('workspace body search finds uncached later-page notes without fetching their bodies', async () => {
  await environment(false);
  const notes = [3, 2, 1].map(id => ({ ...doc, id, clientKey: `document-${id}`, revision: '1', title: `Note ${id}` }));
  const bodyReads: number[] = [];
  const searches: string[] = [];
  globalThis.fetch = (async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (String(url).endsWith('ListDocumentIndex')) {
      if (body.query) searches.push(body.beforeId ?? '0');
      const entries = body.beforeId ? notes.slice(2) : notes.slice(0, 2);
      return Response.json({ entries: entries.map(({ blocks: _, ...entry }) => ({ ...entry, snippet: body.query ? 'needle in body' : '' })), nextBeforeId: body.beforeId ? '0' : '2', persistenceProtocolVersion: 1 });
    }
    if (String(url).endsWith('GetDocument')) { bodyReads.push(Number(body.id)); return Response.json({ document: notes.find(note => note.id === Number(body.id)) }); }
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount(loadIndexedWorkspace);
  try {
    await until(() => app.current().sessionStatus === 'ready');
    await act(async () => { app.current().dispatch({ type: 'openSearch' }); });
    await act(async () => { app.search().setSearchQuery('needle'); app.search().setSearchScope('fulltext'); });
    await until(() => app.search().visibleMatches.some(match => match.page.backendId === 1));
    assert.deepEqual(searches, ['0', '2']);
    assert.deepEqual(bodyReads, [3]);
    // The loaded body has no match; stale server snippets cannot override it.
    assert.equal(app.search().visibleMatches.some(match => match.page.backendId === 3), false);
  } finally { await app.unmount(); }
});

test('indexed refresh retains a dirty draft when its document disappears between pages', async () => {
  await environment(false);
  const baseline = documentToOutlinePage({ ...doc, revision: '1' });
  const dirty = { ...baseline, title: 'Local draft' };
  const db = await openDraftDatabase();
  const storage = new DraftStorage(db, draftScope(backend, 1, 1));
  await storage.load();
  await storage.save({ records: [{ page: dirty, baseline, savedHash: pageHash(baseline) }], directories: [] });
  db.close();
  globalThis.fetch = (async url => {
    if (String(url).endsWith('ListDocumentIndex')) return Response.json({ entries: [], persistenceProtocolVersion: 1 });
    if (String(url).endsWith('GetDocument')) return Response.json({ code: 'not_found', message: 'gone' }, { status: 404 });
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount(loadIndexedWorkspace);
  try {
    await until(() => app.current().sessionStatus === 'ready');
    assert.equal(app.current().conflicts[0].page.title, 'Local draft');
    assert.match(app.current().conflicts[0].conflict!, /deleted/);
    assert.equal((await retainedWorkspace()).records[0].page.title, 'Local draft');
  } finally { await app.unmount(); }
});

async function retainedWorkspace() {
  const db = await openDraftDatabase();
  try { return await new DraftStorage(db, draftScope(backend, 1, 1)).load(); }
  finally { db.close(); }
}

for (const version of [0, 1]) test(`TODO update preserves post-save metadata and returns live data (protocol ${version})`, async () => {
  await environment();
  let serverDoc: any = { ...doc, revision: version ? '1' : '0' };
  let currentTodo: any = { id: 7, userId: 1, workspaceId: 1, name: 'Old name', desc: 'Keep description', status: 'todo', bucket: 'on_deck', priorityRank: 9, goalId: 4 };
  const requests: string[] = [];
  let saved = false;
  globalThis.fetch = (async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (String(url).endsWith('ListDocuments')) return Response.json({ documents: [serverDoc], persistenceProtocolVersion: version });
    if (String(url).endsWith('SaveDocument')) {
      saved = true;
      serverDoc = { ...serverDoc, ...body.document, revision: version ? '2' : '0' };
      currentTodo = { ...currentTodo, name: 'Fresh inline name' };
      return Response.json({ document: serverDoc, mutationId: body.mutationId, outcome: 1, effects: {} });
    }
    if (String(url).endsWith('ListTodos')) { assert.equal(saved, true); return Response.json({ todos: [currentTodo] }); }
    if (String(url).endsWith('UpdateTodo')) {
      requests.push(String(init?.body));
      assert.equal(saved, true);
      if (version) {
        assert.deepEqual(body.patch, { status: 'TODO_STATUS_DONE' });
        assert.equal(body.name, undefined);
        assert.equal((await retainedWorkspace()).command?.body, String(init?.body));
      } else {
        assert.equal(body.name, 'Fresh inline name');
        assert.equal(body.desc, 'Keep description');
        assert.equal(body.goalId, '4');
        assert.equal(body.bucket, 'done');
      }
      currentTodo = { ...currentTodo, name: 'Newer live name', status: 'done' };
      return Response.json({ todo: { ...currentTodo, name: 'Historical receipt name' }, mutationId: body.mutationId, effects: {} });
    }
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().sessionStatus === 'ready');
    await act(async () => app.current().dispatch({ type: 'updatePageTitle', title: 'Edit before TODO change' }));
    let result: BackendTodo | undefined;
    let error: unknown;
    await act(async () => { void app.current().runTodoUpdate(7, { status: 'done' }).then((value) => { result = value; }).catch((value) => { error = value; }); });
    await until(() => Boolean(result || error));
    assert.equal(error, undefined);
    assert.equal(result?.name, 'Newer live name');
    assert.equal(requests.length, version ? 2 : 1);
    if (version) assert.equal(requests[0], requests[1]);
    assert.equal((await retainedWorkspace()).command, undefined);
  } finally { await app.unmount(); }
});

test('unlinked TODO patch replays identical user-scoped bytes after restart', async () => {
  await environment();
  const command = prepareTodoUpdate(draftScope(backend, 1, 1), { id: 7, userId: 1, workspaceId: 0 } as BackendTodo, { desc: '', goalId: 0 });
  const db = await openDraftDatabase();
  const storage = new DraftStorage(db, draftScope(backend, 1, 1));
  const cached = await storage.load();
  await storage.save({ ...cached, command }); db.close();
  let sends = 0;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('ListDocuments')) return Response.json({ documents: [{ ...doc, revision: '1' }], persistenceProtocolVersion: 1 });
    if (String(url).endsWith('UpdateTodo')) {
      sends++;
      assert.equal(String(init?.body), command.body);
      assert.deepEqual(JSON.parse(command.body).patch, { desc: '', goalId: '0' });
      assert.equal(JSON.parse(command.body).workspaceId, '0');
      return Response.json({ todo: { id: '7' }, mutationId: command.mutationId, effects: {} });
    }
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().sessionStatus === 'ready');
    assert.equal(sends, 1);
    assert.equal((await retainedWorkspace()).command, undefined);
  } finally { await app.unmount(); }
});

for (const lostAck of [false, true]) test(`pull retains server date and exact bytes through refresh (lost acknowledgment: ${lostAck})`, async () => {
  await environment();
  let contextReads = 0;
  const requests: string[] = [];
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('GetTodoCommandContext')) { contextReads++; return Response.json({ journalDate: '2040-01-02' }); }
    if (String(url).endsWith('PullOnDeckTodosToToday')) {
      const body = String(init?.body);
      requests.push(body);
      assert.equal((await retainedWorkspace()).command?.body, body);
      const request = JSON.parse(body);
      assert.equal(request.journalDate, '2040-01-02');
      if (lostAck && requests.length === 1) throw new TypeError('Response lost after commit');
      return Response.json({ mutationId: request.mutationId, documentId: '1', pulledCount: 2, effects: {} });
    }
    if (String(url).endsWith('ListDocuments')) return Response.json({ documents: [{ ...doc, revision: '1' }], persistenceProtocolVersion: 1 });
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().sessionStatus === 'ready');
    let result: { pulledCount: number } | undefined;
    let error: unknown;
    await act(async () => { void app.current().runTodoCommand('pull').then((value) => { result = value; }).catch((value) => { error = value; }); });
    await until(() => Boolean(result || error));
    if (lostAck) assert.match(String(error), /Response lost/);
    else { assert.equal(error, undefined); assert.equal(result?.pulledCount, 2); }
    assert.equal(contextReads, 1);
    assert.equal(requests.length, 2); // Initial send, then exact receipt replay during cache recovery.
    assert.equal(requests[0], requests[1]);
    assert.equal((await retainedWorkspace()).command, undefined);
  } finally { await app.unmount(); }
});

test('command cache-refresh failure survives restart and never recreates a deleted journal from a receipt', async () => {
  await environment();
  const envelope = prepareTodoCommand(draftScope(backend, 1, 1), 'pull', '2001-01-01');
  const db = await openDraftDatabase();
  const storage = new DraftStorage(db, draftScope(backend, 1, 1));
  const cached = await storage.load();
  await storage.save({ ...cached, command: envelope }); db.close();
  let reads = 0;
  let failRefresh = true;
  let sends = 0;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('PullOnDeckTodosToToday')) {
      sends++; assert.equal(String(init?.body), envelope.body);
      return Response.json({ mutationId: envelope.mutationId, documentId: '99', pulledCount: 1, effects: {} });
    }
    if (String(url).endsWith('ListDocuments')) {
      if (++reads === 2 && failRefresh) throw new Error('Live refresh unavailable');
      return Response.json({ documents: [{ ...doc, revision: '1' }], persistenceProtocolVersion: 1 });
    }
    return respond(String(url));
  }) as typeof fetch;
  let app = await mount();
  try {
    await until(() => app.current().sessionStatus === 'unavailable');
    assert.equal((await retainedWorkspace()).command?.body, envelope.body);
    await app.unmount();
    failRefresh = false;
    app = await mount();
    await until(() => app.current().sessionStatus === 'ready');
    assert.equal(sends, 2);
    assert.equal((await retainedWorkspace()).command, undefined);
    assert.equal(app.current().stateRef.current.pages.some((entry) => entry.backendId === 99), false);
  } finally { await app.unmount(); }
});

test('repository command preserves edits made while its response is in flight', async () => {
  await environment();
  let release!: () => void;
  let started = false;
  let committed = false;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('MoveDocumentTodosToRepository')) {
      if (!started) { started = true; await new Promise<void>((resolve) => { release = resolve; }); }
      committed = true;
      return Response.json({ mutationId: JSON.parse(String(init?.body)).mutationId, movedCount: 1, effects: {} });
    }
    if (String(url).endsWith('ListDocuments')) return Response.json({ documents: [{ ...doc, revision: committed ? '2' : '1', title: committed ? 'Server changed' : doc.title }], persistenceProtocolVersion: 1 });
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().sessionStatus === 'ready');
    let done = false;
    let error: unknown;
    await act(async () => { void app.current().runTodoCommand('repository', 1).catch((value) => { error = value; }).finally(() => { done = true; }); });
    await until(() => started);
    await act(async () => app.current().dispatch({ type: 'updatePageTitle', title: 'New local edit' }));
    await act(async () => { release(); });
    await until(() => done);
    assert.equal(error, undefined);
    const cached = await retainedWorkspace();
    assert.equal(cached.command, undefined);
    assert.equal(cached.records[0].page.title, 'New local edit');
    assert.ok(cached.records[0].conflict);
  } finally { await app.unmount(); }
});

for (const failure of ['auth', 'capability'] as const) test(`retained command is not replayed across failed ${failure} validation`, async () => {
  await environment();
  const db = await openDraftDatabase();
  const storage = new DraftStorage(db, draftScope(backend, 1, 1));
  await storage.load();
  const command = prepareTodoCommand(draftScope(backend, 1, 1), 'repository', 1);
  await storage.save({ records: [], directories: [], command }); db.close();
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith('ListWorkspaces') && failure === 'auth') return Response.json({ code: 'unauthenticated' }, { status: 401 });
    return respond(String(url)); // capability zero; any command send is unexpected.
  }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => ['unavailable', 'reauth-required'].includes(app.current().sessionStatus));
    assert.equal((await retainedWorkspace()).command?.body, command.body);
  } finally { await app.unmount(); }
});

test('command storage failure prevents network send', async () => {
  await environment();
  let sends = 0;
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith('MoveDocumentTodosToRepository')) sends++;
    if (String(url).endsWith('ListDocuments')) return Response.json({ documents: [{ ...doc, revision: '1' }], persistenceProtocolVersion: 1 });
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount();
  const save = DraftStorage.prototype.save;
  try {
    await until(() => app.current().sessionStatus === 'ready');
    DraftStorage.prototype.save = function(workspace) {
      if (workspace.command) return Promise.reject(new Error('Disk unavailable'));
      return save.call(this, workspace);
    };
    await act(async () => { await assert.rejects(app.current().runTodoCommand('repository', 1)); });
    assert.equal(app.current().sessionStatus, 'unavailable');
    assert.equal(sends, 0);
  } finally { DraftStorage.prototype.save = save; await app.unmount(); }
});

test('a definitively missing command target releases the slot after live refresh', async () => {
  await environment();
  const db = await openDraftDatabase();
  const storage = new DraftStorage(db, draftScope(backend, 1, 1));
  await storage.load();
  await storage.save({ records: [], directories: [], command: prepareTodoCommand(draftScope(backend, 1, 1), 'repository', 99) });
  db.close();
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith('MoveDocumentTodosToRepository')) return Response.json({ code: 'not_found', message: 'Document no longer exists' }, { status: 404 });
    if (String(url).endsWith('ListDocuments')) return Response.json({ documents: [{ ...doc, revision: '1' }], persistenceProtocolVersion: 1 });
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().sessionStatus === 'ready');
    assert.equal((await retainedWorkspace()).command, undefined);
    assert.match(app.current().syncMessage, /Command rejected/);
  } finally { await app.unmount(); }
});

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
async function mount(loadWorkspace = snapshotWorkspace) {
  let session: Session;
  let search: ReturnType<typeof useSearchView>;
  let directory: ReturnType<typeof useDirectoryBrowser>;
  let renderer: ReactTestRenderer;
  function Harness() {
    const [state, dispatch] = useOutlineState();
    session = useSessionSync({ state, dispatch, loadWorkspace });
    search = useSearchView({ ...state, pages: session.navigationPages }, session);
    directory = useDirectoryBrowser({ state, dispatch: session.dispatch, stateRef: session.stateRef,
      availablePages: session.navigationPages, ensurePageLoaded: session.ensurePageLoaded,
      backendUrl: session.backendUrl, authToken: session.authToken, workspaceId: session.workspaceId,
      syncEnabled: session.syncEnabled,
      runDocumentCommand: session.runDocumentCommand, directories: session.directories,
      setSyncMessage: session.setSyncMessage });
    return null;
  }
  await act(async () => { renderer = create(createElement(Harness)); });
  return { current: () => session!, directory: () => directory!, search: () => search!, unmount: async () => { await act(async () => renderer!.unmount()); } };
}

test('directory rename drains drafts, sends only intent, and preserves live refresh metadata', async () => {
  await environment();
  let remote = { ...doc };
  let directory = { id: 4, workspaceId: 1, parentId: 0, name: 'Original', position: 0 };
  const events: string[] = [];
  globalThis.fetch = (async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (String(url).endsWith('ListDocuments')) return Response.json({ documents: [remote], directories: [directory] });
    if (String(url).endsWith('SaveDocument')) {
      events.push('save'); remote = { ...remote, ...body.document };
      return Response.json({ document: remote });
    }
    if (String(url).endsWith('UpdateDirectory')) {
      events.push('rename');
      assert.deepEqual(body, { id: '4', patch: { name: 'Renamed' } });
      assert.equal(events[0], 'save');
      directory = { ...directory, name: 'Newer live name' };
      return Response.json({ directory: { ...directory, name: 'Renamed' } });
    }
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().syncEnabled);
    await act(async () => app.current().dispatch({ type: 'updatePageTitle', title: 'Dirty before rename' }));
    await act(async () => { await app.directory().renameDirectoryEntry(); });
    await act(async () => app.directory().setDirectoryPromptValue('Renamed'));
    let done = false;
    await act(async () => { void app.directory().submitDirectoryPrompt().then(() => { done = true; }); });
    await until(() => done);
    assert.deepEqual(events, ['save', 'rename']);
    assert.equal(app.current().directories[0].name, 'Newer live name');
    assert.equal((await retainedWorkspace()).directories[0].name, 'Newer live name');
  } finally { await app.unmount(); }
});

test('directory deletion is blocked by a failed draft save', async () => {
  await environment();
  let deletes = 0;
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith('ListDocuments')) return Response.json({ documents: [doc], directories: [{ id: 4, workspaceId: 1, name: 'Folder' }] });
    if (String(url).endsWith('SaveDocument')) return Response.json({ code: 'internal', message: 'save failed' }, { status: 500 });
    if (String(url).endsWith('DeleteDirectory')) { deletes++; return Response.json({}); }
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().syncEnabled);
    await act(async () => app.current().dispatch({ type: 'updatePageTitle', title: 'Unsent edit' }));
    let done = false;
    await act(async () => { void app.directory().deleteSelectedDirectory().then(() => { done = true; }); });
    await until(() => done);
    assert.equal(deletes, 0);
    assert.equal(app.current().directories.length, 1);
    assert.match(app.current().syncMessage, /pending saves|conflicts/);
  } finally { await app.unmount(); }
});

test('directory request cannot publish its result after logout', async () => {
  await environment();
  let finish: ((value: Response) => void) | undefined;
  let creates = 0;
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith('CreateDirectory')) {
      creates++;
      return new Promise<Response>((resolve) => { finish = resolve; });
    }
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().syncEnabled);
    await act(async () => app.directory().openCreateDirectoryPrompt());
    await act(async () => app.directory().setDirectoryPromptValue('Old scope'));
    let done = false;
    await act(async () => {
      void app.directory().submitDirectoryPrompt().then(() => { done = true; });
      void app.directory().submitDirectoryPrompt();
    });
    await until(() => Boolean(finish));
    await act(async () => app.current().handleLogout());
    await until(() => !app.current().authToken && app.current().syncMessage === '');
    const message = app.current().syncMessage;
    await act(async () => finish!(Response.json({ directory: { id: 8, workspaceId: 1, name: 'Old scope' } })));
    await until(() => done);
    assert.equal(creates, 1);
    assert.equal(app.current().syncMessage, message);
    assert.equal(app.directory().directoryPrompt, null);
    assert.equal(app.directory().directoryClipboard, null);
  } finally { await app.unmount(); }
});

test('directory copy stops at the first unsaved note and retains that local copy', async () => {
  await environment(false);
  const directories = [{ id: 4, workspaceId: 1, parentId: 0, name: 'Source' }];
  let creates = 0;
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith('ListDocuments')) return Response.json({ documents: [
      { ...doc, directoryId: 4, title: 'First' },
      { ...doc, id: 2, clientKey: 'document-2', directoryId: 4, title: 'Second', blocks: [] },
    ], directories });
    if (String(url).endsWith('CreateDirectory')) {
      creates++;
      const directory = { id: 8, workspaceId: 1, parentId: 0, name: 'Copy' };
      directories.push(directory);
      return Response.json({ directory });
    }
    if (String(url).endsWith('SaveDocument')) return Response.json({ code: 'internal', message: 'save failed' }, { status: 500 });
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().syncEnabled);
    await act(async () => app.directory().copySelectedDirectoryToClipboard());
    let done = false;
    await act(async () => { void app.directory().pasteClipboardHere().then(() => { done = true; }); });
    await until(() => done);
    assert.equal(creates, 1);
    const copies = app.current().stateRef.current.pages.filter((entry) => entry.directoryId === 8);
    assert.equal(copies.length, 1, app.current().syncMessage);
    assert.equal(copies[0].backendId, undefined);
    assert.match(app.current().syncMessage, /pending saves|conflicts/);
    const retained = await retainedWorkspace();
    assert.equal(retained.records.filter((record) => record.page.directoryId === 8).length, 1);
  } finally { await app.unmount(); }
});

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

test('TODO status UI submits only status, not stale metadata or derived bucket', async () => {
  await environment();
  let payload: any;
  const updated = { id: 7, name: 'New inline name', desc: 'Keep description', status: 'todo', bucket: 'on_deck', priorityRank: 9, goalId: 4 };
  let todos!: ReturnType<typeof useTodos>;
  let renderer!: ReactTestRenderer;
  function Harness() {
    todos = useTodos({ backendUrl: backend, authToken: token, userId: 1,
      syncMessageSetter: (text) => { throw new Error(text); },
      runTodoUpdate: async (id, patch) => { assert.equal(id, 7); payload = patch; return { ...updated, ...patch } as BackendTodo; } });
    return null;
  }
  await act(async () => { renderer = create(createElement(Harness)); });
  try {
    await act(async () => todos.handleTodoStatusChange({ ...updated, name: 'Stale UI name', desc: 'Old description' } as BackendTodo, 'done'));
    assert.deepEqual(payload, { status: 'done' });
  } finally { await act(async () => renderer.unmount()); }
});

test('commands do not run when a best-effort save fails', async () => {
  await environment();
  globalThis.fetch = (async (url) => String(url).endsWith('SaveDocument')
    ? Response.json({ code: 'invalid_argument', message: 'Rejected edit' }, { status: 400 }) : respond(String(url))) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().sessionStatus === 'ready');
    await act(async () => app.current().dispatch({ type: 'updatePageTitle', title: 'Unsaved' }));
    let called = false;
    await act(async () => {
      await assert.rejects(app.current().runDocumentCommand(async () => { called = true; }), /pending saves/);
    });
    assert.equal(called, false);
    assert.equal(app.current().pagesRef.current[0].title, 'Unsaved');
  } finally { await app.unmount(); }
});

test('offline server-note deletion is not queued', async () => {
  await environment();
  globalThis.fetch = (async () => { throw new TypeError('Offline'); }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().sessionStatus === 'unavailable');
    await act(async () => {
      await assert.rejects(app.current().deleteNote(page.id), /Connect to the workspace/);
      const db = await openDraftDatabase();
      const cached = await new DraftStorage(db, draftScope(backend, 1, 1)).load();
      db.close();
      assert.equal(cached.records[0].envelope, undefined);
      assert.equal(cached.records[0].page.backendId, 1);
    });
  } finally { await app.unmount(); }
});

test('command barrier drains edits made during a save and blocks saves until refreshed', async () => {
  await environment();
  let remote = { ...doc, revision: '1' };
  let saves = 0;
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  let releaseCommand!: () => void;
  const commandGate = new Promise<void>((resolve) => { releaseCommand = resolve; });
  let started = false;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('ListDocuments')) return Response.json({ documents: [remote], persistenceProtocolVersion: 1 });
    if (String(url).endsWith('SaveDocument')) {
      const request = JSON.parse(String(init?.body));
      if (++saves === 1) await saveGate;
      remote = { ...remote, ...request.document, revision: String(BigInt(request.expectedRevision) + 1n) };
      return Response.json({ document: remote, mutationId: request.mutationId, outcome: 1 });
    }
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().sessionStatus === 'ready');
    await act(async () => app.current().dispatch({ type: 'updatePageTitle', title: 'First edit' }));
    let pending!: Promise<unknown>;
    let done = false;
    await act(async () => {
      pending = app.current().runDocumentCommand(async () => {
        assert.equal(remote.title, 'Newer edit');
        started = true;
        await commandGate;
        remote = { ...remote, title: 'Command result', revision: '4' };
      }).finally(() => { done = true; });
    });
    await until(() => saves === 1);
    await act(async () => app.current().dispatch({ type: 'updatePageTitle', title: 'Newer edit' }));
    releaseSave();
    await until(() => started);
    assert.equal(saves, 2);
    await act(async () => {
      app.current().dispatch({ type: 'updatePageTitle', title: 'Typed during command' });
      await app.current().flushDirtyPages();
      await assert.rejects(app.current().runDocumentCommand(async () => {}), /already running/);
    });
    assert.equal(saves, 2);
    releaseCommand();
    await until(() => done);
    await pending;
    assert.equal(app.current().pagesRef.current[0].title, 'Typed during command');
    assert.ok(app.current().conflicts.length);
    assert.equal(saves, 2);
  } finally { releaseSave(); releaseCommand(); await app.unmount(); }
});

test('online versioned deletion retains its request before transport and commits local removal', async () => {
  await environment();
  const remote = { ...doc, revision: '9007199254740993' };
  let deleted = false;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('ListDocuments')) return Response.json({ documents: deleted ? [] : [remote], persistenceProtocolVersion: 1 });
    if (String(url).endsWith('DeleteDocument')) {
      const db = await openDraftDatabase();
      const retained = await new DraftStorage(db, draftScope(backend, 1, 1)).load();
      db.close();
      const envelope = retained.records.find((record) => record.page.backendId === 1)?.envelope;
      assert.equal(envelope?.operation, 'delete');
      assert.equal(envelope?.body, init?.body);
      const request = JSON.parse(String(init?.body));
      assert.equal(request.expectedRevision, remote.revision);
      deleted = true;
      return Response.json({ mutationId: request.mutationId, effects: { deletedDocumentIds: ['1'] } });
    }
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().sessionStatus === 'ready');
    let pending!: Promise<void>;
    let done = false;
    await act(async () => { pending = app.current().deleteNote(page.id).finally(() => { done = true; }); });
    await until(() => done);
    await pending;
    assert.equal(deleted, true);
    assert.equal(app.current().pagesRef.current.some((entry) => entry.backendId === 1), false);
    const db = await openDraftDatabase();
    const cached = await new DraftStorage(db, draftScope(backend, 1, 1)).load();
    db.close();
    assert.equal(cached.records.some((entry) => entry.page.backendId === 1), false);
  } finally { await app.unmount(); }
});

test('edits arriving during the durable command barrier abort the command and remain saveable', async () => {
  await environment();
  globalThis.fetch = (async (url) => respond(String(url))) as typeof fetch;
  const app = await mount();
  const save = DraftStorage.prototype.save;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let retaining = false;
  let called = false;
  let done = false;
  let error: unknown;
  try {
    await until(() => app.current().sessionStatus === 'ready');
    DraftStorage.prototype.save = function (workspace) {
      const result = save.call(this, workspace);
      if (!retaining && workspace.records.some((record) => record.needsRefresh)) {
        retaining = true;
        return result.then(() => gate);
      }
      return result;
    };
    await act(async () => {
      void app.current().runDocumentCommand(async () => { called = true; })
        .catch((value) => { error = value; }).finally(() => { done = true; });
    });
    await until(() => retaining);
    await act(async () => app.current().dispatch({ type: 'updatePageTitle', title: 'Edit during retention' }));
    release();
    await until(() => done);
    assert.equal(called, false);
    assert.match(String(error), /New edits arrived/);
    assert.equal(app.current().pagesRef.current[0].title, 'Edit during retention');
    const db = await openDraftDatabase();
    const cached = await new DraftStorage(db, draftScope(backend, 1, 1)).load();
    db.close();
    assert.equal(cached.records[0].needsRefresh, false);
  } finally { release(); DraftStorage.prototype.save = save; await app.unmount(); }
});

test('startup replays deletion even when the server document is already absent', async () => {
  await environment(false);
  const base = documentToOutlinePage({ ...doc, revision: '3' });
  const record = { page: base, baseline: base, savedHash: pageHash(base) };
  const envelope = prepareDelete(record, draftScope(backend, 1, 1));
  const db = await openDraftDatabase();
  const storage = new DraftStorage(db, draftScope(backend, 1, 1));
  await storage.load();
  await storage.save({ records: [{ ...record, envelope }], directories: [] });
  db.close();
  let replayed = false;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('ListDocuments')) return Response.json({ documents: [], persistenceProtocolVersion: 1 });
    if (String(url).endsWith('DeleteDocument')) {
      assert.equal(init?.body, envelope.body);
      replayed = true;
      return Response.json({ mutationId: envelope.mutationId, effects: { deletedDocumentIds: ['1'] } });
    }
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => replayed && !app.current().isSyncing);
    assert.equal(app.current().pagesRef.current.some((entry) => entry.backendId === 1), false);
  } finally { await app.unmount(); }
});

test('advertised v1 adopts legacy baselines and commits exact versioned requests', async () => {
  await environment();
  const versioned = { ...doc, revision: '9007199254740993', clientKey: 'persisted-doc', blocks: [{ ...doc.blocks[0], clientKey: 'persisted-block' }] };
  let request: any;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('ListDocuments')) return Response.json({ documents: [versioned], directories: [], persistenceProtocolVersion: 1 });
    if (String(url).endsWith('SaveDocument')) {
      request = JSON.parse(String(init?.body));
      const db = await openDraftDatabase();
      const cached = await new DraftStorage(db, draftScope(backend, 1, 1)).load();
      db.close();
      assert.equal(cached.records[0].envelope?.body, init?.body);
      return Response.json({ document: { ...versioned, ...request.document, revision: '9007199254740994' }, mutationId: request.mutationId, outcome: 'DOCUMENT_SAVE_OUTCOME_APPLIED' });
    }
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().sessionStatus === 'ready');
    await act(async () => app.current().dispatch({ type: 'updatePageTitle', title: 'Versioned edit' }));
    await act(async () => app.current().flushDirtyPages());
    assert.equal(request.protocolVersion, 1);
    assert.equal(request.expectedRevision, '9007199254740993');
    assert.equal(request.document.clientKey, 'persisted-doc');
    assert.equal(request.document.blocks[0].clientKey, 'persisted-block');
    assert.equal(app.current().pagesRef.current[0].revision, '9007199254740994');
    assert.equal(app.current().activePageIsDirty, false);
  } finally { await app.unmount(); }
});

test('startup replays an interrupted v1 save while retaining newer edits', async () => {
  await environment(false);
  const versioned = { ...doc, revision: '1' };
  const base = documentToOutlinePage(versioned);
  const submitted = { ...base, title: 'Submitted title' };
  const envelope = prepareSave({ page: submitted, baseline: base, generation: 2 }, draftScope(backend, 1, 1));
  const db = await openDraftDatabase();
  const storage = new DraftStorage(db, draftScope(backend, 1, 1));
  await storage.load();
  await storage.save({ records: [{ page: { ...submitted, title: 'Newer local title' }, baseline: base,
    savedHash: pageHash(base), generation: 3, envelope }], directories: [] });
  db.close();
  let saves = 0;
  const committed = { ...versioned, title: 'Submitted title', revision: '2' };
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('ListDocuments')) return Response.json({ documents: [committed], directories: [], persistenceProtocolVersion: 1 });
    if (String(url).endsWith('GetDocument')) return Response.json({ document: committed });
    if (String(url).endsWith('SaveDocument')) {
      saves++;
      assert.equal(init?.body, envelope.body);
      return Response.json({ document: committed, mutationId: envelope.mutationId, outcome: 'DOCUMENT_SAVE_OUTCOME_APPLIED' });
    }
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().sessionStatus === 'ready' && !app.current().isSyncing);
    assert.equal(saves, 1);
    assert.equal(app.current().pagesRef.current[0].title, 'Newer local title');
    assert.equal(app.current().activePageIsDirty, true);
    assert.equal(app.current().conflicts.length, 0);
  } finally { await app.unmount(); }
});

test('a legacy server cannot downgrade a retained versioned request', async () => {
  await environment(false);
  const base = { ...page, revision: '1' };
  const envelope = prepareSave({ page: base, baseline: base }, draftScope(backend, 1, 1));
  const db = await openDraftDatabase();
  const storage = new DraftStorage(db, draftScope(backend, 1, 1));
  await storage.load();
  await storage.save({ records: [{ page: base, baseline: base, envelope }], directories: [] });
  db.close();
  let saves = 0;
  globalThis.fetch = (async (url) => { if (String(url).endsWith('SaveDocument')) saves++; return respond(String(url)); }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().sessionStatus === 'unavailable');
    await act(async () => app.current().flushDirtyPages());
    assert.equal(saves, 0);
    assert.match(app.current().syncMessage, /downgrade/);
    assert.equal(app.current().pagesRef.current[0].title, base.title);
  } finally { await app.unmount(); }
});

test('manual resolution uses the reviewed revision and rejects a second concurrent change', async () => {
  await environment();
  let live = { ...doc, revision: '1' };
  let saves = 0;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('ListDocuments')) return Response.json({ documents: [live], directories: [], persistenceProtocolVersion: 1 });
    if (String(url).endsWith('GetDocument')) return Response.json({ document: live });
    if (String(url).endsWith('SaveDocument')) {
      saves++;
      const request = JSON.parse(String(init?.body));
      if (saves === 1) {
        live = { ...live, revision: '2', title: 'Other device' };
        return Response.json({ code: 'aborted', message: 'Revision conflict', details: [{ type: 'secretary.v1.PersistenceError', value: 'CAI=' }] }, { status: 409 });
      }
      assert.equal(request.expectedRevision, '3');
      live = { ...live, ...request.document, revision: '4' };
      return Response.json({ document: live, mutationId: request.mutationId, outcome: 'DOCUMENT_SAVE_OUTCOME_APPLIED' });
    }
    return respond(String(url));
  }) as typeof fetch;
  const app = await mount();
  try {
    await until(() => app.current().sessionStatus === 'ready');
    await act(async () => app.current().dispatch({ type: 'updatePageTitle', title: 'My resolved content' }));
    await act(async () => app.current().flushDirtyPages());
    const reviewed = app.current().conflicts[0].serverCopy!;
    assert.equal(reviewed.revision, '2');
    live = { ...live, revision: '3', title: 'Changed again' };
    await act(async () => { await assert.rejects(app.current().resolveConflict(page.id, 'save', reviewed), /changed again/); });
    assert.equal(saves, 1);
    assert.equal(app.current().pagesRef.current[0].title, 'My resolved content');
    const refreshed = app.current().conflicts[0].serverCopy!;
    assert.equal(refreshed.revision, '3');
    await act(async () => app.current().resolveConflict(page.id, 'save', refreshed));
    assert.equal(saves, 2);
    assert.equal(app.current().conflicts.length, 0);
    assert.equal(app.current().activePageIsDirty, false);
  } finally { await app.unmount(); }
});

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
      assert.equal(JSON.parse(String(init?.body)).id, '225');
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
