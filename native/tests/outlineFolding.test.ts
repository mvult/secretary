import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reduceOutlineState } from '../src/features/outline/state';
import { getVisibleNodes } from '../src/features/outline/folding';
import type { OutlineState } from '../src/features/outline/types';

function initial(): OutlineState {
  return {
    pages: [{ id: 'note', kind: 'note', date: '2026-09-28', title: 'Note', nodes: [
      { id: 'parent', parentId: null, text: 'Parent' },
      { id: 'child', parentId: 'parent', text: 'Child' },
      { id: 'grandchild', parentId: 'child', text: 'Grandchild' },
      { id: 'last', parentId: null, text: 'Last' },
    ] }],
    activePageId: 'note', activeView: 'note', focusedId: 'parent', normalCursor: 0,
    anchorId: null, editingId: null, draftText: '', editCursor: 'end', mode: 'normal',
    yankBuffer: null, history: [],
  };
}

const visible = (state: OutlineState) => getVisibleNodes(state.pages[0].nodes, state.collapsedNodeIds).map((node) => node.id);

test('folds preserve nested folds and document contents without adding undo entries', () => {
  const original = initial();
  let state = reduceOutlineState(original, { type: 'toggleFold', nodeId: 'child' });
  state = reduceOutlineState(state, { type: 'toggleFold', nodeId: 'parent' });
  assert.deepEqual(visible(state), ['parent', 'last']);
  state = reduceOutlineState(state, { type: 'toggleFold' });
  assert.deepEqual(visible(state), ['parent', 'child', 'last']);
  assert.equal(state.pages, original.pages);
  assert.equal(state.history.length, 0);
});

test('navigation skips hidden descendants in both directions and at page end', () => {
  let state = reduceOutlineState(initial(), { type: 'toggleFold' });
  state = reduceOutlineState(state, { type: 'moveFocus', direction: 1, extendSelection: false });
  assert.equal(state.focusedId, 'last');
  state = reduceOutlineState(state, { type: 'moveFocus', direction: -1, extendSelection: false });
  assert.equal(state.focusedId, 'parent');
  state = { ...state, pages: [{ ...state.pages[0], nodes: state.pages[0].nodes.slice(0, 3) }] };
  state = reduceOutlineState(state, { type: 'jumpFocus', position: 'end' });
  assert.equal(state.focusedId, 'parent');
});

test('opening a child for editing reveals it; directly focusing a hidden node reveals ancestors', () => {
  const folded = reduceOutlineState(initial(), { type: 'toggleFold' });
  const editing = reduceOutlineState(folded, { type: 'openBelow' });
  assert.ok(visible(editing).includes(editing.editingId!));
  const focused = reduceOutlineState(folded, { type: 'focus', nodeId: 'grandchild' });
  assert.ok(visible(focused).includes('grandchild'));
});

test('leaves and insert mode do not fold', () => {
  const state = initial();
  assert.equal(reduceOutlineState(state, { type: 'toggleFold', nodeId: 'last' }), state);
  const editing = reduceOutlineState(state, { type: 'startEditing' });
  assert.equal(reduceOutlineState(editing, { type: 'toggleFold' }), editing);
});
