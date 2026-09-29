import assert from 'node:assert/strict';
import { test } from 'node:test';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { DraftStorage, draftScope, openDraftDatabase } from '../src/lib/draftStorage';
import { pageHash } from '../src/app/pagePersistence';
import { draftConflicts, mergeWorkspace, recoveryCopy, trackDrafts } from '../src/features/session/draftReconciliation';
import type { OutlinePage } from '../src/features/outline/types';
import { prepareSave } from '../src/features/session/documentSaveController';
import type { DocumentMetadata } from '../src/lib/backend';

const page: OutlinePage = { id: 'document-1', backendId: 1, workspaceId: 1, kind: 'note', title: 'Draft', date: '',
  nodes: [{ id: 'block-1', backendId: 1, text: 'Original', parentId: null, todoId: 3, todoStatus: 'todo' }] };
const scope = draftScope('https://example.com/', 1, 1);
const index: DocumentMetadata[] = [{ id: 1, clientKey: 'document-1', workspaceId: 1, directoryId: 0,
  kind: 'note', title: 'Indexed title', journalDate: '', revision: '1', createdAt: '', updatedAt: '' }];

test('committed local drafts and uncertain-save markers survive reopening', async () => {
  const factory = new IDBFactory();
  const db = await openDraftDatabase(factory);
  const storage = new DraftStorage(db, scope);
  await storage.load();
  await storage.save({ records: [{ page, baseline: page, pending: true }], directories: [] });
  db.close();
  const reopened = await openDraftDatabase(factory);
  const loaded = await new DraftStorage(reopened, scope).load();
  assert.equal(loaded.records[0].page.nodes[0].text, 'Original');
  assert.equal(loaded.records[0].pending, true);
  reopened.close();
});

test('backend, account and workspace records are isolated', async () => {
  const db = await openDraftDatabase(new IDBFactory());
  const writer = new DraftStorage(db, scope);
  await writer.load();
  await writer.save({ records: [{ page }], directories: [], index });
  for (const other of [draftScope('https://other.com', 1, 1), draftScope('https://example.com', 2, 1), draftScope('https://example.com', 1, 2)]) {
    assert.deepEqual((await new DraftStorage(db, other).load()).records, []);
    assert.deepEqual((await new DraftStorage(db, other).load()).index, []);
  }
  assert.deepEqual(draftScope('https://EXAMPLE.com:443/', 1, 1), scope);
  assert.notDeepEqual(draftScope('http://example.com', 1, 1), scope);
  assert.throws(() => draftScope('https://example.com?other', 1, 1));
  db.close();
});

test('queued writes retain the latest edit and capture inputs at enqueue time', async () => {
  const db = await openDraftDatabase(new IDBFactory());
  const storage = new DraftStorage(db, scope);
  await storage.load();
  const snapshot = { records: [{ page: structuredClone(page) }], directories: [] };
  const first = storage.save(snapshot);
  snapshot.records[0].page.nodes[0].text = 'Latest';
  const second = storage.save(snapshot);
  snapshot.records[0].page.nodes[0].text = 'Not submitted';
  await Promise.all([first, second]);
  assert.equal((await new DraftStorage(db, scope).load()).records[0].page.nodes[0].text, 'Latest');
  db.close();
});

test('immutable persistence writes only changed documents and retains queued edits', async () => {
  const db = await openDraftDatabase(new IDBFactory());
  const storage = new DraftStorage(db, scope);
  await storage.load();
  const records = Array.from({ length: 150 }, (_, i) => ({ page: { ...page, id: `document-${i + 1}`, backendId: i + 1 } }));
  const directories: [] = [];
  const original = IDBObjectStore.prototype.put;
  const puts: string[] = [];
  let indexWrites = 0;
  IDBObjectStore.prototype.put = function(value, key) {
    if (this.name === 'drafts') puts.push(value.page.id);
    if (this.name === 'indexes') indexWrites++;
    if (this.name === 'workspaces') assert.equal('index' in value, false);
    return original.call(this, value, key);
  };
  try {
    await storage.save({ records, directories, index }, true);
    assert.equal(indexWrites, 1);
    puts.length = 0;
    const edited = [{ page: { ...records[0].page, title: 'One changed document' } }, ...records.slice(1)];
    await storage.save({ records: edited, directories, index }, true);
    assert.deepEqual(puts, ['document-1']);
    puts.length = 0;
    await storage.save({ records: edited, directories, index }, true);
    assert.deepEqual(puts, []);
    assert.equal(indexWrites, 1);
    const changedIndex = [{ ...index[0], title: 'Updated index' }];
    await storage.save({ records: edited, directories, index: changedIndex }, true);
    assert.equal(indexWrites, 2);
    const loaded = await new DraftStorage(db, scope).load();
    assert.equal(loaded.records.find(record => record.page.id === 'document-1')?.page.title, 'One changed document');
    assert.equal(loaded.records.length, 150);
    assert.deepEqual(loaded.index, changedIndex);
  } finally { IDBObjectStore.prototype.put = original; db.close(); }
});

