import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageHash } from '../src/app/pagePersistence';
import { BackendError, normalizeDocument } from '../src/lib/backend';
import type { DraftRecord, DraftScope } from '../src/lib/draftStorage';
import { documentToOutlinePage } from '../src/features/outline/remote';
import { DocumentSaveController, prepareDelete, prepareSave, type SaveResult } from '../src/features/session/documentSaveController';
import { isDraftDirty, mergeWorkspace, trackDrafts } from '../src/features/session/draftReconciliation';

const scope: DraftScope = ['https://example.com', '1', '1'];
const baseline = documentToOutlinePage(normalizeDocument({ id: '1', workspaceId: '1', clientKey: 'persisted-document', revision: '9007199254740993', kind: 'note', title: 'Title',
  blocks: [{ id: '2', clientKey: 'persisted-block', sortOrder: 1, text: 'Original' }] }));
function dirty(): DraftRecord {
  return { draftId: 'draft', generation: 1, baseline: structuredClone(baseline), savedHash: pageHash(baseline), page: { ...structuredClone(baseline), title: 'Edited' } };
}
function acknowledgment(body: string): SaveResult {
  const request = JSON.parse(body);
  const doc = request.document;
  const ids = new Map<string, number>(doc.blocks.map((block: any, index: number) => [block.clientKey, Number(block.id) || 100 + index]));
  return { mutationId: request.mutationId, outcome: 'applied', effects: [], page: documentToOutlinePage(normalizeDocument({ ...doc,
    id: Number(doc.id) || 10, revision: String(BigInt(request.expectedRevision) + 1n),
    blocks: doc.blocks.map((block: any) => ({ ...block, id: ids.get(block.clientKey), parentBlockId: ids.get(block.parentClientKey) ?? 0 })),
  })) };
}
function harness(initial = dirty()) {
  let record = structuredClone(initial);
  let durable = structuredClone(initial);
  let active = true;
  const sends: string[] = [];
  const failures: unknown[] = [];
  let last: SaveResult | undefined;
  const ports = { scope, active: () => active, canSend: () => true,
    read: () => record,
    change: (_id: string, update: (record: DraftRecord) => DraftRecord) => { record = update(record); },
    persist: async () => { durable = structuredClone(record); },
    send: async (body: string) => {
      assert.equal(durable.envelope?.body, body, 'request must be committed locally before send');
      sends.push(body); last = acknowledgment(body); return last;
    },
    getServer: async () => last?.page ?? baseline,
    effects: async () => {}, status: () => {}, failure: (error: unknown) => { failures.push(error); },
  };
  return { ports, sends, failures, current: () => record, durable: () => durable,
    edit: (title: string) => { record = { ...record, page: { ...record.page, title }, generation: (record.generation ?? 0) + 1 }; },
    restore: () => { record = structuredClone(durable); }, detach: () => { active = false; } };
}

function deletion() {
  const clean = { ...dirty(), page: structuredClone(baseline), generation: 0, acknowledgedGeneration: 0 };
  const h = harness({ ...clean, envelope: prepareDelete(clean, scope) });
  let removed = false;
  const sends: string[] = [];
  const ports = { ...h.ports, read: () => removed ? undefined : h.current(),
    send: async (): Promise<SaveResult> => { throw new Error('Deletion must never use SaveDocument'); },
    sendDelete: async (body: string) => {
      assert.equal(h.durable().envelope?.body, body);
      sends.push(body);
      return { mutationId: JSON.parse(body).mutationId, deleted: [1], effects: [1] };
    },
    remove: async () => { removed = true; },
  };
  return { ...h, ports, deletes: sends, removed: () => removed };
}

test('online deletion uses the acknowledged revision and rejects dirty snapshots', () => {
  const record = { ...dirty(), page: { ...baseline, revision: '1' }, generation: 0, acknowledgedGeneration: 0 };
  assert.equal(JSON.parse(prepareDelete(record, scope).body).expectedRevision, baseline.revision);
  assert.throws(() => prepareDelete(dirty(), scope), /pending edits/);
});

