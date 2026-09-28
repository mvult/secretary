import { normalizePageForSave, pageHash, validatePageForSave } from '../../app/pagePersistence';
import { BackendError, decimalRevision, normalizeDocument, postJsonBody } from '../../lib/backend';
import type { DraftRecord, DraftScope, SaveEnvelope } from '../../lib/draftStorage';
import { documentToOutlinePage } from '../outline/remote';
import type { OutlinePage } from '../outline/types';
import { isDraftDirty, isUntouchedJournalPlaceholder } from './draftReconciliation';
import { reconcileSavedPage } from './saveReconciliation';

export const draftId = (record: DraftRecord) => record.draftId ?? record.page.id;
const positiveRevision = (value: unknown) => value != null && decimalRevision(value) !== '0';
function databaseId(value: number | undefined, optional = false) {
  const id = value ?? 0;
  if (!Number.isSafeInteger(id) || id < (optional ? 0 : 1) || id > 2147483647) throw new Error('Invalid database identity.');
  return String(id);
}

export function assertVersionedPage(page: OutlinePage) {
  databaseId(page.backendId);
  databaseId(page.workspaceId);
  if (!positiveRevision(page.revision) || !page.clientKey?.trim()) throw new Error('A coherent versioned server snapshot is required.');
  const ids = new Set<number>();
  const keys = new Set<string>();
  const preceding = new Set<string>();
  for (const node of page.nodes) {
    databaseId(node.backendId);
    if (!node.clientKey?.trim() || keys.has(node.clientKey) || ids.has(node.backendId!) || (node.parentId && !preceding.has(node.parentId))) {
      throw new Error('The server returned invalid block identities or ordering.');
    }
    ids.add(node.backendId!); keys.add(node.clientKey); preceding.add(node.id);
  }
}

export function prepareSave(record: DraftRecord, scope: DraftScope): SaveEnvelope {
  if (record.pending || record.conflict || record.needsRefresh) throw new Error('Resolve or refresh this draft before saving.');
  const page = normalizePageForSave(record.page);
  const validation = validatePageForSave(page);
  if (validation) throw new Error(validation);
  const baseline = record.baseline;
  if (baseline) assertVersionedPage(baseline);
  if (page.backendId && !baseline) throw new Error('Refresh the server baseline before saving this draft.');
  if (baseline && baseline.workspaceId !== Number(scope[2])) throw new Error('The baseline belongs to another workspace.');
  if (page.workspaceId && page.workspaceId !== Number(scope[2])) throw new Error('The draft belongs to another workspace.');
  if (page.backendId && page.backendId !== baseline?.backendId) throw new Error('The draft and baseline identify different documents.');
  const byId = new Map(baseline?.nodes.map((node) => [node.backendId, node]));
  const byKey = new Map(baseline?.nodes.map((node) => [node.clientKey, node]));
  const submitted: OutlinePage = { ...page, workspaceId: Number(scope[2]), backendId: baseline?.backendId,
    clientKey: baseline?.clientKey ?? page.clientKey ?? page.id, revision: baseline?.revision,
    nodes: page.nodes.map((node) => {
      const known = node.backendId ? byId.get(node.backendId) : byKey.get(node.clientKey ?? node.id);
      if (node.backendId && !known) throw new Error('A block identity is no longer in the acknowledged baseline. Retain the draft for recovery.');
      return { ...node, backendId: known?.backendId, clientKey: known?.clientKey ?? node.clientKey ?? node.id };
    }) };
  const nodes = new Map(submitted.nodes.map((node) => [node.id, node]));
  const keys = new Set<string>();
  for (const node of submitted.nodes) {
    if (!node.clientKey?.trim() || keys.has(node.clientKey)) throw new Error('Duplicate or missing block identity.');
    keys.add(node.clientKey);
  }
  const mutationId = crypto.randomUUID();
  const body = JSON.stringify({ protocolVersion: 1, mutationId, expectedRevision: baseline?.revision ?? '0', document: {
    id: databaseId(submitted.backendId, true), clientKey: submitted.clientKey, workspaceId: scope[2],
    directoryId: databaseId(submitted.kind === 'note' ? submitted.directoryId ?? 0 : 0, true),
    kind: submitted.kind, title: submitted.kind === 'journal' ? submitted.title || submitted.date : submitted.title,
    journalDate: submitted.kind === 'journal' ? submitted.date : '',
    blocks: submitted.nodes.map((node, index) => {
      const parent = node.parentId ? nodes.get(node.parentId) : undefined;
      return { id: databaseId(node.backendId, true), clientKey: node.clientKey,
        parentBlockId: databaseId(parent?.backendId, true), parentClientKey: parent?.clientKey ?? '',
        sortOrder: index + 1, text: node.text, todoStatus: node.todoStatus ?? '' };
    }),
  } });
  return { version: 1, scope: [...scope], mutationId, body, submitted, generation: record.generation ?? 0,
    untouchedJournal: isUntouchedJournalPlaceholder(record) };
}

