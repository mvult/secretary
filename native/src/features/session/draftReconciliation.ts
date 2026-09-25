import { pageHash, findPageForPersistence, pagePersistenceKey } from '../../app/pagePersistence';
import type { DraftRecord } from '../../lib/draftStorage';
import type { OutlinePage } from '../outline/types';

// Ignore editor-local IDs and timestamps when comparing a saved baseline to a reload.
export function serverContent(page: OutlinePage) {
  const indices = new Map(page.nodes.map((node, index) => [node.id, index]));
  return JSON.stringify({
    backendId: page.backendId, kind: page.kind, title: page.title,
    date: page.kind === 'journal' ? page.date : '', directoryId: page.directoryId ?? 0,
    nodes: page.nodes.map((node) => ({
      backendId: node.backendId, parent: node.parentId ? indices.get(node.parentId) : null,
      text: node.text, status: node.todoStatus || '', todoId: node.todoId || 0,
    })),
  });
}

export function mergeWorkspace(records: DraftRecord[], remote: OutlinePage[]): DraftRecord[] {
  const remaining = new Set(remote);
  const merged = records.flatMap<DraftRecord>((record) => {
    const match = findPageForPersistence(remote, record.page);
    if (match) remaining.delete(match);
    const dirty = pageHash(record.page) !== record.savedHash || record.pending || record.conflict;
    if (!dirty || (match && isUntouchedJournalPlaceholder(record))) {
      return match ? [{ page: match, baseline: match, savedHash: pageHash(match) }] : [];
    }
    let conflict = record.conflict;
    if (record.pending) conflict = 'The previous save may have committed. Automatic retries are paused until you compare the server copy.';
    else if (record.page.backendId && (!match || !record.baseline || serverContent(match) !== serverContent(record.baseline))) {
      conflict = match ? 'The server copy changed. Your local draft has been retained.' : 'The server copy was deleted. Your local draft has been retained.';
    } else if (!record.page.backendId && match) {
      conflict = 'A journal already exists for this date. Your local draft has been retained.';
    }
    return [{ ...record, conflict, serverCopy: conflict ? match ?? null : undefined }];
  });
  return [...merged, ...[...remaining].map((page) => ({ page, baseline: page, savedHash: pageHash(page) }))];
}

export function isBlankJournal(page: OutlinePage) {
  return page.kind === 'journal' && (!page.title || page.title === page.date)
    && !page.directoryId && page.nodes.every((node) => !node.text.trim() && !node.todoStatus && !node.todoId && !node.backendId);
}

export function isUntouchedJournalPlaceholder(record: DraftRecord) {
  return !record.page.backendId && !record.baseline && !record.savedHash && !record.pending
    && record.placeholderHash === pageHash(record.page) && isBlankJournal(record.page);
}

/** Observe every edit, so typing then deleting text cannot turn a draft back into a placeholder. */
export function trackDrafts(records: DraftRecord[], pages: OutlinePage[], markNewPlaceholders = false): DraftRecord[] {
  return pages.map((page) => {
    const prior = records.find((entry) => pagePersistenceKey(entry.page) === pagePersistenceKey(page));
    const placeholderHash = prior
      ? prior.placeholderHash === pageHash(page) ? prior.placeholderHash : undefined
      : markNewPlaceholders && !page.backendId && isBlankJournal(page) ? pageHash(page) : undefined;
    return { ...prior, page, placeholderHash };
  });
}

export function draftConflicts(records: DraftRecord[], saving: boolean): DraftRecord[] {
  return records.filter((record) => record.conflict || (record.pending && !saving)).map((record) => ({
    ...record,
    conflict: record.conflict || 'The previous save may have committed. Compare the server copy before retrying.',
  }));
}

export function recoveryCopy(page: OutlinePage): OutlinePage {
  const ids = new Map(page.nodes.map((node) => [node.id, crypto.randomUUID()]));
  return {
    id: crypto.randomUUID(), kind: 'note', date: page.date, title: `${page.title || page.date} (recovered)`,
    workspaceId: page.workspaceId, directoryId: null,
    nodes: page.nodes.map((node) => ({
      id: ids.get(node.id)!, parentId: node.parentId ? ids.get(node.parentId) ?? null : null,
      text: node.text, todoStatus: node.todoStatus,
    })),
  };
}