test('stale windows cannot overwrite drafts and retain their candidate separately', async () => {
  const db = await openDraftDatabase(new IDBFactory());
  const first = new DraftStorage(db, scope);
  const second = new DraftStorage(db, scope);
  await first.load(); await second.load();
  await first.save({ records: [{ page }], directories: [], index });
  const staleIndex = [{ ...index[0], title: 'Stale index' }];
  await assert.rejects(second.save({ records: [{ page: { ...page, title: 'Other window' } }], directories: [], index: staleIndex }), /Another window/);
  assert.equal((await new DraftStorage(db, scope).load()).records[0].page.title, 'Draft');
  assert.deepEqual((await new DraftStorage(db, scope).load()).index, index);
  const recovery = await new Promise<any[]>((resolve) => {
    const request = db.transaction('recovery').objectStore('recovery').getAll();
    request.onsuccess = () => resolve(request.result);
  });
  assert.equal(recovery[0].workspace.records[0].page.title, 'Other window');
  assert.deepEqual(recovery[0].workspace.index, staleIndex);
  db.close();
});

test('failed storage writes reject rather than acknowledge retention', async () => {
  const db = await openDraftDatabase(new IDBFactory());
  const storage = new DraftStorage(db, scope);
  await storage.load(); db.close();
  await assert.rejects(storage.save({ records: [{ page }], directories: [] }));
});

test('an aborted index update rolls back drafts and CAS and remains retryable', async () => {
  const db = await openDraftDatabase(new IDBFactory());
  const storage = new DraftStorage(db, scope);
  await storage.load();
  await storage.save({ records: [{ page }], directories: [], index }, true);
  const update = { records: [{ page: { ...page, title: 'New draft' } }], directories: [],
    index: [{ ...index[0], title: 'New index' }] };
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(value, key) {
    const request = original.call(this, value, key);
    if (this.name === 'workspaces') this.transaction.abort();
    return request;
  };
  try { await assert.rejects(storage.save(update, true), /abort|storage failed/i); }
  finally { IDBObjectStore.prototype.put = original; }
  try {
    const unchanged = await new DraftStorage(db, scope).load();
    assert.equal(unchanged.records[0].page.title, page.title);
    assert.deepEqual(unchanged.index, index);
    await storage.save(update, true);
    const retried = await new DraftStorage(db, scope).load();
    assert.equal(retried.records[0].page.title, 'New draft');
    assert.deepEqual(retried.index, update.index);
    await storage.save({ ...update, index: [] }, true);
    assert.deepEqual((await new DraftStorage(db, scope).load()).index, []);
  } finally { db.close(); }
});

test('refresh preserves dirty drafts and detects changed or deleted server copies', () => {
  const local = { ...page, title: 'Local edit' };
  const draft = { page: local, baseline: page, savedHash: pageHash(page) };
  assert.equal(mergeWorkspace([draft], [page])[0].conflict, undefined);
  const changed = mergeWorkspace([draft], [{ ...page, title: 'Remote edit' }])[0];
  assert.equal(changed.page.title, 'Local edit');
  assert.match(changed.conflict!, /server copy changed/);
  assert.match(mergeWorkspace([draft], [])[0].conflict!, /deleted/);
  assert.deepEqual(mergeWorkspace([{ page, savedHash: pageHash(page) }], []), []);
});

test('restart never retries uncertain creates and never overwrites an existing journal', () => {
  const local = { ...page, backendId: undefined, kind: 'journal' as const, date: '2026-09-23' };
  assert.match(mergeWorkspace([{ page: local, pending: true }], [])[0].conflict!, /may have committed/);
  assert.match(mergeWorkspace([{ page: local }], [{ ...local, id: 'remote', backendId: 2 }])[0].conflict!, /journal already exists/);
});

test('recovery copies have fresh outline identities and independent TODOs', () => {
  const copy = recoveryCopy({ ...page, kind: 'journal' });
  assert.equal(copy.kind, 'note');
  assert.equal(copy.backendId, undefined);
  assert.notEqual(copy.id, page.id);
  assert.notEqual(copy.nodes[0].id, page.nodes[0].id);
  assert.equal(copy.nodes[0].todoId, undefined);
  assert.equal(copy.nodes[0].todoStatus, 'todo');
});

const blankJournal: OutlinePage = {
  id: 'local-journal', kind: 'journal', title: '2026-09-23', date: '2026-09-23',
  nodes: [{ id: 'empty-1', parentId: null, text: '' }, { id: 'empty-2', parentId: null, text: '' }],
};
const serverJournal: OutlinePage = { ...page, id: 'document-225', backendId: 225, kind: 'journal',
  title: '2026-09-23', date: '2026-09-23', nodes: [{ ...page.nodes[0], text: 'The long journal is still on the server.' }] };

