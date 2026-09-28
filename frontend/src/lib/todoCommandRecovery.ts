import type { QueryClient } from '@tanstack/react-query';
import { getToken, getUser } from './auth';
import { baseUrl } from './client';
import { CreateTodoResponse, DeleteTodoResponse, UpdateTodoResponse } from '@secretary/api/gen/todos_pb';
import { createAPI } from '@secretary/api';
import { BackendError, postJsonBody } from '@secretary/api/transport';
import { retainedTodoCommand, MissingTodoCommandTarget, type TodoCommand } from './retainedTodoCommand';

export const todoRecoveryEvent = 'secretary-todo-recovery';
export const todoRecoveredEvent = 'secretary-todo-recovered';

function scope() {
  const token = getToken();
  const user = getUser();
  if (!token || !user) throw new Error('Sign in to recover the retained TODO command.');
  const subject = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub;
  if (String(subject) !== String(user.id)) throw new Error('Sign in again to validate the retained command account.');
  const backend = new URL(baseUrl, window.location.href).href.replace(/\/$/, '');
  return { token, actor: user.id, backend, key: `secretary:todo-command:v1:${backend}:${user.id}` };
}

export function hasRetainedTodoCommand() {
  return Boolean(localStorage.getItem(scope().key));
}

export function reconcileTodoStorageEvent(event: StorageEvent) {
  if (event.key !== scope().key || event.newValue !== null || !event.oldValue) return;
  const stored = JSON.parse(event.oldValue);
  const request = JSON.parse(stored.bytes);
  window.dispatchEvent(new CustomEvent(todoRecoveredEvent, { detail: { operation: stored.operation, mutationId: request.mutationId } }));
}

export async function runTodoCommand(queryClient: QueryClient, command?: TodoCommand) {
  const owner = scope();
  const checkScope = () => {
    const current = scope();
    if (current.key !== owner.key || current.token !== owner.token) throw new Error('Session changed; the TODO command remains retained.');
  };
  if (!navigator.locks) throw new Error('This browser needs Web Locks support for durable TODO commands.');
  try {
    await navigator.locks.request(owner.key, { ifAvailable: true }, async (lock) => {
      if (!lock) {
        const error = new Error('A TODO command is already running in another tab.');
        error.name = 'TodoRecoveryBusy';
        throw error;
      }
      const completed = await retainedTodoCommand({
        storage: localStorage, key: owner.key, checkScope,
        send: async (bytes, operation) => {
          window.dispatchEvent(new Event(todoRecoveryEvent));
          const rpc = { create: 'CreateTodo', update: 'UpdateTodo', delete: 'DeleteTodo' }[operation];
          const type = { create: CreateTodoResponse, update: UpdateTodoResponse, delete: DeleteTodoResponse }[operation];
          try {
            return type.fromJson(await postJsonBody(owner.backend, `/secretary.v1.TodosService/${rpc}`, bytes, { token: owner.token }));
          } catch (error) {
            if (error instanceof BackendError && error.status === 404 && error.code === 'not_found') throw new MissingTodoCommandTarget(error.message);
            throw error;
          }
        },
        refresh: async () => {
          checkScope();
          // Also perform a live read when recovery runs before any list query
          // has mounted (for example, restarting on the recordings route).
          await createAPI({ baseUrl: owner.backend, getToken: () => owner.token }).todos.listTodos({ userId: BigInt(owner.actor) });
          checkScope();
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['todos'], refetchType: 'all' }, { throwOnError: true }),
            queryClient.invalidateQueries({ queryKey: ['todoHistory'], refetchType: 'all' }, { throwOnError: true }),
          ]);
        },
      }, command);
      if (completed) window.dispatchEvent(new CustomEvent(todoRecoveredEvent, { detail: completed }));
    });
  } finally {
    window.dispatchEvent(new Event(todoRecoveryEvent));
  }
}
