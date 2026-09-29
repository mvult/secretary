import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizePageForSave, pageHash } from '../src/app/pagePersistence';
import type { OutlinePage, OutlineState } from '../src/features/outline/types';
import { getPagesForPersistence, mergeRemotePage } from '../src/features/outline/tree';
import { documentToOutlinePage } from '../src/features/outline/remote';
import { reconcileSavedPage } from '../src/features/session/saveReconciliation';

const request: OutlinePage = {
  id: 'note-1', backendId: 1, workspaceId: 1, kind: 'note', date: '', title: 'Note',
  nodes: [{ id: 'block-1', backendId: 10, parentId: null, text: 'Sent text' }],
};

test('edits made during a save stay dirty until the next save succeeds', () => {
  const latest = { ...request, nodes: [{ ...request.nodes[0], text: 'Newer text' }] };
  const first = reconcileSavedPage(request, latest, request);
  assert.equal(first.page.nodes[0].text, 'Newer text');
  assert.equal(first.needsSave, true);
  assert.notEqual(pageHash(first.page), first.savedHash);
  assert.equal(first.savedHash, pageHash(request));

  const second = reconcileSavedPage(first.page, first.page, first.page);
  assert.equal(second.needsSave, false);
  assert.equal(pageHash(second.page), second.savedHash);
});

test('first save preserves concurrent edits and adopts IDs without duplicating the note', () => {
  const local: OutlinePage = {
    ...request, id: 'local-note', backendId: undefined,
    nodes: [{ id: 'local-block', parentId: null, text: 'Sent text' }],
  };
  const latest: OutlinePage = {
    ...local, title: 'New title',
    nodes: [
      { ...local.nodes[0], text: 'Newer text' },
      { id: 'new-child', parentId: 'local-block', text: 'Added during save' },
    ],
  };
  const saved = { ...request, nodes: [{ ...request.nodes[0], clientKey: 'local-block' }] };
  const result = reconcileSavedPage(local, latest, saved);
  assert.equal(result.page.backendId, 1);
  assert.equal(result.page.title, 'New title');
  assert.equal(result.page.nodes[0].backendId, 10);
  assert.equal(result.page.nodes[0].text, 'Newer text');
  assert.equal(result.page.nodes[1].backendId, undefined);
  assert.equal(result.page.nodes[1].parentId, result.page.nodes[0].id);
  assert.equal(result.needsSave, true);
  assert.notEqual(pageHash(result.page), result.savedHash);
});

test('a save response does not resurrect a block deleted during the request', () => {
  const result = reconcileSavedPage(request, { ...request, nodes: [] }, request);
  assert.deepEqual(result.page.nodes, []);
  assert.equal(result.needsSave, true);
});

test('an unchanged new note adopts the saved page and is clean', () => {
  const local = { ...request, id: 'local-note', backendId: undefined };
  const result = reconcileSavedPage(local, local, request);
  assert.equal(result.page.id, local.id);
  assert.equal(result.page.backendId, request.backendId);
  assert.equal(result.needsSave, false);
  assert.equal(pageHash(result.page), result.savedHash);
});

const mixedRows: OutlinePage = {
  ...request,
  nodes: [
    { id: 'block-1', backendId: 1, parentId: null, text: 'Parent' },
    { id: 'block-2', backendId: 2, parentId: 'block-1', text: 'First child' },
    { id: 'local-polish', parentId: null, text: 'Polish camera flow' },
    { id: 'block-3', backendId: 3, parentId: 'block-1', text: 'Still not feeling smooth after scanning', todoStatus: 'todo' },
  ],
};

test('saving preserves visible row order when parents already precede their children', () => {
  assert.deepEqual(normalizePageForSave(mixedRows).nodes.map((node) => node.id), mixedRows.nodes.map((node) => node.id));
});

test('a reordered save response cannot move the active draft onto a different block', () => {
  // Reproduce the old save normalizer's regrouping of all children before a new root.
  const saved = documentToOutlinePage({
    id: 1, workspaceId: 1, clientKey: '', kind: 'note', title: 'Note', journalDate: '', directoryId: 0,
    createdAt: '', updatedAt: '', blocks: [mixedRows.nodes[0], mixedRows.nodes[1], mixedRows.nodes[3], mixedRows.nodes[2]].map((node, index) => ({
      id: node.backendId ?? 4, clientKey: node.id, documentId: 1, parentBlockId: node.parentId ? 1 : 0,
      parentClientKey: '', sortOrder: index + 1, text: node.text, todoStatus: node.todoStatus ?? undefined,
      todoId: 0, createdAt: '', updatedAt: '',
    })),
  });
  const state: OutlineState = {
    pages: [mixedRows], activePageId: mixedRows.id, activeView: 'note', focusedId: 'local-polish',
    editingId: 'local-polish', draftText: 'Polish camera flow', normalCursor: 0, editCursor: 'end',
    mode: 'insert', anchorId: null, yankBuffer: null, documentHistory: {},
  };
  const next = mergeRemotePage(state, saved, mixedRows.id);
  assert.equal(next.editingId, 'block-4');
  assert.equal(next.focusedId, 'block-4');
  const persisted = getPagesForPersistence(next)[0];
  assert.equal(persisted.nodes.find((node) => node.backendId === 3)?.text, 'Still not feeling smooth after scanning');
  assert.equal(persisted.nodes.filter((node) => node.text === 'Polish camera flow').length, 1);
});

test('new block IDs follow echoed client keys, not response positions', () => {
  const local: OutlinePage = { ...request, nodes: [
    { id: 'local-a', parentId: null, text: 'A' }, { id: 'local-b', parentId: null, text: 'B' },
  ] };
  const saved: OutlinePage = { ...request, nodes: [
    { id: 'block-22', clientKey: 'local-b', backendId: 22, parentId: null, text: 'B' },
    { id: 'block-21', clientKey: 'local-a', backendId: 21, parentId: null, text: 'A' },
  ] };
  const latest = { ...local, nodes: [{ ...local.nodes[0], text: 'Newer A' }, local.nodes[1]] };
  const result = reconcileSavedPage(local, latest, saved);
  assert.equal(result.page.nodes[0].backendId, 21);
  assert.equal(result.page.nodes[1].backendId, 22);
  assert.equal(result.page.nodes[0].text, 'Newer A');
  assert.equal(result.needsSave, true);
});

test('an unidentified new block response is rejected instead of guessing by position', () => {
  const local = { ...request, nodes: [{ id: 'new-block', parentId: null, text: 'Sent text' }] };
  assert.throws(() => reconcileSavedPage(local, local, request), /missing the identity/);
});

test('save normalization still repairs children that precede their parents', () => {
  const page = { ...mixedRows, nodes: [mixedRows.nodes[1], mixedRows.nodes[0]] };
  assert.deepEqual(normalizePageForSave(page).nodes.map((node) => node.id), ['block-1', 'block-2']);
});
