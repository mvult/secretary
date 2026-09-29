import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reduceOutlineState } from '../src/features/outline/state';
import { getPagesForPersistence } from '../src/features/outline/tree';
import type { OutlineState } from '../src/features/outline/types';
import { reconcileSavedPage } from '../src/features/session/saveReconciliation';
import { trackDrafts } from '../src/features/session/draftReconciliation';
import { pageHash } from '../src/app/pagePersistence';

function initial(): OutlineState {
  return {
    pages: [{ id: 'note', kind: 'note', date: '2026-09-23', title: 'Note', nodes: [
      { id: 'one', parentId: null, text: 'Original' },
      { id: 'two', parentId: null, text: 'Second row' },
    ] }],
    activePageId: 'note', activeView: 'note', focusedId: 'one', normalCursor: 0,
    anchorId: null, editingId: null, draftText: '', editCursor: 'end', mode: 'normal',
    yankBuffer: null, documentHistory: {},
  };
}

function edit(state: OutlineState) {
  state = reduceOutlineState(state, { type: 'startEditing' });
  state = reduceOutlineState(state, { type: 'updateDraft', text: 'Changed text' });
  return reduceOutlineState(state, { type: 'commitEdit' });
}

test('movement and unchanged commits do not consume undo steps', () => {
  let state = edit(initial());
  state = reduceOutlineState(state, { type: 'moveFocus', direction: 1, extendSelection: false });
  state = reduceOutlineState(state, { type: 'commitEdit' });
  state = reduceOutlineState(state, { type: 'moveCaret', motion: 'right' });
  state = reduceOutlineState(state, { type: 'commitEdit' });
  state = reduceOutlineState(state, { type: 'startEditing' });
  state = reduceOutlineState(state, { type: 'commitEdit' });
  assert.equal(state.documentHistory?.note.length, 1);

  state = reduceOutlineState(state, { type: 'undo' });
  assert.equal(getPagesForPersistence(state)[0].nodes[0].text, 'Original');
  assert.equal(state.documentHistory?.note.length, 0);
  assert.equal(state.editingId, null);
  assert.equal(state.mode, 'normal');
});

test('undoing a text commit does not reopen the new draft text', () => {
  const edited = edit(initial());
  assert.equal(edited.pages[0].nodes[0].text, 'Changed text');
  const undone = reduceOutlineState(edited, { type: 'undo' });
  assert.equal(undone.pages[0].nodes[0].text, 'Original');
  assert.equal(getPagesForPersistence(undone)[0].nodes[0].text, 'Original');
  assert.equal(undone.draftText, '');
});

test('navigation and entering/leaving insert mode without editing leave history empty', () => {
  let state = initial();
  state = reduceOutlineState(state, { type: 'startEditing' });
  state = reduceOutlineState(state, { type: 'commitEdit' });
  state = reduceOutlineState(state, { type: 'focus', nodeId: 'two' });
  state = reduceOutlineState(state, { type: 'jumpFocus', position: 'start' });
  state = reduceOutlineState(state, { type: 'openSettings' });
  state = reduceOutlineState(state, { type: 'selectNote', pageId: 'note' });
  assert.equal(state.documentHistory?.note?.length ?? 0, 0);
  assert.equal(reduceOutlineState(state, { type: 'undo' }), state);
});

test('moving an actual outline row remains an undoable edit', () => {
  let state = reduceOutlineState(initial(), { type: 'moveSelection', direction: 1 });
  assert.deepEqual(state.pages[0].nodes.map((node) => node.id), ['two', 'one']);
  assert.equal(state.documentHistory?.note.length, 1);
  state = reduceOutlineState(state, { type: 'undo' });
  assert.deepEqual(state.pages[0].nodes.map((node) => node.id), ['one', 'two']);
});

test('history is bounded per document and contains content rather than transport state', () => {
  let state = initial();
  for (let i = 0; i < 110; i++) state = reduceOutlineState(state, { type: 'updatePageTitle', title: String(i) });
  assert.equal(state.documentHistory?.note.length, 100);
  assert.deepEqual(Object.keys(state.documentHistory!.note[0]).sort(), ['focusedId', 'nodes', 'normalCursor', 'title']);
});

test('undo is document-local across navigation and remote replacement', () => {
  let state = initial();
  state.pages = [...state.pages, { ...state.pages[0], id: 'other', title: 'Other' }];
  state = edit(state);
  state = reduceOutlineState(state, { type: 'selectNote', pageId: 'other' });
  state = reduceOutlineState(state, { type: 'updatePageTitle', title: 'Edited other' });
  const note = state.pages[0];
  state = reduceOutlineState(state, { type: 'undo' });
  assert.equal(state.pages[0], note);
  assert.equal(state.pages[1].title, 'Other');
  state = reduceOutlineState(state, { type: 'refreshPages', pages: [note, { ...state.pages[1], title: 'Remote', revision: '3' }] });
  state = reduceOutlineState(state, { type: 'selectNote', pageId: 'note' });
  state = reduceOutlineState(state, { type: 'undo' });
  assert.equal(state.pages[0].nodes[0].text, 'Original');
  assert.equal(state.pages[1].title, 'Remote');
  assert.equal(state.pages[1].revision, '3');
});

