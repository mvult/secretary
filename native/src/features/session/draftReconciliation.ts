import { pageHash, findPageForPersistence, pagePersistenceKey } from '../../app/pagePersistence';
import type { DraftRecord } from '../../lib/draftStorage';
import type { OutlinePage } from '../outline/types';

export function isDraftDirty(record: DraftRecord) {
  return Boolean(record.envelope || record.pending || record.conflict || (record.acknowledgedGeneration !== undefined
    ? (record.generation ?? 0) !== record.acknowledgedGeneration : pageHash(record.page) !== record.savedHash));
}

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
    // Resolve the exact retained request before interpreting a newer server
    // snapshot. A lost create response must not become a second create.
    if (record.envelope) return [{ ...record, serverCopy: match ?? null }];
    const dirty = isDraftDirty(record);
    if (!dirty || (match && isUntouchedJournalPlaceholder(record))) {
      return match ? [{ draftId: record.draftId, generation: record.generation, lastAccessedAt: record.lastAccessedAt,
        acknowledgedGeneration: match.revision && match.revision !== '0' ? record.generation ?? 0 : undefined,
        page: match, baseline: match, savedHash: pageHash(match) }] : [];
    }
    let conflict = record.conflict;
    if (record.pending) conflict = 'The previous save may have committed. Automatic retries are paused until you compare the server copy.';
    else if (record.page.backendId && (!match || !record.baseline || serverContent(match) !== serverContent(record.baseline)
      || (record.baseline.revision && record.baseline.revision !== '0' && record.baseline.revision !== match.revision))) {
      conflict = match ? 'The server copy changed. Your local draft has been retained.' : 'The server copy was deleted. Your local draft has been retained.';
    } else if (!record.page.backendId && match) {
      conflict = 'A journal already exists for this date. Your local draft has been retained.';
    }
    if (!conflict && match && match.revision && match.revision !== '0') {
      return [{ ...record, page: adoptSnapshotIdentity(record.page, match), baseline: match, needsRefresh: false, retry: undefined }];
    }
    return [{ ...record, conflict, needsRefresh: !conflict && match ? false : record.needsRefresh, serverCopy: conflict ? match ?? null : undefined }];
  });
  return [...merged, ...[...remaining].map((page) => ({ page, baseline: page, savedHash: pageHash(page), generation: 0,
    acknowledgedGeneration: page.revision && page.revision !== '0' ? 0 : undefined }))];
}

export function isBlankJournal(page: OutlinePage) {
  return page.kind === 'journal' && (!page.title || page.title === page.date)
    && !page.directoryId && page.nodes.every((node) => !node.text.trim() && !node.todoStatus && !node.todoId && !node.backendId);
}

export function isUntouchedJournalPlaceholder(record: DraftRecord) {
  return !record.page.backendId && !record.baseline && !record.savedHash && !record.pending && !record.envelope
    && record.placeholderHash === pageHash(record.page) && isBlankJournal(record.page);
}

/** Observe every edit, so typing then deleting text cannot turn a draft back into a placeholder. */
export function trackDrafts(records: DraftRecord[], pages: OutlinePage[], markNewPlaceholders = false): DraftRecord[] {
  const retained = new Set(records.filter((record) => record.envelope || record.pending || record.conflict));
  const byKey = new Map(records.map(record => [pagePersistenceKey(record.page), record]));
  const byId = new Map(records.map(record => [record.draftId, record]));
  const tracked = pages.map((page) => {
    if (page.metadataOnly) throw new Error('Document index entries cannot become drafts.');
    const prior = byKey.get(pagePersistenceKey(page)) ?? byId.get(page.id);
    if (prior) retained.delete(prior);
    if (prior?.page === page) return prior;
    const placeholderHash = prior
      ? prior.placeholderHash === pageHash(page) ? prior.placeholderHash : undefined
      : markNewPlaceholders && !page.backendId && isBlankJournal(page) ? pageHash(page) : undefined;
    return { ...prior, page, placeholderHash, draftId: prior?.draftId ?? page.id,
      generation: (prior?.generation ?? 0) + (prior && pageHash(prior.page) !== pageHash(page) ? 1 : 0) };
  });
  // Navigation/old whole-workspace undo must never discard requests or recovery drafts.
  return [...tracked, ...retained];
}

/** Only server IDs establish identity during initial legacy -> v1 adoption. */
export function adoptSnapshotIdentity(page: OutlinePage, baseline: OutlinePage): OutlinePage {
  const byId = new Map(baseline.nodes.map((node) => [node.backendId, node]));
  return { ...page, backendId: baseline.backendId, clientKey: baseline.clientKey, revision: baseline.revision,
    nodes: page.nodes.map((node) => node.backendId && byId.has(node.backendId)
      ? { ...node, clientKey: byId.get(node.backendId)!.clientKey } : node) };
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
