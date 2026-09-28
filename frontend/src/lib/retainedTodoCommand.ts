import { Todo, TodoPatch, TodoStatus, CreateTodoRequest, DeleteTodoRequest, UpdateTodoRequest, CreateTodoResponse, DeleteTodoResponse, UpdateTodoResponse } from '@secretary/api/gen/todos_pb';

export function todoEditPatch(todo: Todo, edit: { name: string; desc: string; status: TodoStatus }) {
  return new TodoPatch({
    name: edit.name !== todo.name ? edit.name : undefined,
    desc: edit.desc !== todo.desc ? edit.desc : undefined,
    status: edit.status !== todo.status ? edit.status : undefined,
  });
}

export type TodoCommand =
  | { operation: 'create'; request: CreateTodoRequest }
  | { operation: 'update'; request: UpdateTodoRequest }
  | { operation: 'delete'; request: DeleteTodoRequest };

export class MissingTodoCommandTarget extends Error {}

export interface RetainedUpdateIO {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  key: string;
  checkScope: () => void;
  send: (bytes: string, operation: TodoCommand['operation']) => Promise<CreateTodoResponse | UpdateTodoResponse | DeleteTodoResponse>;
  refresh: () => Promise<void>;
}

// Caller holds an exclusive cross-tab lock for this account/backend scope.
// The saved protobuf JSON is the transport body, not a recipe for a new request.
export async function retainedTodoCommand(io: RetainedUpdateIO, command?: TodoCommand) {
  io.checkScope();
  let stored = io.storage.getItem(io.key);
  if (command) {
    if (stored) throw new Error('Recover the retained TODO command before starting another.');
    stored = JSON.stringify({ operation: command.operation, bytes: command.request.toJsonString() });
    io.storage.setItem(io.key, stored);
  }
  if (!stored) return;
  const { operation, bytes } = JSON.parse(stored);
  const type = { create: CreateTodoRequest, update: UpdateTodoRequest, delete: DeleteTodoRequest }[operation as TodoCommand['operation']];
  if (!type || typeof bytes !== 'string') throw new Error('Invalid retained TODO command; request preserved.');
  const envelope = type.fromJsonString(bytes);
  if (envelope.protocolVersion !== 1 || !envelope.mutationId || ('id' in envelope && envelope.id <= 0n)) {
    throw new Error('Invalid retained TODO command; the stored request has been preserved.');
  }
  io.checkScope();
  let result;
  let rejection: MissingTodoCommandTarget | undefined;
  try { result = await io.send(bytes, operation); }
  catch (err) {
    // The server looks up receipts before targets. A typed missing target is
    // a definitive rejection, but still requires live reconciliation.
    if (!(err instanceof MissingTodoCommandTarget)) throw err;
    rejection = err;
  }
  io.checkScope();
  if (!rejection && (!result || result.mutationId !== envelope.mutationId || !result.effects ||
    (operation !== 'delete' && (!('todo' in result) || !result.todo || result.todo.id <= 0n || ('id' in envelope && result.todo.id !== envelope.id))))) {
    throw new Error('Invalid TODO acknowledgment; retry the retained request.');
  }
  // A receipt can describe old state. Reconcile live queries before releasing it.
  await io.refresh();
  io.checkScope();
  if (io.storage.getItem(io.key) !== stored) throw new Error('Retained TODO request changed during recovery.');
  io.storage.removeItem(io.key);
  if (rejection) throw rejection;
  return { operation: operation as TodoCommand['operation'], mutationId: envelope.mutationId };
}
