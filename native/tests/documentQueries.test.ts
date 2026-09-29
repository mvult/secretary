import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DocumentQueries } from '../src/features/session/documentQueries';
import { readDocumentIndex } from '../src/features/session/documentIndex';
import type { DraftScope } from '../src/lib/draftStorage';

const scope: DraftScope = ['https://example.com', '1', '1'];
const entry = { id: '3', clientKey: 'doc-3', workspaceId: '1', revision: '1', kind: 'note', title: 'Found' };

test('index queries deduplicate by scope, cursor and search and revalidate completed reads', async () => {
  const original = globalThis.fetch;
  const queries = new DocumentQueries();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = (async () => { calls++; await gate; return Response.json({ entries: [entry], persistenceProtocolVersion: 1 }); }) as typeof fetch;
  try {
    const first = queries.index(scope, 'token', 0, 'needle');
    const same = queries.index(scope, 'token', 0, 'needle');
    const otherSearch = queries.index(scope, 'token', 0, 'other');
    const otherPage = queries.index(scope, 'token', 3, 'needle');
    const otherAccount = queries.index([scope[0], '2', '1'], 'other-token', 0, 'needle');
    const otherWorkspace = queries.index([scope[0], '1', '2'], 'token', 0, 'needle');
    release();
    await Promise.all([first, same, otherSearch, otherPage, otherAccount, otherWorkspace]);
    assert.equal(calls, 5);
    await queries.index(scope, 'token', 0, 'needle');
    assert.equal(calls, 6);
  } finally { release(); queries.clear(); globalThis.fetch = original; }
});

for (const clear of ['clear', 'clearLists'] as const) test(`${clear} cancels old list consumers and a new read cannot reuse the late result`, async () => {
  const original = globalThis.fetch;
  const queries = new DocumentQueries();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  globalThis.fetch = (async () => {
    const old = ++calls === 1;
    if (old) await gate;
    return Response.json({ workspaces: [{ id: 1, name: old ? 'Old' : 'Current' }] });
  }) as typeof fetch;
  try {
    const pending = queries.workspaces(scope[0], 'token', 1);
    const rejected = assert.rejects(pending);
    queries[clear]();
    assert.equal((await queries.workspaces(scope[0], 'new-token', 1))[0].name, 'Current');
    release();
    await rejected;
    assert.equal((await queries.workspaces(scope[0], 'new-token', 1))[0].name, 'Current');
    assert.equal(calls, 3);
  } finally { release(); queries.clear(); globalThis.fetch = original; }
});

test('cached index pages retain pagination validation and never turn a later-page failure into success', async () => {
  const original = globalThis.fetch;
  const queries = new DocumentQueries();
  let fail = true;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (!Number(body.beforeId)) return Response.json({ entries: [entry], nextBeforeId: '3', persistenceProtocolVersion: 1 });
    if (fail) return Response.json({ code: 'unavailable', message: 'offline' }, { status: 503 });
    return Response.json({ entries: [{ ...entry, id: '2', clientKey: 'doc-2' }], persistenceProtocolVersion: 1 });
  }) as typeof fetch;
  const read = () => readDocumentIndex(scope[0], 'token', 1, () => true, 'needle',
    (_base, token, _workspace, before, query) => queries.index(scope, token, before, query));
  try {
    await assert.rejects(read());
    fail = false;
    assert.deepEqual((await read()).entries.map(entry => entry.id), [3, 2]);
  } finally { queries.clear(); globalThis.fetch = original; }
});

test('TODO and goal reads share in-flight work within their own list types', async () => {
  const original = globalThis.fetch;
  const queries = new DocumentQueries();
  const calls: string[] = [];
  globalThis.fetch = (async url => {
    calls.push(String(url));
    return Response.json({ todos: [], goals: [] });
  }) as typeof fetch;
  try {
    await Promise.all([queries.todos(scope[0], 'token', 1), queries.todos(scope[0], 'token', 1),
      queries.goals(scope[0], 'token', 1), queries.goals(scope[0], 'token', 1)]);
    assert.equal(calls.length, 2);
    await queries.todos(scope[0], 'token', 1);
    assert.equal(calls.length, 3);
  } finally { queries.clear(); globalThis.fetch = original; }
});
