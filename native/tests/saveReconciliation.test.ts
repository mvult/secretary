import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageHash } from '../src/app/pagePersistence';
import type { OutlinePage } from '../src/features/outline/types';
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
  const result = reconcileSavedPage(local, latest, request);
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
  assert.equal(result.page, request);
  assert.equal(result.needsSave, false);
  assert.equal(pageHash(result.page), result.savedHash);
});