export interface SaveResult {
  page: OutlinePage;
  mutationId: string;
  outcome: 'applied' | 'existing-journal';
  effects: number[];
}

export interface DeleteResult { mutationId: string; effects: number[]; deleted: number[] }

export function prepareDelete(record: DraftRecord, scope: DraftScope): SaveEnvelope {
  if (isDraftDirty(record) || record.pending || record.envelope || record.conflict || record.needsRefresh) {
    throw new Error('Save and resolve pending edits before deleting this note.');
  }
  const baseline = record.baseline;
  if (!baseline || baseline.kind !== 'note') throw new Error('An acknowledged note is required for deletion.');
  assertVersionedPage(baseline);
  if (baseline.workspaceId !== Number(scope[2]) || record.page.backendId !== baseline.backendId) throw new Error('Delete scope or identity mismatch.');
  const mutationId = crypto.randomUUID();
  return { version: 2, operation: 'delete', scope: [...scope], mutationId,
    body: JSON.stringify({ protocolVersion: 1, mutationId, id: databaseId(baseline.backendId), workspaceId: scope[2], expectedRevision: baseline.revision }),
    submitted: structuredClone(record.page), generation: record.generation ?? 0, untouchedJournal: false };
}

export async function sendRetainedDelete(baseUrl: string, token: string, body: string): Promise<DeleteResult> {
  const response = await postJsonBody<{ mutationId?: string; effects?: {
    updatedDocuments?: { documentId: string | number }[]; deletedDocumentIds?: (string | number)[];
  } }>(baseUrl, '/secretary.v1.DocumentsService/DeleteDocument', body, token, AbortSignal.timeout(30000));
  if (!response.mutationId) throw new Error('Incomplete delete acknowledgment; the exact request is retained.');
  const ids = (values: (string | number)[]) => values.map((id) => { const value = Number(id); databaseId(value); return value; });
  const deleted = ids(response.effects?.deletedDocumentIds ?? []);
  return { mutationId: response.mutationId, deleted,
    effects: [...ids(response.effects?.updatedDocuments?.map((entry) => entry.documentId) ?? []), ...deleted] };
}

export async function sendRetainedSave(baseUrl: string, token: string, body: string): Promise<SaveResult> {
  const response = await postJsonBody<{ document?: unknown; mutationId?: string; outcome?: string | number;
    effects?: { updatedDocuments?: { documentId: string | number }[]; deletedDocumentIds?: (string | number)[] } }>(
    baseUrl, '/secretary.v1.DocumentsService/SaveDocument', body, token, AbortSignal.timeout(30000));
  const outcome = response.outcome === 1 || response.outcome === 'DOCUMENT_SAVE_OUTCOME_APPLIED' ? 'applied'
    : response.outcome === 2 || response.outcome === 'DOCUMENT_SAVE_OUTCOME_EXISTING_JOURNAL' ? 'existing-journal' : null;
  if (!response.document || !response.mutationId || !outcome) throw new Error('Incomplete save acknowledgment; the exact request is retained.');
  const page = documentToOutlinePage(normalizeDocument(response.document));
  assertVersionedPage(page);
  const effects = [...response.effects?.updatedDocuments?.map((entry) => entry.documentId) ?? [], ...response.effects?.deletedDocumentIds ?? []]
    .map((id) => { const value = Number(id); databaseId(value); return value; });
  return { page, mutationId: response.mutationId, outcome, effects };
}

interface Ports {
  scope: DraftScope;
  active(): boolean;
  canSend(): boolean;
  read(id: string): DraftRecord | undefined;
  change(id: string, update: (record: DraftRecord) => DraftRecord): void;
  persist(): Promise<void>;
  send(body: string): Promise<SaveResult>;
  sendDelete?(body: string): Promise<DeleteResult>;
  remove?(id: string): Promise<void>;
  getServer(id: number): Promise<OutlinePage | null>;
  effects(ids: number[], primary: number): Promise<void>;
  status(id: string, status: 'saving' | 'saved' | 'failed', message: string): void;
  failure(error: unknown): void;
}

