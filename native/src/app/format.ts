import { getPageTitle } from '../features/outline/tree';
import type { OutlinePage } from '../features/outline/types';
import type { BackendTodo } from '../lib/backend';
import type { TodoFilter } from './types';

export function todoStatusTone(status: BackendTodo['status']) {
  switch (status) {
    case 'todo':
      return 'todo';
    case 'doing':
      return 'doing';
    default:
      return status;
  }
}

export function formatInlineTodoStatus(status: string) {
  switch (status) {
    case 'todo':
      return '☐';
    case 'doing':
      return 'DOING';
    case 'done':
      return '☑';
    default:
      return status;
  }
}

export function formatTodoTimestamp(todo: BackendTodo) {
  const value = todo.updatedAt || todo.createdAt || todo.createdAtRecordingDate;
  if (!value) {
    return 'No timestamp';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(parsed);
}

export function formatPanelTimestamp(value: string) {
  if (!value) {
    return 'No timestamp';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(parsed);
}

export function matchesTodoFilter(todo: BackendTodo, filter: TodoFilter) {
  switch (filter) {
    case 'open':
      return todo.status === 'todo' || todo.status === 'doing';
    case 'done':
      return todo.status === 'done';
    case 'blocked':
      return todo.status === 'blocked';
    case 'skipped':
      return todo.status === 'skipped';
    case 'all':
    default:
      return true;
  }
}

export function cycleTodoStatus(status: BackendTodo['status'], direction: 1 | -1, order: BackendTodo['status'][]) {
  const currentIndex = order.indexOf(status);
  const safeIndex = currentIndex === -1 ? 0 : currentIndex;
  const nextIndex = (safeIndex + direction + order.length) % order.length;
  return order[nextIndex];
}

export function pageMatchesTitle(page: OutlinePage, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return getPageTitle(page).toLowerCase().includes(normalized);
}

export function pageMatchesBody(page: OutlinePage, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const text = page.nodes.map((node) => node.text).join(' ').toLowerCase();
  return text.includes(normalized);
}