test('navigation commits a draft into its own undo stack', () => {
  let state = initial();
  state = reduceOutlineState(state, { type: 'startEditing' });
  state = reduceOutlineState(state, { type: 'updateDraft', text: 'Pending text' });
  state = reduceOutlineState(state, { type: 'openSettings' });
  state = reduceOutlineState(state, { type: 'selectNote', pageId: 'note' });
  state = reduceOutlineState(state, { type: 'undo' });
  assert.equal(state.pages[0].nodes[0].text, 'Original');
});

test('undo after acknowledged deletion uses a new insertion key and current revision', () => {
  let state = initial();
  state.pages = [{ ...state.pages[0], backendId: 10, clientKey: 'doc', revision: '1',
    nodes: state.pages[0].nodes.map((node, i) => ({ ...node, backendId: i + 1, clientKey: `key-${i}` })) }];
  state = reduceOutlineState(state, { type: 'deleteSelection' });
  const deleted = state.pages[0];
  const saved = { ...deleted, revision: '2' };
  state = reduceOutlineState(state, { type: 'mergeRemotePage', page: saved, acknowledged: saved });
  state = reduceOutlineState(state, { type: 'undo' });
  assert.equal(state.pages[0].revision, '2');
  const restored = state.pages[0].nodes[0];
  assert.equal(restored.id, 'one');
  assert.equal(restored.backendId, undefined);
  assert.notEqual(restored.clientKey, 'key-0');
  assert.equal(state.pages[0].nodes[1].backendId, 2);
});

test('undo before deletion acknowledgment drops the deleted server identity when acknowledgment arrives', () => {
  let state = initial();
  state.pages = [{ ...state.pages[0], backendId: 10, clientKey: 'doc', revision: '1',
    nodes: state.pages[0].nodes.map((node, i) => ({ ...node, backendId: i + 1, clientKey: `key-${i}` })) }];
  state = reduceOutlineState(state, { type: 'deleteSelection' });
  const submitted = state.pages[0];
  state = reduceOutlineState(state, { type: 'undo' });
  assert.equal(state.pages[0].nodes[0].backendId, 1);
  const result = reconcileSavedPage(submitted, state.pages[0], { ...submitted, revision: '2' });
  assert.equal(result.page.nodes[0].backendId, undefined);
  assert.notEqual(result.page.nodes[0].clientKey, 'key-0');
  assert.equal(result.needsSave, true);
});

test('draft projection and dirty observation reuse all untouched documents', () => {
  let state = initial();
  const other = { ...state.pages[0], id: 'other' };
  state.pages = [...state.pages, other];
  const records = trackDrafts([], state.pages);
  const hash = pageHash(other);
  state = reduceOutlineState(state, { type: 'startEditing' });
  state = reduceOutlineState(state, { type: 'updateDraft', text: 'Typing' });
  const projected = getPagesForPersistence(state);
  const observed = trackDrafts(records, projected);
  assert.equal(projected[1], other);
  assert.equal(observed[1], records[1]);
  assert.equal(pageHash(other), hash);
  assert.equal(getPagesForPersistence(state)[0], projected[0]);
  assert.equal(observed[0].generation, 1);
});

test('an insertion acknowledged after local deletion keeps its assigned identity outside undo', () => {
  let state = initial();
  state.pages = [{ ...state.pages[0], backendId: 10, revision: '1', clientKey: 'doc' }];
  const submitted = state.pages[0];
  state = reduceOutlineState(state, { type: 'deleteSelection' });
  const saved = { ...submitted, revision: '2', nodes: submitted.nodes.map((node, i) => ({ ...node, backendId: i + 1, clientKey: node.id })) };
  const reconciled = reconcileSavedPage(submitted, state.pages[0], saved);
  state = reduceOutlineState(state, { type: 'mergeRemotePage', page: reconciled.page, acknowledged: saved });
  state = reduceOutlineState(state, { type: 'undo' });
  assert.equal(state.pages[0].nodes[0].id, 'one');
  assert.equal(state.pages[0].nodes[0].backendId, 1);
  assert.equal(state.pages[0].nodes[0].clientKey, 'one');
  assert.equal(state.pages[0].revision, '2');
});

test('autosave acknowledgment while typing does not erase the edit undo boundary', () => {
  let state = initial();
  state.pages = [{ ...state.pages[0], backendId: 10, clientKey: 'doc', revision: '1',
    nodes: state.pages[0].nodes.map((node, i) => ({ ...node, backendId: i + 1, clientKey: node.id })) }];
  state = reduceOutlineState(state, { type: 'startEditing' });
  state = reduceOutlineState(state, { type: 'updateDraft', text: 'Saved while typing' });
  const submitted = getPagesForPersistence(state)[0];
  const saved = { ...submitted, revision: '2' };
  state = reduceOutlineState(state, { type: 'mergeRemotePage', page: saved, acknowledged: saved });
  state = reduceOutlineState(state, { type: 'commitEdit' });
  state = reduceOutlineState(state, { type: 'undo' });
  assert.equal(state.pages[0].nodes[0].text, 'Original');
  assert.equal(state.pages[0].revision, '2');
  assert.equal(state.pages[0].nodes[0].backendId, 1);
});
