import { TodoStatus } from '../gen/secretary/v1/todos_pb';

export const TODO_STATUS_CONFIG: Record<number, { label: string; color: string }> = {
  [TodoStatus.UNSPECIFIED]: { label: 'Unknown', color: 'gray' },
  [TodoStatus.NOT_STARTED]: { label: 'Not Started', color: 'gray' },
  [TodoStatus.PARTIAL]: { label: 'In Progress', color: 'blue' },
  [TodoStatus.DONE]: { label: 'Done', color: 'green' },
  [TodoStatus.BLOCKED]: { label: 'Blocked', color: 'red' },
  [TodoStatus.SKIPPED]: { label: 'Skipped', color: 'yellow' },
};

export function getStatusConfig(status: TodoStatus) {
  return TODO_STATUS_CONFIG[status] || TODO_STATUS_CONFIG[TodoStatus.UNSPECIFIED];
}

export const TODO_STATUS_OPTIONS = [
  { value: String(TodoStatus.PARTIAL), label: 'In Progress' },
  { value: String(TodoStatus.DONE), label: 'Done' },
  { value: String(TodoStatus.BLOCKED), label: 'Blocked' },
  { value: String(TodoStatus.SKIPPED), label: 'Skipped' },
];
