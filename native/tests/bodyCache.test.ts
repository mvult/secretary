import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundCleanBodies } from '../src/features/session/bodyCache';
import type { DraftRecord } from '../src/lib/draftStorage';
import { pageHash } from '../src/app/pagePersistence';
import { reduceOutlineState } from '../src/features/outline/state';
import type { OutlineState } from '../src/features/outline/types';
import { DocumentQueries } from '../src/features/session/documentQueries';

function clean(id: number): DraftRecord {
  const page = { id: `document-${id}`, backendId: id, clientKey: `document-${id}`, revision: '1', workspaceId: 1,
    kind: 'note' as const, date: '', title: '', nodes: [] };
  return { page, baseline: page, savedHash: pageHash(page), lastAccessedAt: id };
}

test('LRU bounds only clean closed bodies and protects every recovery state', () => {
  const dirty = clean(1); dirty.page = { ...dirty.page, title: 'Unsaved' };
  const protectedRecords = [dirty, { ...clean(2), pending: true }, { ...clean(3), conflict: 'changed' },
    { ...clean(4), needsRefresh: true }, { ...clean(5), retry: { attempts: 1, nextAt: 0, message: 'lost' } },
    { ...clean(6), baseline: undefined }];
  const records = [...protectedRecords, ...[7, 8, 9, 10].map(clean)];
  const result = boundCleanBodies(records, new Set(['document-7']), 2);
  assert.deepEqual([...result.evicted], ['document-8']);
  assert.ok(protectedRecords.every(record => result.records.includes(record)));
  // Visiting an older body changes which closed document is discarded.
  records[7].lastAccessedAt = 100;
  assert.deepEqual([...boundCleanBodies(records, new Set(['document-7']), 2).evicted], ['document-9']);
});

test('eviction removes historical body copies without changing the active edit', () => {
  const state: OutlineState = { pages: [clean(1).page, clean(2).page], activePageId: 'document-1', activeView: 'note',
    focusedId: '', normalCursor: 0, anchorId: null, editingId: null, draftText: '', editCursor: 'end', mode: 'normal', yankBuffer: null, documentHistory: {} };
  state.documentHistory = { 'document-1': [{ title: 'Previous', nodes: [], focusedId: '', normalCursor: 0 }],
    'document-2': [{ title: 'Other', nodes: [], focusedId: '', normalCursor: 0 }] };
  const evicted = reduceOutlineState(state, { type: 'evictPages', ids: new Set(['document-2']) });
  assert.equal(evicted.pages[0], state.pages[0]);
  assert.equal(Object.keys(evicted.documentHistory!).length, 1);
  const undone = reduceOutlineState(evicted, { type: 'undo' });
  assert.equal(undone.pages.length, 1);
  assert.equal(undone.pages[0].title, 'Previous');
});

test('body queries deduplicate concurrent reads but always revalidate subsequent opens', async () => {
  const original = globalThis.fetch;
  const cache = new DocumentQueries();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    globalThis.fetch = (async () => {
      calls++;
      await gate;
      return Response.json({ document: { id: 1, workspaceId: 1, clientKey: 'document-1', revision: String(calls), kind: 'note', blocks: [] } });
    }) as typeof fetch;
    const first = cache.get(['https://example.com', '1', '1'], 'token', 1);
    const second = cache.get(['https://example.com', '1', '1'], 'token', 1);
    release();
    await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.equal((await cache.get(['https://example.com', '1', '1'], 'token', 1)).revision, '2');
    await cache.get(['https://example.com', '2', '1'], 'other-token', 1);
    assert.equal(calls, 3);
  } finally { release(); cache.clear(); globalThis.fetch = original; }
});