test('an untouched generated placeholder adopts a populated journal without a dirty save', () => {
  const placeholders = trackDrafts([], [blankJournal], true);
  const records = mergeWorkspace(placeholders, [serverJournal]);
  assert.equal(records.length, 1);
  assert.equal(records[0].page.backendId, 225);
  assert.equal(records[0].page.nodes[0].text, serverJournal.nodes[0].text);
  assert.equal(records[0].savedHash, pageHash(records[0].page));
  assert.equal(records[0].conflict, undefined);
});

test('ambiguous legacy blank drafts retain the populated server snapshot for review', () => {
  const records = mergeWorkspace([{ page: blankJournal, conflict: 'Previously detected conflict' }], [serverJournal]);
  assert.equal(records[0].page, blankJournal);
  assert.equal(records[0].serverCopy, serverJournal);
  assert.equal(draftConflicts(records, false).length, 1);
});

test('editing then clearing a new journal permanently removes placeholder status', () => {
  let records = trackDrafts([], [blankJournal], true);
  records = trackDrafts(records, [{ ...blankJournal, nodes: [{ ...blankJournal.nodes[0], text: 'Intentional edit' }] }]);
  records = trackDrafts(records, [blankJournal]);
  assert.equal(records[0].placeholderHash, undefined);
  const merged = mergeWorkspace(records, [serverJournal]);
  assert.equal(merged[0].page, blankJournal);
  assert.equal(merged[0].serverCopy, serverJournal);
  assert.ok(merged[0].conflict);
});

test('saved baselines and uncertain saves prevent automatic blank-journal adoption', () => {
  const [placeholder] = trackDrafts([], [blankJournal], true);
  for (const record of [
    { ...placeholder, baseline: serverJournal },
    { ...placeholder, pending: true },
    { page: { ...serverJournal, nodes: [] }, baseline: serverJournal, savedHash: pageHash(serverJournal) },
  ]) {
    const merged = mergeWorkspace([record], [{ ...serverJournal, title: 'Server changed' }]);
    assert.equal(merged[0].page, record.page);
    assert.ok(merged[0].conflict);
    assert.ok(merged[0].serverCopy);
  }
});

test('both conflict versions survive IndexedDB restart without a network refresh', async () => {
  const db = await openDraftDatabase(new IDBFactory());
  const storage = new DraftStorage(db, scope);
  await storage.load();
  await storage.save({ records: mergeWorkspace([{ page: blankJournal }], [serverJournal]), directories: [] });
  const restored = await new DraftStorage(db, scope).load();
  const conflicts = draftConflicts(restored.records, false);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].page.nodes[0].text, '');
  assert.equal(conflicts[0].serverCopy?.nodes[0].text, serverJournal.nodes[0].text);
  db.close();
});

for (const version of [1, 2, 3, 4, 5]) test(`v${version} local storage upgrades without losing drafts and excludes old writers`, async () => {
  const factory = new IDBFactory();
  const old = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('secretary-drafts', version);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('workspaces'); request.result.createObjectStore('drafts');
      request.result.createObjectStore('recovery', { autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const tx = old.transaction(['workspaces', 'drafts'], 'readwrite');
  tx.objectStore('workspaces').put({ schemaVersion: version, revision: 1, directories: [], ...(version === 5 ? { index } : {}) }, scope);
  tx.objectStore('drafts').put({ page, pending: true }, [...scope, page.id]);
  await new Promise<void>((resolve) => { tx.oncomplete = () => resolve(); });
  old.close();
  const upgraded = await openDraftDatabase(factory);
  const storage = new DraftStorage(upgraded, scope);
  const restored = await storage.load();
  assert.equal(restored.records[0].pending, true);
  assert.deepEqual(restored.index, version === 5 ? index : []);
  await storage.save(restored, true);
  const migrated = await new DraftStorage(upgraded, scope).load();
  assert.deepEqual(migrated.index, restored.index);
  assert.equal(migrated.records[0].pending, true);
  upgraded.close();
  await assert.rejects(new Promise((resolve, reject) => {
    const request = factory.open('secretary-drafts', version);
    request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
  }), /version/i);
});

test('exact serialized request and newer draft survive a real IndexedDB reopen', async () => {
  const factory = new IDBFactory();
  const db = await openDraftDatabase(factory);
  const storage = new DraftStorage(db, scope);
  await storage.load();
  const draft = { ...blankJournal, workspaceId: 1 };
  const envelope = prepareSave({ page: draft, generation: 2 }, scope);
  await storage.save({ records: [{ page: { ...draft, title: 'Newer title' }, generation: 3, envelope }], directories: [] });
  db.close();
  const reopened = await openDraftDatabase(factory);
  const [record] = (await new DraftStorage(reopened, scope).load()).records;
  assert.equal(record.envelope?.body, envelope.body);
  assert.equal(record.envelope?.mutationId, envelope.mutationId);
  assert.equal(record.envelope?.generation, 2);
  assert.equal(record.generation, 3);
  assert.equal(record.page.title, 'Newer title');
  reopened.close();
});
