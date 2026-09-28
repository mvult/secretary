import { decimalRevision, postJsonBody, todoStatusToProto, type BackendTodo, type TodoPatch } from '../../lib/backend';
import type { DraftScope, TodoCommandEnvelope } from '../../lib/draftStorage';

function databaseId(value: unknown) {
  if (!/^[1-9]\d*$/.test(String(value)) || Number(value) > 2147483647) throw new Error('Invalid command database identity.');
  return String(value);
}

function journalDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new Error('Invalid server journal date.');
  }
  return value;
}

export async function getCommandDate(baseUrl: string, token: string, workspace: string) {
  const response = await postJsonBody<{ journalDate?: string }>(baseUrl, '/secretary.v1.TodosService/GetTodoCommandContext',
    JSON.stringify({ workspaceId: databaseId(workspace) }), token, AbortSignal.timeout(30000));
  return journalDate(response.journalDate);
}

export function prepareTodoCommand(scope: DraftScope, operation: 'repository' | 'pull', target: number | string): TodoCommandEnvelope {
  const mutationId = crypto.randomUUID();
  const payload = operation === 'repository' ? { documentId: databaseId(target) } : { journalDate: journalDate(target) };
  return { version: 1, operation, scope: [...scope], mutationId,
    body: JSON.stringify({ protocolVersion: 1, mutationId, workspaceId: databaseId(scope[2]), ...payload }) };
}

export function prepareTodoUpdate(scope: DraftScope, todo: BackendTodo, patch: TodoPatch): TodoCommandEnvelope {
  if (todo.workspaceId && String(todo.workspaceId) !== scope[2]) throw new Error('Open the TODO workspace before updating it.');
  if (!todo.workspaceId && (String(todo.userId) !== scope[1] || todo.currentDocumentId)) throw new Error('Refresh the TODO scope before updating it.');
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (['name', 'desc', 'bucket', 'deadlineDate'].includes(key)) {
      if (typeof value !== 'string') throw new Error('Invalid TODO text field.');
      if (key === 'name' && !value.trim()) throw new Error('A TODO name is required.');
      if (key === 'deadlineDate' && value) journalDate(value);
      if (key === 'bucket' && !['', 'inbox', 'on_deck', 'blocked', 'done'].includes(value)) throw new Error('Invalid TODO bucket.');
      fields[key] = value;
    } else if (key === 'status') {
      if (!['todo', 'doing', 'done', 'blocked', 'skipped'].includes(String(value))) throw new Error('Invalid TODO status.');
      fields.status = todoStatusToProto(value as BackendTodo['status']);
    } else if (key === 'goalId' || key === 'priorityRank') {
      fields[key] = value === 0 ? '0' : databaseId(value);
    } else throw new Error(`Unsupported TODO patch field: ${key}`);
  }
  if (!Object.keys(fields).length) throw new Error('Empty TODO patch.');
  const mutationId = crypto.randomUUID();
  return { version: 2, operation: 'update', scope: [...scope], mutationId,
    body: JSON.stringify({ protocolVersion: 1, mutationId, workspaceId: todo.workspaceId ? databaseId(todo.workspaceId) : '0', id: databaseId(todo.id), patch: fields }) };
}

export async function sendTodoCommand(baseUrl: string, token: string, scope: DraftScope, envelope: TodoCommandEnvelope) {
  const request = JSON.parse(envelope.body);
  const update = envelope.version === 2 && envelope.operation === 'update';
  if (!(update || (envelope.version === 1 && ['repository', 'pull'].includes(envelope.operation)))
    || JSON.stringify(envelope.scope) !== JSON.stringify(scope) || request.protocolVersion !== 1
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(envelope.mutationId)
    || request.mutationId !== envelope.mutationId || (request.workspaceId !== databaseId(scope[2]) && !(update && request.workspaceId === '0'))) {
    throw new Error('Invalid retained command scope or identity.');
  }
  if (update) {
    databaseId(request.id);
    if (!request.patch || !Object.keys(request.patch).length) throw new Error('Invalid retained TODO patch.');
  } else if (envelope.operation === 'repository') databaseId(request.documentId); else journalDate(request.journalDate);
  const method = update ? 'UpdateTodo' : envelope.operation === 'repository' ? 'MoveDocumentTodosToRepository' : 'PullOnDeckTodosToToday';
  const response = await postJsonBody<{ mutationId?: string; todo?: { id?: string | number }; movedCount?: number; pulledCount?: number; documentId?: string | number;
    effects?: { updatedDocuments?: { documentId: string | number; revision: string | number }[]; deletedDocumentIds?: (string | number)[] } }>(
    baseUrl, `/secretary.v1.TodosService/${method}`, envelope.body, token, AbortSignal.timeout(30000));
  if (response.mutationId !== envelope.mutationId || !response.effects) throw new Error('Incomplete command acknowledgment; exact request retained.');
  if (update && databaseId(response.todo?.id) !== String(request.id)) throw new Error('Wrong TODO acknowledgment; exact request retained.');
  // Bodies are refreshed from live reads, never reconstructed from a historical receipt.
  for (const entry of response.effects.updatedDocuments ?? []) {
    databaseId(entry.documentId);
    if (decimalRevision(entry.revision) === '0') throw new Error('Invalid effect revision.');
  }
  for (const id of response.effects.deletedDocumentIds ?? []) databaseId(id);
  const count = (envelope.operation === 'repository' ? response.movedCount : response.pulledCount) ?? 0;
  if (!Number.isInteger(count) || count < 0 || count > 2147483647) throw new Error('Invalid command count.');
  return { movedCount: count, pulledCount: count, documentId: envelope.operation === 'pull' ? Number(databaseId(response.documentId)) : 0 };
}
