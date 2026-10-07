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
    yankBuffer: null, documentHistory: {},
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
  assert.equal(Object.keys(state.documentHistory ?? {}).length, 0);
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

test('opening below a folded node inserts after its subtree and preserves the fold', () => {
  const folded = reduceOutlineState(initial(), { type: 'toggleFold' });
  const editing = reduceOutlineState(folded, { type: 'openBelow' });
  assert.deepEqual(editing.pages[0].nodes.map((node) => node.id), ['parent', 'child', 'grandchild', editing.editingId, 'last']);
  assert.equal(editing.pages[0].nodes[3].parentId, null);
  assert.deepEqual(editing.collapsedNodeIds, ['parent']);
  assert.deepEqual(visible(editing), ['parent', editing.editingId, 'last']);
});

test('splitting a folded node inserts after its subtree at the same nesting level', () => {
  let state = reduceOutlineState(initial(), { type: 'toggleFold', nodeId: 'child' });
  state = reduceOutlineState(state, { type: 'focus', nodeId: 'child' });
  state = reduceOutlineState(state, { type: 'startEditing' });
  state = reduceOutlineState(state, { type: 'splitNodeAtCursor', selectionStart: 5, selectionEnd: 5 });
  assert.deepEqual(state.pages[0].nodes.map((node) => node.id), ['parent', 'child', 'grandchild', state.editingId, 'last']);
  assert.equal(state.pages[0].nodes[3].parentId, 'parent');
  assert.deepEqual(state.collapsedNodeIds, ['child']);
  assert.deepEqual(visible(state), ['parent', 'child', state.editingId, 'last']);
});

test('directly focusing a hidden node reveals ancestors', () => {
  const folded = reduceOutlineState(initial(), { type: 'toggleFold' });
  const focused = reduceOutlineState(folded, { type: 'focus', nodeId: 'grandchild' });
  assert.ok(visible(focused).includes('grandchild'));
});

test('leaves and insert mode do not fold', () => {
  const state = initial();
  assert.equal(reduceOutlineState(state, { type: 'toggleFold', nodeId: 'last' }), state);
  const editing = reduceOutlineState(state, { type: 'startEditing' });
  assert.equal(reduceOutlineState(editing, { type: 'toggleFold' }), editing);
});