test('lost deletion response replays exact bytes after restore without snapshot saving', async () => {
  const h = deletion();
  const send = h.ports.sendDelete;
  h.ports.sendDelete = async (body) => { await send(body); throw new TypeError('Response lost'); };
  await new DocumentSaveController(h.ports).flush('draft');
  assert.equal(h.removed(), false);
  h.restore();
  h.ports.sendDelete = send;
  await new DocumentSaveController(h.ports).flush('draft', true);
  assert.equal(h.removed(), true);
  assert.equal(h.deletes.length, 2);
  assert.equal(h.deletes[0], h.deletes[1]);
});

test('delete storage failures retain the operation and never remove a draft prematurely', async () => {
  const h = deletion();
  const persist = h.ports.persist;
  h.ports.persist = async () => { throw new Error('Disk full'); };
  await new DocumentSaveController(h.ports).flush('draft');
  assert.equal(h.deletes.length, 0);
  h.ports.persist = persist;
  const remove = h.ports.remove;
  h.ports.remove = async () => { throw new Error('Local acknowledgment failed'); };
  await new DocumentSaveController(h.ports).flush('draft', true);
  assert.equal(h.removed(), false);
  assert.ok(h.durable().envelope);
  h.ports.remove = remove;
  await new DocumentSaveController(h.ports).flush('draft', true);
  assert.equal(h.deletes[0], h.deletes[1]);
  assert.equal(h.removed(), true);
});

test('edits made after requesting deletion survive its acknowledgment', async () => {
  const h = deletion();
  const send = h.ports.sendDelete;
  h.ports.sendDelete = async (body) => { h.edit('Keep this newer text'); return send(body); };
  await new DocumentSaveController(h.ports).flush('draft');
  assert.equal(h.removed(), false);
  assert.equal(h.durable().page.title, 'Keep this newer text');
  assert.equal(h.durable().envelope, undefined);
  assert.match(h.durable().conflict!, /deleted/);
  assert.equal(trackDrafts([h.durable()], [])[0].page.title, 'Keep this newer text', 'workspace undo cannot drop the recovery draft');
});

test('related-cache failure keeps deletion replayable until refresh and removal complete', async () => {
  const h = deletion();
  h.ports.effects = async () => { throw new TypeError('Related body unavailable'); };
  await new DocumentSaveController(h.ports).flush('draft');
  assert.equal(h.removed(), false);
  assert.ok(h.durable().envelope);
  h.ports.effects = async () => {};
  await new DocumentSaveController(h.ports).flush('draft', true);
  assert.equal(h.removed(), true);
  assert.equal(h.deletes[0], h.deletes[1]);
});

test('stale deletion is retained for review and late deletion responses cannot change a new scope', async () => {
  const h = deletion();
  h.ports.sendDelete = async () => { throw new BackendError('Revision conflict', 409, 'aborted'); };
  await new DocumentSaveController(h.ports).flush('draft');
  assert.equal(h.removed(), false);
  assert.match(h.durable().conflict!, /Revision conflict/);
  const detached = deletion();
  const send = detached.ports.sendDelete;
  detached.ports.sendDelete = async (body) => { detached.detach(); return send(body); };
  await new DocumentSaveController(detached.ports).flush('draft');
  assert.equal(detached.removed(), false);
  assert.ok(detached.durable().envelope);
});

test('versioned request uses the authoritative baseline and lossless revisions', () => {
  const record = dirty();
  record.page.revision = '1'; // An old undo snapshot cannot roll back the baseline.
  record.page.clientKey = 'legacy-key';
  record.page.nodes[0] = { ...record.page.nodes[0], clientKey: 'legacy-block-key' };
  const request = JSON.parse(prepareSave(record, scope).body);
  assert.equal(request.expectedRevision, '9007199254740993');
  assert.equal(request.document.clientKey, 'persisted-document');
  assert.equal(request.document.blocks[0].clientKey, 'persisted-block');
  assert.equal(request.document.id, '1');
});

