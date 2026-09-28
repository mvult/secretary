import type { OutlinePage } from '../features/outline/types';
import type { BackendDirectory } from './backend';

export type DraftScope = [backend: string, user: string, workspace: string];
export type DraftRecord = {
  page: OutlinePage;
  draftId?: string;
  generation?: number;
  acknowledgedGeneration?: number;
  envelope?: SaveEnvelope;
  retry?: { attempts: number; nextAt: number; message: string };
  needsRefresh?: boolean;
  baseline?: OutlinePage;
  savedHash?: string;
  pending?: boolean;
  conflict?: string;
  serverCopy?: OutlinePage | null;
  // Set only when the editor generates a journal; permanently cleared on editing.
  placeholderHash?: string;
};
export type SaveEnvelope = {
  // v2 adds online deletion; v1 remains an exact snapshot-save request.
  version: 1 | 2;
  operation?: 'delete';
  scope: DraftScope;
  mutationId: string;
  body: string;
  submitted: OutlinePage;
  generation: number;
  untouchedJournal: boolean;
};
export type TodoCommandEnvelope = {
  version: 1 | 2;
  operation: 'repository' | 'pull' | 'update';
  scope: DraftScope;
  mutationId: string;
  body: string;
};
export type LocalWorkspace = { records: DraftRecord[]; directories: BackendDirectory[]; command?: TodoCommandEnvelope };

export function backendIdentity(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Backend URL must be an HTTP(S) URL without credentials, query, or fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

export function draftScope(backend: string, user: number, workspace: number): DraftScope {
  if (!Number.isSafeInteger(user) || user <= 0 || !Number.isSafeInteger(workspace) || workspace <= 0) {
    throw new Error('A valid account and workspace are required for local drafts.');
  }
  return [backendIdentity(backend), String(user), String(workspace)];
}

function completed(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Local draft transaction was aborted.'));
    tx.onerror = () => reject(tx.error ?? new Error('Local draft storage failed.'));
  });
}

function result<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// No destructive upgrade fallback: a failed/open-newer database stays intact.
export function openDraftDatabase(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open('secretary-drafts', 5);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('workspaces')) request.result.createObjectStore('workspaces');
      if (!request.result.objectStoreNames.contains('drafts')) request.result.createObjectStore('drafts');
      if (!request.result.objectStoreNames.contains('recovery')) request.result.createObjectStore('recovery', { autoIncrement: true });
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close other Secretary windows to open local draft storage.'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

/** One instance per restored scope. Writes are ordered and use a cross-window CAS. */
export class DraftStorage {
  private revision = 0;
  private keys: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(private db: IDBDatabase, readonly scope: DraftScope) {}

  async load(): Promise<LocalWorkspace> {
    const tx = this.db.transaction(['workspaces', 'drafts'], 'readonly');
    const done = completed(tx);
    const metaRequest = result(tx.objectStore('workspaces').get(this.scope));
    const recordsRequest = result(tx.objectStore('drafts').getAll(IDBKeyRange.bound([...this.scope, ''], [...this.scope, '\uffff'])));
    const [meta, records] = await Promise.all([metaRequest, recordsRequest, done]);
    if (meta && ![1, 2, 3, 4, 5].includes(meta.schemaVersion)) throw new Error('Unsupported local draft format; retained data was not changed.');
    if (meta?.command && !((meta.command.version === 1 && ['repository', 'pull'].includes(meta.command.operation)) || (meta.command.version === 2 && meta.command.operation === 'update'))) {
      throw new Error('Unsupported retained command; retained data was not changed.');
    }
    if (records.some((record: DraftRecord) => record.envelope && !(
      (record.envelope.version === 1 && !record.envelope.operation) || (record.envelope.version === 2 && record.envelope.operation === 'delete')))) {
      throw new Error('Unsupported retained save request; retained data was not changed.');
    }
    this.revision = meta?.revision ?? 0;
    this.keys = records.map((record: DraftRecord) => record.page.id);
    this.loaded = true;
    return { records, directories: meta?.directories ?? [], command: meta?.command };
  }

  save(workspace: LocalWorkspace): Promise<void> {
    // Capture at enqueue time, not when the previous transaction finishes.
    const snapshot = structuredClone(workspace);
    const write = this.queue.then(() => this.write(snapshot));
    this.queue = write.catch(() => undefined);
    return write;
  }

  private async write(workspace: LocalWorkspace) {
    if (!this.loaded) throw new Error('Restore local drafts before writing them.');
    const tx = this.db.transaction(['workspaces', 'drafts', 'recovery'], 'readwrite');
    const done = completed(tx);
    let conflict = false;
    const metadata = tx.objectStore('workspaces');
    const request = metadata.get(this.scope);
    request.onsuccess = () => {
      if ((request.result?.revision ?? 0) !== this.revision) {
        conflict = true;
        tx.objectStore('recovery').add({ scope: this.scope, workspace, retainedAt: Date.now() });
        return;
      }
      const store = tx.objectStore('drafts');
      const keys = new Set(workspace.records.map((record) => record.page.id));
      for (const key of this.keys) if (!keys.has(key)) store.delete([...this.scope, key]);
      for (const record of workspace.records) store.put(record, [...this.scope, record.page.id]);
      metadata.put({ schemaVersion: 5, revision: this.revision + 1, directories: workspace.directories, command: workspace.command }, this.scope);
    };
    await done;
    if (conflict) throw new Error('Another window changed these drafts. This window’s snapshot was retained in local recovery storage; keep it open and resolve the other window before continuing.');
    this.revision++;
    this.keys = workspace.records.map((record) => record.page.id);
  }
}