/** Scope-owned, headless queue. Editor unmount/navigation does not own requests. */
export class DocumentSaveController {
  private inFlight = new Map<string, Promise<void>>();
  private running = 0;
  private waiting: (() => void)[] = [];
  constructor(private ports: Ports, private concurrency = 2) {}

  flush(id: string, force = false): Promise<void> {
    const existing = this.inFlight.get(id);
    if (existing) return existing;
    const promise = this.run(id, force).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, promise);
    return promise;
  }

  private async run(id: string, force: boolean) {
    if (this.running >= this.concurrency) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.running++;
    try { await this.save(id, force); }
    finally { const next = this.waiting.shift(); if (next) next(); else this.running--; }
  }

  private async save(id: string, force: boolean) {
    const p = this.ports;
    let record = p.read(id);
    if (!p.active() || !p.canSend() || !record || record.pending || record.conflict || (record.needsRefresh && !record.envelope)) return;
    if (!isDraftDirty(record)) return;
    if (!force && record.retry && (record.retry.attempts >= 3 || record.retry.nextAt > Date.now())) return;
    let envelope = record.envelope;
    const replaying = Boolean(envelope);
    let acknowledged = false;
    try {
      envelope ??= prepareSave(record, p.scope);
      if (JSON.stringify(envelope.scope) !== JSON.stringify(p.scope)) throw new Error('Retained request belongs to another scope.');
      const request = JSON.parse(envelope.body);
      if (envelope.version === 2 && envelope.operation === 'delete') {
        if (!p.sendDelete || !p.remove || request.protocolVersion !== 1 || request.mutationId !== envelope.mutationId
          || String(request.workspaceId) !== p.scope[2] || String(request.id) !== databaseId(envelope.submitted.backendId)
          || !positiveRevision(request.expectedRevision)) throw new Error('Invalid retained delete envelope.');
        await p.persist();
        if (!p.active() || !p.canSend()) return;
        p.status(id, 'saving', 'Deleting…');
        const result = await p.sendDelete(envelope.body);
        if (!p.active()) return;
        if (result.mutationId !== envelope.mutationId || !result.deleted.includes(envelope.submitted.backendId!)) {
          throw new Error('Delete acknowledgment does not match the retained request.');
        }
        // Keep the receipt replayable until related caches and local removal commit.
        await p.effects(result.effects, envelope.submitted.backendId!);
        if (!p.active()) return;
        const latest = p.read(id);
        if (!latest || latest.envelope?.mutationId !== envelope.mutationId) return;
        if ((latest.generation ?? 0) !== envelope.generation || pageHash(latest.page) !== pageHash(envelope.submitted)) {
          p.change(id, (current) => ({ ...current, envelope: undefined, retry: undefined, serverCopy: null,
            conflict: 'The note was deleted. Edits made after deletion was requested are retained; save a recovery copy.' }));
          await p.persist();
        } else await p.remove(id);
        return;
      }
      if (envelope.version !== 1 || envelope.operation) throw new Error('Unsupported retained request protocol.');
      if (request.protocolVersion !== 1 || request.mutationId !== envelope.mutationId || String(request.document?.workspaceId) !== p.scope[2]
        || request.document?.clientKey !== envelope.submitted.clientKey) throw new Error('Invalid retained save envelope.');
      decimalRevision(request.expectedRevision);
      const retained = envelope;
      p.change(id, (current) => ({ ...current, draftId: current.draftId ?? id, envelope: retained }));
      // Both first send and replay pass the durability/CAS barrier.
      await p.persist();
      if (!p.active() || !p.canSend()) return;
      p.status(id, 'saving', 'Saving…');
      const result = await p.send(envelope.body);
      if (!p.active()) return;
      record = p.read(id);
      if (!record || record.envelope?.mutationId !== envelope.mutationId) return;
      if (result.mutationId !== envelope.mutationId || result.page.workspaceId !== Number(p.scope[2])) throw new Error('Save acknowledgment does not match the retained request.');
      assertVersionedPage(result.page);
      if (result.outcome === 'existing-journal') {
        if (envelope.submitted.kind !== 'journal' || envelope.submitted.backendId || result.page.kind !== 'journal' || result.page.date !== envelope.submitted.date) {
          throw new Error('Invalid existing-journal acknowledgment.');
        }
        if (!envelope.untouchedJournal || (record.generation ?? 0) !== envelope.generation || record.placeholderHash !== pageHash(record.page)) {
          p.change(id, (current) => ({ ...current, envelope: undefined, retry: undefined,
            needsRefresh: false, conflict: 'A journal already exists for this date. Your local draft has been retained.', serverCopy: result.page }));
        } else {
          p.change(id, (current) => ({ ...current, page: result.page, baseline: result.page, savedHash: pageHash(result.page),
            acknowledgedGeneration: retained.generation, envelope: undefined, retry: undefined, needsRefresh: false }));
        }
      } else {
        if (result.page.clientKey !== envelope.submitted.clientKey || (envelope.submitted.backendId && result.page.backendId !== envelope.submitted.backendId)) {
          throw new Error('Save acknowledgment changed the document identity.');
        }
        if (BigInt(result.page.revision!) !== BigInt(request.expectedRevision) + 1n) throw new Error('Invalid acknowledged document revision.');
        if (result.page.nodes.length !== envelope.submitted.nodes.length || envelope.submitted.nodes.some((node) =>
          !result.page.nodes.some((saved) => saved.clientKey === node.clientKey && (!node.backendId || saved.backendId === node.backendId)))) {
          throw new Error('Save acknowledgment is missing or changed a block identity.');
        }
        const reconciled = reconcileSavedPage(envelope.submitted, normalizePageForSave(record.page), result.page);
        p.change(id, (current) => ({ ...current, page: reconciled.page, baseline: result.page, savedHash: reconciled.savedHash,
          acknowledgedGeneration: retained.generation, envelope: undefined, retry: undefined, conflict: undefined, serverCopy: undefined, placeholderHash: undefined, needsRefresh: false }));
      }
      await p.persist();
      if (!p.active()) return;
      acknowledged = true;
      const conflict = p.read(id)?.conflict;
      p.status(id, conflict ? 'failed' : 'saved', conflict ?? 'Saved');
      if (replaying) {
        // A receipt acknowledges history, not present-day existence/content.
        // Verify the live document before allowing newer edits to follow it.
        p.change(id, (current) => ({ ...current, needsRefresh: true }));
        await p.persist();
        const live = await p.getServer(result.page.backendId!);
        if (!p.active()) return;
        p.change(id, (current) => ({ ...current, needsRefresh: false,
          conflict: !live || live.revision !== result.page.revision ? 'The server changed after this save committed. Your draft has been retained.' : current.conflict,
          serverCopy: !live || live.revision !== result.page.revision ? live : current.serverCopy }));
        await p.persist();
      }
      await p.effects(result.effects, result.page.backendId!);
    } catch (error) {
      if (!p.active()) return;
      const text = error instanceof Error ? error.message : 'Save failed.';
      const auth = error instanceof BackendError && [401, 403].includes(error.status);
      const definite = error instanceof BackendError && !auth && (
        ['aborted', 'invalid_argument', 'not_found', 'already_exists', 'failed_precondition', 'out_of_range', 'unimplemented'].includes(error.code ?? '')
        || (!error.code && [400, 404, 409, 412, 422].includes(error.status)));
      // Storage or transport failure never discards an exact request. Even an
      // acknowledgment whose local commit failed is resolved through replay.
      p.change(id, (current) => ({ ...current, envelope: acknowledged ? current.envelope : envelope,
        conflict: definite || !envelope ? text : current.conflict,
        retry: { attempts: force ? 1 : (current.retry?.attempts ?? 0) + 1,
          nextAt: Date.now() + Math.min(60000, 10000 * 2 ** Math.min(current.retry?.attempts ?? 0, 3)), message: text } }));
      if (definite && envelope?.submitted.backendId) {
        try {
          const serverCopy = await p.getServer(envelope.submitted.backendId);
          if (p.active()) p.change(id, (current) => ({ ...current, serverCopy }));
        } catch { /* Draft and conflict remain even if comparison is unavailable. */ }
      }
      if (!p.active()) return;
      await p.persist().catch(() => undefined);
      p.status(id, 'failed', text);
      p.failure(error);
    }
  }
}
