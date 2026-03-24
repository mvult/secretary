import { TodoStatus } from '../gen/secretary/v1/todos_pb';

export const TODO_STATUS_CONFIG: Record<number, { label: string; color: string }> = {
  [TodoStatus.UNSPECIFIED]: { label: 'Unknown', color: 'gray' },
  [TodoStatus.TODO]: { label: 'Todo', color: 'gray' },
  [TodoStatus.DOING]: { label: 'Doing', color: 'blue' },
  [TodoStatus.DONE]: { label: 'Done', color: 'green' },
  [TodoStatus.BLOCKED]: { label: 'Blocked', color: 'red' },
  [TodoStatus.SKIPPED]: { label: 'Skipped', color: 'yellow' },
};

export function getStatusConfig(status: TodoStatus) {
  return TODO_STATUS_CONFIG[status] || TODO_STATUS_CONFIG[TodoStatus.UNSPECIFIED];
}

export const TODO_STATUS_OPTIONS = [
  { value: String(TodoStatus.TODO), label: 'Todo' },
  { value: String(TodoStatus.DOING), label: 'Doing' },
  { value: String(TodoStatus.DONE), label: 'Done' },
  { value: String(TodoStatus.BLOCKED), label: 'Blocked' },
  { value: String(TodoStatus.SKIPPED), label: 'Skipped' },
];