test('storage failure sends nothing and retains the exact envelope', async () => {
  const h = harness();
  h.ports.persist = async () => { throw new Error('Quota exceeded'); };
  await new DocumentSaveController(h.ports).flush('draft');
  assert.equal(h.sends.length, 0);
  assert.ok(h.current().envelope);
  assert.equal(h.current().page.title, 'Edited');
});

test('lost response replays identical bytes after restart before newer edits', async () => {
  const h = harness();
  const send = h.ports.send;
  let committed: SaveResult | undefined;
  h.ports.send = async (body) => { committed = await send(body); throw new TypeError('Connection lost after commit'); };
  await new DocumentSaveController(h.ports).flush('draft');
  const original = h.durable().envelope!;
  h.edit('Newer local text');
  await h.ports.persist();
  h.restore();
  h.ports.send = async (body) => { assert.equal(body, original.body); h.sends.push(body); return committed!; };
  h.ports.getServer = async () => committed!.page;
  const restarted = new DocumentSaveController(h.ports);
  await restarted.flush('draft', true);
  assert.equal(h.current().page.title, 'Newer local text');
  assert.equal(h.current().baseline?.title, 'Edited');
  assert.equal(h.current().envelope, undefined);
  assert.notEqual(h.current().savedHash, pageHash(h.current().page));
  h.ports.send = send;
  await restarted.flush('draft');
  const next = JSON.parse(h.sends.at(-1)!);
  assert.notEqual(next.mutationId, original.mutationId);
  assert.equal(next.expectedRevision, '9007199254740994');
  assert.equal(next.document.title, 'Newer local text');
});

test('editing during a request preserves the newer generation and shares in-flight work', async () => {
  const h = harness();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const send = h.ports.send;
  h.ports.send = async (body) => { await wait; return send(body); };
  const controller = new DocumentSaveController(h.ports);
  const first = controller.flush('draft');
  assert.equal(controller.flush('draft'), first);
  await Promise.resolve();
  h.edit('Typed while saving');
  release();
  await first;
  assert.equal(h.sends.length, 1);
  assert.equal(h.current().page.title, 'Typed while saving');
  assert.equal(h.current().generation, 2);
  assert.equal(h.current().baseline?.title, 'Edited');
});

test('revision conflict retains draft and exact request with a server comparison', async () => {
  const h = harness();
  h.ports.send = async () => { throw new BackendError('Revision conflict', 409, 'aborted'); };
  await new DocumentSaveController(h.ports).flush('draft');
  assert.equal(h.current().page.title, 'Edited');
  assert.equal(h.current().serverCopy?.title, 'Title');
  assert.match(h.current().conflict!, /Revision conflict/);
  assert.ok(h.durable().envelope);
});

test('an old receipt after remote deletion retains content as a recovery conflict', async () => {
  const initial = dirty();
  initial.envelope = prepareSave(initial, scope);
  const h = harness(initial);
  h.ports.getServer = async () => null as any;
  await new DocumentSaveController(h.ports).flush('draft');
  assert.equal(h.current().page.title, 'Edited');
  assert.match(h.current().conflict!, /server changed/);
  assert.equal(h.current().serverCopy, null);
});

test('late response after account detachment cannot acknowledge current state', async () => {
  const h = harness();
  const send = h.ports.send;
  h.ports.send = async (body) => { const result = await send(body); h.detach(); return result; };
  await new DocumentSaveController(h.ports).flush('draft');
  assert.ok(h.durable().envelope);
  assert.equal(h.current().baseline?.revision, baseline.revision);
});

