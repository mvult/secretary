import type { NodeStatus } from './types';

export const ESCAPE_SEQUENCE_MS = 280;

const statusOrder: NodeStatus[] = ['note', 'todo', 'doing', 'done'];

export function cycleStatus(status: NodeStatus): NodeStatus {
  const currentIndex = statusOrder.indexOf(status);
  return statusOrder[(currentIndex + 1) % statusOrder.length];
}
