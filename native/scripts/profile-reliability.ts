import assert from 'node:assert/strict';
import { cpus } from 'node:os';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { loadIndexedWorkspace } from '../src/features/session/documentIndex';
import { documentToOutlinePage } from '../src/features/outline/remote';
import { reduceOutlineState } from '../src/features/outline/state';
import { getPagesForPersistence } from '../src/features/outline/tree';
import type { OutlineState } from '../src/features/outline/types';
import { mergeWorkspace, trackDrafts } from '../src/features/session/draftReconciliation';
import { DraftStorage, draftScope, openDraftDatabase } from '../src/lib/draftStorage';

// Deliberately offline: measures client CPU/serialization, not network, Postgres,
// React rendering, or WebKit disk durability. No credentials or real writes.
const originalFetch = globalThis.fetch;
const results = [];
try {
  for (const count of [180, 1800]) {
    const documents = Array.from({ length: count }, (_, i) => ({
      id: count - i, clientKey: `document-${count - i}`, workspaceId: 1, revision: '1',
      kind: 'note' as const, title: `Note ${count - i}`, journalDate: '', directoryId: 0,
      createdAt: '', updatedAt: '',
      blocks: Array.from({ length: 10 }, (_, j) => ({
        id: (count - i) * 10 + j, clientKey: `block-${count - i}-${j}`, documentId: count - i,
        parentBlockId: 0, parentClientKey: '', sortOrder: j, text: 'Representative outline text '.repeat(8),
        todoId: 0, createdAt: '', updatedAt: '',
      })),
    }));
    let indexReads = 0;
    let bodyReads = 0;
    globalThis.fetch = (async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith('ListDocumentIndex')) {
        indexReads++;
        const remaining = documents.filter(doc => !Number(body.beforeId) || doc.id < Number(body.beforeId));
        const entries = remaining.slice(0, 100).map(({ blocks: _, ...entry }) => entry);
        return Response.json({ entries, nextBeforeId: remaining.length > 100 ? String(entries.at(-1)!.id) : '0', persistenceProtocolVersion: 1 });
      }
      if (String(url).endsWith('GetDocument')) {
        bodyReads++;
        return Response.json({ document: documents.find(doc => doc.id === Number(body.id)) });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as typeof fetch;
    const db = await openDraftDatabase(new IDBFactory());
    const storage = new DraftStorage(db, draftScope('https://profile.invalid', 1, 1));
    await storage.load();
    const start = performance.now();
    const cold = await loadIndexedWorkspace('https://profile.invalid', 'fixture', 1, () => [], () => true);
    let records = mergeWorkspace([], cold.documents.map(documentToOutlinePage));
    await storage.save({ records, directories: [], index: cold.entries }, true);
    const coldMs = performance.now() - start;
    assert.equal(bodyReads, 1);
    const coldReads = { index: indexReads, body: bodyReads };
    indexReads = bodyReads = 0;
    const warmStart = performance.now();
    const restored = await new DraftStorage(db, draftScope('https://profile.invalid', 1, 1)).load();
    const warm = await loadIndexedWorkspace('https://profile.invalid', 'fixture', 1, () => restored.records, () => true);
    const warmMs = performance.now() - warmStart;
    assert.equal(bodyReads, 0);
    assert.equal(warm.unchangedPages.length, 1);

    // Stress editing with the full clean-body budget, independent of index size.
    records = mergeWorkspace([], documents.slice(0, 100).map(documentToOutlinePage));
    await storage.save({ records, directories: [], index: cold.entries }, true);
    let state: OutlineState = {
      pages: records.map(record => record.page), activePageId: records[0].page.id, activeView: 'note',
      focusedId: records[0].page.nodes[0].id, normalCursor: 0, anchorId: null,
      editingId: null, draftText: '', editCursor: 'end', mode: 'normal', yankBuffer: null,
    };
    state = reduceOutlineState(state, { type: 'startEditing' });
    const samples: number[] = [];
    const editSamples: number[] = [];
    const retentionSamples: number[] = [];
    for (let edit = 0; edit < 220; edit++) {
      const tick = performance.now();
      state = reduceOutlineState(state, { type: 'updateDraft', text: `Edit ${edit}` });
      records = trackDrafts(records, getPagesForPersistence(state));
      const retainedAt = performance.now();
      await storage.save({ records, directories: [], index: cold.entries }, true);
      if (edit >= 20) {
        const end = performance.now();
        samples.push(end - tick);
        editSamples.push(retainedAt - tick);
        retentionSamples.push(end - retainedAt);
      }
    }
    const distribution = (values: number[]) => {
      values.sort((a, b) => a - b);
      return { samples: values.length, p50: values[100], p95: values[190], max: values.at(-1) };
    };
    indexReads = bodyReads = 0;
    const syncStart = performance.now();
    const sync = await loadIndexedWorkspace('https://profile.invalid', 'fixture', 1, () => records, () => true);
    records = mergeWorkspace(records, [...sync.unchangedPages, ...sync.documents.map(documentToOutlinePage)]);
    await storage.save({ records, directories: [], index: sync.entries }, true);
    const syncMs = performance.now() - syncStart;
    assert.equal(bodyReads, 0);
    assert.equal(records[0].page.nodes[0].text, 'Edit 219');
    results.push({ documents: count, blocks: count * 10, loadedForEditing: 100,
      coldMs, coldReads, warmMs, syncMs, syncReads: { index: indexReads, body: bodyReads },
      editAndRetentionMs: distribution(samples), editCpuMs: distribution(editSamples), retentionMs: distribution(retentionSamples) });
    db.close();
  }
} finally { globalThis.fetch = originalFetch; }
console.log(JSON.stringify({ measuredAt: new Date().toISOString(), runtime: `Bun ${Bun.version}`,
  cpu: cpus()[0]?.model, platform: process.platform, mode: 'synthetic; fake IndexedDB; zero network latency', results }, null, 2));
