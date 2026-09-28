import { BackendError, getDocument, listDocumentIndex, type DocumentMetadata, type BackendDocument } from '../../lib/backend';
import type { DraftRecord } from '../../lib/draftStorage';
import { documentToOutlinePage } from '../outline/remote';
import type { OutlinePage } from '../outline/types';
import { getCurrentJournalDate, getDateKey } from '../outline/sampleData';

/** UI-only metadata projection. Never pass these entries to hydration/persistence. */
export function indexPage(entry: DocumentMetadata): OutlinePage {
  return { ...documentToOutlinePage({ ...entry, blocks: [] }), metadataOnly: true };
}

export function navigationPages(index: DocumentMetadata[], loaded: OutlinePage[]) {
  const ids = new Set(loaded.map(page => page.backendId));
  const keys = new Set(loaded.map(page => page.clientKey));
  return [...loaded, ...index.filter(entry => !ids.has(entry.id) && !keys.has(entry.clientKey)).map(indexPage)];
}

export async function readDocumentIndex(baseUrl: string, token: string, workspaceId: number, active: () => boolean, query = '') {
  const entries: DocumentMetadata[] = [];
  let before = 0;
  let first: Awaited<ReturnType<typeof listDocumentIndex>> | undefined;
  do {
    const page = await listDocumentIndex(baseUrl, token, workspaceId, before, query);
    if (!active()) throw new Error('Document index scope changed.');
    if (page.persistenceProtocolVersion !== 1) throw new Error('Document index requires persistence protocol one.');
    if (page.entries.some(entry => entry.workspaceId !== workspaceId || !entry.revision || entry.revision === '0' || !entry.clientKey)) throw new Error('Invalid document index identity.');
    if (page.entries.some((entry, i) => entry.id <= 0 || (i ? entry.id >= page.entries[i - 1].id : before !== 0 && entry.id >= before))) throw new Error('Invalid document index ordering.');
    if (page.nextBeforeId && (!page.entries.length || page.nextBeforeId !== page.entries[page.entries.length - 1].id)) throw new Error('Invalid document index cursor.');
    first ??= page;
    entries.push(...page.entries);
    before = page.nextBeforeId;
  } while (before);
  return { entries, directories: first!.directories, persistenceProtocolVersion: 1 };
}

/** Refresh only loaded/recovery bodies; absence from a paged index never proves deletion. */
export async function loadIndexedWorkspace(baseUrl: string, token: string, workspaceId: number,
  records: () => DraftRecord[], active: () => boolean) {
  const index = await readDocumentIndex(baseUrl, token, workspaceId, active);
  const byId = new Map(index.entries.map(entry => [entry.id, entry]));
  const byKey = new Map(index.entries.map(entry => [entry.clientKey, entry]));
  const byDate = new Map(index.entries.filter(entry => entry.kind === 'journal').map(entry => [entry.journalDate, entry]));
  const local = records();
  const ids = new Set(local.flatMap(record => record.page.backendId ? [record.page.backendId] : []));
  const journals = index.entries.filter(entry => entry.kind === 'journal').sort((a, b) => b.journalDate.localeCompare(a.journalDate));
  // A small journal window for startup; all other bodies load on navigation.
  for (const entry of journals.slice(0, 3)) ids.add(entry.id);
  const today = journals.find(entry => entry.journalDate === getDateKey(getCurrentJournalDate()));
  if (today) ids.add(today.id);
  for (const record of local) {
    const match = byKey.get(record.page.clientKey || record.page.id)
      ?? (record.page.kind === 'journal' ? byDate.get(record.page.date) : undefined);
    if (match) ids.add(match.id);
  }
  if (!ids.size && index.entries[0]) ids.add(index.entries[0].id);
  const documents: BackendDocument[] = [];
  const unchangedPages: OutlinePage[] = [];
  // The revision contract lets us reuse a complete baseline, never metadata as
  // a body. Requests, legacy uncertainty and explicit invalidations always read live.
  for (const record of local) {
    const baseline = record.baseline;
    const entry = byId.get(record.page.backendId ?? 0);
    if (baseline?.backendId && baseline.revision && baseline.revision !== '0' && !baseline.metadataOnly
      && entry?.id === baseline.backendId && entry.clientKey === baseline.clientKey && entry.revision === baseline.revision
      && !record.envelope && !record.pending && !record.needsRefresh && !record.conflict) {
      if (ids.delete(baseline.backendId)) unchangedPages.push(baseline);
    }
  }
  // Bounded concurrency; never start one request per workspace document at once.
  const queue = [...ids];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length && active()) {
      const id = queue.shift()!;
      try {
        const doc = await getDocument(baseUrl, token, id);
        if (!active()) return;
        if (doc.id !== id || doc.workspaceId !== workspaceId) throw new Error('Document identity does not match the requested workspace.');
        documents.push(doc);
      } catch (error) {
        if (!(error instanceof BackendError && error.status === 404 && error.code === 'not_found')) throw error;
      }
    }
  }));
  if (!active()) throw new Error('Document loading scope changed.');
  return { ...index, documents, unchangedPages };
}
