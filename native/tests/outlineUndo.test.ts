import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reduceOutlineState } from '../src/features/outline/state';
import { getPagesForPersistence, makeSnapshot } from '../src/features/outline/tree';
import type { OutlineState } from '../src/features/outline/types';

function initial(): OutlineState {
  return {
    pages: [{ id: 'note', kind: 'note', date: '2026-09-23', title: 'Note', nodes: [
      { id: 'one', parentId: null, text: 'Original' },
      { id: 'two', parentId: null, text: 'Second row' },
    ] }],
    activePageId: 'note', activeView: 'note', focusedId: 'one', normalCursor: 0,
    anchorId: null, editingId: null, draftText: '', editCursor: 'end', mode: 'normal',
    yankBuffer: null, history: [],
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
  assert.equal(state.history.length, 1);

  state = reduceOutlineState(state, { type: 'undo' });
  assert.equal(getPagesForPersistence(state)[0].nodes[0].text, 'Original');
  assert.equal(state.history.length, 0);
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
  assert.equal(state.history.length, 0);
  assert.equal(reduceOutlineState(state, { type: 'undo' }), state);
});

test('moving an actual outline row remains an undoable edit', () => {
  let state = reduceOutlineState(initial(), { type: 'moveSelection', direction: 1 });
  assert.deepEqual(state.pages[0].nodes.map((node) => node.id), ['two', 'one']);
  assert.equal(state.history.length, 1);
  state = reduceOutlineState(state, { type: 'undo' });
  assert.deepEqual(state.pages[0].nodes.map((node) => node.id), ['one', 'two']);
});

test('undo skips legacy cursor-only snapshots already in memory', () => {
  let state = edit(initial());
  state = { ...state, history: [...state.history, makeSnapshot(state), makeSnapshot({ ...state, normalCursor: 3 })] };
  const undone = reduceOutlineState(state, { type: 'undo' });
  assert.equal(getPagesForPersistence(undone)[0].nodes[0].text, 'Original');
  assert.equal(undone.history.length, 0);
});
