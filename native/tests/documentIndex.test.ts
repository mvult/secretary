import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexPage, loadIndexedWorkspace, navigationPages, readDocumentIndex } from '../src/features/session/documentIndex';
import { outlinePageToDocument } from '../src/features/outline/remote';
import { trackDrafts } from '../src/features/session/draftReconciliation';
import type { DocumentMetadata } from '../src/lib/backend';

const entry = (id: number): DocumentMetadata => ({ id, workspaceId: 1, clientKey: `document-${id}`, revision: '1', kind: 'note',
  title: `Note ${id}`, journalDate: '', directoryId: 0, createdAt: '', updatedAt: '' });

test('index traverses later pages without requesting bodies and cannot become a draft', async () => {
  const original = globalThis.fetch;
  const cursors: string[] = [];
  try {
    globalThis.fetch = (async (url, init) => {
      assert.ok(String(url).endsWith('/ListDocumentIndex'));
      const before = JSON.parse(String(init?.body)).beforeId ?? '0';
      cursors.push(before);
      return Response.json({ entries: before === '0' ? [entry(3), entry(2)] : [entry(1)], nextBeforeId: before === '0' ? '2' : '0', persistenceProtocolVersion: 1 });
    }) as typeof fetch;
    const index = await readDocumentIndex('https://example.com', 'token', 1, () => true);
    assert.deepEqual(cursors, ['0', '2']);
    const pages = navigationPages(index.entries, []);
    assert.deepEqual(pages.map(page => page.backendId), [3, 2, 1]);
    assert.throws(() => trackDrafts([], [pages[2]]), /cannot become drafts/);
    assert.throws(() => outlinePageToDocument(pages[2], 1), /Load the document body/);
  } finally { globalThis.fetch = original; }
});

test('malformed cursor or scope changes cannot publish a partial index', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ entries: [entry(3)], nextBeforeId: '4', persistenceProtocolVersion: 1 })) as typeof fetch;
    await assert.rejects(readDocumentIndex('https://example.com', 'token', 1, () => true), /cursor/);
    await assert.rejects(readDocumentIndex('https://example.com', 'token', 1, () => false), /scope changed/);
  } finally { globalThis.fetch = original; }
});

test('cold loading fetches only a journal window; missing index rows are individually verified', async () => {
  const original = globalThis.fetch;
  const requests: number[] = [];
  const entries = Array.from({ length: 30 }, (_, i) => ({ ...entry(30-i), kind: 'journal' as const, journalDate: `2020-01-${String(30-i).padStart(2, '0')}` }));
  try {
    globalThis.fetch = (async (url, init) => {
      if (String(url).endsWith('ListDocumentIndex')) return Response.json({ entries, persistenceProtocolVersion: 1 });
      assert.ok(String(url).endsWith('GetDocument'));
      const id = Number(JSON.parse(String(init?.body)).id);
      requests.push(id);
      return Response.json({ document: { ...entry(id), blocks: [] } });
    }) as typeof fetch;
    const baseline = { ...indexPage(entry(100)), metadataOnly: undefined };
    const result = await loadIndexedWorkspace('https://example.com', 'token', 1, () => [{ page: baseline, baseline }], () => true);
    assert.deepEqual(requests.sort((a, b) => a-b), [28, 29, 30, 100]);
    assert.equal(result.entries.length, 30);
    assert.equal(result.documents.length, 4);
    assert.ok(result.documents.some(doc => doc.id === 100));
  } finally { globalThis.fetch = original; }
});

test('body failures do not produce a successful partial workspace', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (url) => String(url).endsWith('ListDocumentIndex')
      ? Response.json({ entries: [entry(1)], persistenceProtocolVersion: 1 })
      : Response.json({ code: 'unavailable', message: 'offline' }, { status: 503 })) as typeof fetch;
    await assert.rejects(loadIndexedWorkspace('https://example.com', 'token', 1, () => [], () => true), /offline/);
  } finally { globalThis.fetch = original; }
});

test('warm loading reuses equal-revision baselines but refreshes changed or invalidated bodies', async () => {
  const original = globalThis.fetch;
  const requests: number[] = [];
  const baseline = (id: number) => ({ ...indexPage(entry(id)), metadataOnly: undefined });
  try {
    globalThis.fetch = (async (url, init) => {
      if (String(url).endsWith('ListDocumentIndex')) return Response.json({ entries: [entry(3), { ...entry(2), revision: '2' }, entry(1)], persistenceProtocolVersion: 1 });
      const id = Number(JSON.parse(String(init?.body)).id);
      requests.push(id);
      return Response.json({ document: { ...entry(id), revision: id === 2 ? '2' : '1', blocks: [] } });
    }) as typeof fetch;
    const result = await loadIndexedWorkspace('https://example.com', 'token', 1, () => [
      { page: { ...baseline(1), title: 'Unsaved local title' }, baseline: baseline(1) },
      { page: baseline(2), baseline: baseline(2) },
      { page: baseline(3), baseline: baseline(3), needsRefresh: true },
    ], () => true);
    assert.deepEqual(requests.sort(), [2, 3]);
    assert.deepEqual(result.unchangedPages.map(page => page.backendId), [1]);
    assert.equal(result.unchangedPages[0].title, 'Note 1');
  } finally { globalThis.fetch = original; }
});