test('acknowledgment storage failure preserves a replayable request', async () => {
  const h = harness();
  const persist = h.ports.persist;
  h.ports.persist = async () => { if (!h.current().envelope) throw new Error('Ack commit failed'); await persist(); };
  await new DocumentSaveController(h.ports).flush('draft');
  assert.equal(h.sends.length, 1);
  assert.ok(h.durable().envelope);
});

test('retry backoff and attempt cap prevent a tight automatic loop', async () => {
  const h = harness();
  let attempts = 0;
  h.ports.send = async () => { attempts++; throw new TypeError('Offline'); };
  const controller = new DocumentSaveController(h.ports);
  await controller.flush('draft');
  await controller.flush('draft');
  assert.equal(attempts, 1);
  h.current().retry!.attempts = 3;
  h.current().retry!.nextAt = 0;
  await controller.flush('draft');
  assert.equal(attempts, 1);
  await controller.flush('draft', true);
  assert.equal(attempts, 2);
});

test('pending request survives refresh and a workspace undo that omits its page', () => {
  const record = dirty();
  record.envelope = prepareSave(record, scope);
  const merged = mergeWorkspace([record], [{ ...baseline, revision: '9007199254740994' }]);
  assert.equal(merged[0].envelope?.body, record.envelope.body);
  assert.equal(merged[0].conflict, undefined);
  assert.equal(trackDrafts(merged, [])[0].envelope?.body, record.envelope.body);
});

test('legacy baseline adoption maps by backend ID and refuses uncertain saves', () => {
  const record = dirty();
  record.baseline = { ...baseline, revision: undefined, clientKey: 'old' };
  const adopted = mergeWorkspace([record], [baseline])[0];
  assert.equal(adopted.baseline?.revision, baseline.revision);
  assert.equal(adopted.page.title, 'Edited');
  assert.equal(adopted.page.clientKey, 'persisted-document');
  const uncertain = mergeWorkspace([{ ...record, pending: true }], [baseline])[0];
  assert.ok(uncertain.conflict);
  assert.equal(uncertain.baseline?.revision, undefined);
  assert.throws(() => prepareSave(uncertain, scope), /Resolve/);
});

test('existing journal never acknowledges an edited local body', async () => {
  const page = { id: 'local-journal', workspaceId: 1, kind: 'journal' as const, date: '2026-09-26', title: '2026-09-26', nodes: [] };
  for (const edited of [false, true]) {
    const h = harness({ page, draftId: 'draft', generation: 0, placeholderHash: edited ? undefined : pageHash(page) });
    h.ports.send = async (body) => ({ ...acknowledgment(body), outcome: 'existing-journal',
      page: { ...acknowledgment(body).page, clientKey: 'existing-server-key', title: 'Existing journal' } });
    await new DocumentSaveController(h.ports).flush('draft');
    assert.equal(Boolean(h.current().conflict), edited);
    assert.equal(h.current().page.title, edited ? page.title : 'Existing journal');
  }
});

test('a lost create response allocates once and replays the original identity', async () => {
  const page = { id: 'new-note', workspaceId: 1, kind: 'note' as const, date: '', title: 'New',
    nodes: [{ id: 'new-block', parentId: null, text: 'New text' }] };
  const h = harness({ page, generation: 0, draftId: 'draft' });
  let receipt: SaveResult | undefined;
  let creations = 0;
  const send = h.ports.send;
  h.ports.send = async (body) => {
    if (!receipt) { creations++; receipt = await send(body); throw new TypeError('Lost create response'); }
    assert.equal(JSON.parse(body).mutationId, receipt.mutationId);
    return receipt;
  };
  h.ports.getServer = async () => receipt!.page;
  await new DocumentSaveController(h.ports).flush('draft');
  h.restore();
  await new DocumentSaveController(h.ports).flush('draft', true);
  assert.equal(creations, 1);
  assert.equal(h.current().page.backendId, 10);
  assert.equal(h.current().page.nodes[0].backendId, 100);
  assert.equal(h.current().savedHash, pageHash(h.current().page));
});

