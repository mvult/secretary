import { useCallback, useEffect, useMemo, useState } from 'react';
import { updateTodo, listTodos, type BackendTodo } from '../../lib/backend';
import type { TodoFilter } from '../../app/types';
import { matchesTodoFilter } from '../../app/format';

interface UseTodosOptions {
  backendUrl: string;
  authToken: string;
  userId: number | null;
  syncMessageSetter: (message: string) => void;
  syncTodoIntoPages: (todo: BackendTodo) => void;
}

export function useTodos({ backendUrl, authToken, userId, syncMessageSetter, syncTodoIntoPages }: UseTodosOptions) {
  const [todos, setTodos] = useState<BackendTodo[]>([]);
  const [todoFilter, setTodoFilter] = useState<TodoFilter>('all');
  const [activeTodoId, setActiveTodoId] = useState<number | null>(null);
  const [updatingTodoId, setUpdatingTodoId] = useState<number | null>(null);
  const [isLoadingTodos, setIsLoadingTodos] = useState(false);

  const loadTodoList = useCallback(async (tokenOverride?: string, userIdOverride?: number | null) => {
    const nextToken = tokenOverride ?? authToken;
    const nextUserId = userIdOverride ?? userId;
    if (!backendUrl.trim() || !nextToken || !nextUserId) {
      setTodos([]);
      return;
    }

    setIsLoadingTodos(true);
    try {
      setTodos(await listTodos(backendUrl, nextToken, nextUserId));
    } catch (error) {
      syncMessageSetter(error instanceof Error ? error.message : 'Todo refresh failed.');
    } finally {
      setIsLoadingTodos(false);
    }
  }, [authToken, backendUrl, syncMessageSetter, userId]);

  const filteredTodos = useMemo(() => todos.filter((todo) => matchesTodoFilter(todo, todoFilter)), [todoFilter, todos]);
  const activeTodo = useMemo(() => {
    if (filteredTodos.length === 0) {
      return null;
    }
    if (activeTodoId != null) {
      return filteredTodos.find((todo) => todo.id === activeTodoId) ?? filteredTodos[0] ?? null;
    }
    return filteredTodos[0] ?? null;
  }, [activeTodoId, filteredTodos]);

  useEffect(() => {
    if (filteredTodos.length === 0) {
      if (activeTodoId !== null) {
        setActiveTodoId(null);
      }
      return;
    }

    if (activeTodoId == null || !filteredTodos.some((todo) => todo.id === activeTodoId)) {
      setActiveTodoId(filteredTodos[0].id);
    }
  }, [activeTodoId, filteredTodos]);

  const handleTodoStatusChange = useCallback(async (todo: BackendTodo, nextStatus: BackendTodo['status']) => {
    if (!authToken || !userId || nextStatus === todo.status) {
      return;
    }
    setUpdatingTodoId(todo.id);
    try {
      const savedTodo = await updateTodo(backendUrl, authToken, { ...todo, status: nextStatus, userId });
      setTodos((current) => current.map((entry) => (entry.id === savedTodo.id ? savedTodo : entry)));
      syncTodoIntoPages(savedTodo);
    } catch (error) {
      syncMessageSetter(error instanceof Error ? error.message : 'Todo update failed.');
    } finally {
      setUpdatingTodoId(null);
    }
  }, [authToken, backendUrl, syncMessageSetter, syncTodoIntoPages, userId]);

  const clearTodos = useCallback(() => {
    setTodos([]);
    setActiveTodoId(null);
  }, []);

  return {
    todos,
    setTodos,
    todoFilter,
    setTodoFilter,
    activeTodoId,
    setActiveTodoId,
    updatingTodoId,
    isLoadingTodos,
    filteredTodos,
    activeTodo,
    loadTodoList,
    handleTodoStatusChange,
    clearTodos,
  };
}
