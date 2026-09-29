import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { JournalsView } from '../src/features/journals/JournalsView';
import { DraftConflictReview } from '../src/features/session/DraftConflicts';
import { mergeWorkspace } from '../src/features/session/draftReconciliation';
import type { OutlinePage, OutlineState } from '../src/features/outline/types';

test('a blank journal has adjacent review controls exposing the populated server copy', () => {
  const local: OutlinePage = { id: 'local-today', kind: 'journal', title: '2026-09-23', date: '2026-09-23',
    nodes: [{ id: 'blank', parentId: null, text: '' }] };
  const server: OutlinePage = { ...local, id: 'document-225', backendId: 225,
    nodes: [{ id: 'block-1', backendId: 1, parentId: null, text: 'Long server journal content remains accessible.' }] };
  const [record] = mergeWorkspace([{ page: local }], [server]);
  const older: OutlinePage = { ...local, id: 'yesterday', date: '2026-09-22', nodes: [{ id: 'old', parentId: null, text: 'Older journal content' }] };
  const state: OutlineState = { pages: [local, older], activePageId: local.id, activeView: 'journals', focusedId: 'blank',
    normalCursor: 0, anchorId: null, editingId: null, draftText: '', editCursor: 'end', mode: 'normal', yankBuffer: null, documentHistory: {} };
  const html = renderToStaticMarkup(<JournalsView journals={state.pages} journalPage={local} state={state}
    dispatch={() => undefined} pagesByBackendId={new Map()} activePageSaveMessage="Retained locally · conflict"
    onSelectJournalPage={() => undefined} onOpenDocumentLinkPicker={() => undefined}
    onFollowDocumentLink={() => undefined} onOpenDocumentLink={() => undefined}
    renderConflict={(page) => page.id === local.id ? <DraftConflictReview record={record}
      backendUrl="https://example.com" token="token" onResolve={async () => undefined} /> : null} />);

  const firstArticle = html.slice(html.indexOf('<article'), html.indexOf('</article>'));
  assert.match(firstArticle, /<summary>Review conflict<\/summary>/);
  assert.match(firstArticle, /Blank local draft/);
  assert.match(firstArticle, /Long server journal content remains accessible/);
  assert.match(firstArticle, /document 225/);
  const reloadButton = firstArticle.match(/<button[^>]*>Use server copy and discard local draft<\/button>/)?.[0];
  assert.ok(reloadButton);
  assert.equal(reloadButton.includes('disabled'), false);
  assert.ok(html.indexOf('Review conflict') < html.indexOf('Older journal content'));
  assert.equal(html.includes('review below'), false);
});