test('a create whose local acknowledgment failed becomes clean after exact replay', async () => {
  const h = harness({ page: { id: 'new', kind: 'note', title: 'New', date: '', workspaceId: 1,
    nodes: [{ id: 'local-block', parentId: null, text: 'Text' }] }, draftId: 'draft' });
  const persist = h.ports.persist;
  let fail = true;
  h.ports.persist = async () => { if (fail && !h.current().envelope) throw new Error('Ack failed'); await persist(); };
  const first = new DocumentSaveController(h.ports);
  await first.flush('draft');
  assert.ok(h.current().envelope);
  fail = false;
  await first.flush('draft', true);
  assert.equal(h.current().savedHash, pageHash(h.current().page));
  assert.equal(h.current().envelope, undefined);
});

test('the queue bounds independent documents to two requests', async () => {
  const records = new Map(['a', 'b', 'c'].map((id, index) => {
    const record = dirty();
    record.draftId = id;
    record.baseline = { ...record.baseline!, backendId: index + 1 };
    record.page = { ...record.page, backendId: index + 1 };
    return [id, record] as const;
  }));
  const releases: (() => void)[] = [];
  let active = 0;
  let max = 0;
  let started = 0;
  const h = harness();
  const controller = new DocumentSaveController({ ...h.ports,
    read: (id) => records.get(id),
    change: (id, update) => { records.set(id, update(records.get(id)!)); },
    persist: async () => {},
    send: async (body) => {
      started++; active++; max = Math.max(max, active);
      await new Promise<void>((resolve) => { releases.push(resolve); });
      active--; return acknowledgment(body);
    },
  });
  const work = ['a', 'b', 'c'].map((id) => controller.flush(id));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started, 2);
  releases.shift()!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started, 3);
  releases.splice(0).forEach((release) => release());
  await Promise.all(work);
  assert.equal(max, 2);
});

test('authentication pauses replay without dropping the operation or newer draft', async () => {
  const h = harness();
  let ready = true;
  let sends = 0;
  h.ports.canSend = () => ready;
  h.ports.failure = () => { ready = false; };
  h.ports.send = async () => { sends++; throw new BackendError('Log in', 401, 'unauthenticated'); };
  const controller = new DocumentSaveController(h.ports);
  await controller.flush('draft');
  const envelope = h.current().envelope;
  h.edit('Edited while signed out');
  await controller.flush('draft', true);
  assert.equal(sends, 1);
  assert.equal(h.current().conflict, undefined);
  assert.equal(h.current().envelope, envelope);
  assert.equal(h.current().page.title, 'Edited while signed out');
});

test('server cancellation is uncertain and retains a replayable request', async () => {
  const h = harness();
  h.ports.send = async () => { throw new BackendError('Canceled', 499, 'canceled'); };
  await new DocumentSaveController(h.ports).flush('draft');
  assert.ok(h.current().envelope);
  assert.equal(h.current().conflict, undefined);
});

test('a retained request cannot be sent under another account scope', async () => {
  const initial = dirty();
  initial.envelope = prepareSave(initial, scope);
  const h = harness(initial);
  await new DocumentSaveController({ ...h.ports, scope: [scope[0], '2', scope[2]] }).flush('draft');
  assert.equal(h.sends.length, 0);
  assert.equal(h.current().envelope?.body, initial.envelope.body);
});

test('acknowledgment advances only the submitted edit generation', async () => {
  const h = harness();
  const send = h.ports.send;
  h.ports.send = async (body) => {
    h.edit('Intermediate edit'); h.edit('Edited');
    return send(body);
  };
  await new DocumentSaveController(h.ports).flush('draft');
  assert.equal(h.current().acknowledgedGeneration, 1);
  assert.equal(h.current().generation, 3);
  assert.equal(isDraftDirty(h.current()), true);
});
