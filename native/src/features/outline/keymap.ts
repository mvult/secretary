import type { BackendTodoStatus } from '../../lib/backend';

export const ESCAPE_SEQUENCE_MS = 280;

const statusOrder: Array<BackendTodoStatus | null> = [null, 'todo', 'doing', 'done'];

export function cycleStatus(status: BackendTodoStatus | null | undefined): BackendTodoStatus | null {
  const currentIndex = statusOrder.indexOf(status ?? null);
  return statusOrder[(currentIndex + 1) % statusOrder.length];
}
