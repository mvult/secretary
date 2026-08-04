import { useCallback, useEffect, useMemo, useState } from 'react';
import { updateTodo, listTodoGoals, listTodos, type BackendTodo, type BackendTodoGoal } from '../../lib/backend';
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
  const [todoGoals, setTodoGoals] = useState<BackendTodoGoal[]>([]);
  const [todoFilter, setTodoFilter] = useState<TodoFilter>('all');
  const [todoGoalFilter, setTodoGoalFilter] = useState('all');
  const [activeTodoId, setActiveTodoId] = useState<number | null>(null);
  const [updatingTodoId, setUpdatingTodoId] = useState<number | null>(null);
  const [isLoadingTodos, setIsLoadingTodos] = useState(false);

  const loadTodoList = useCallback(async (tokenOverride?: string, userIdOverride?: number | null) => {
    const nextToken = tokenOverride ?? authToken;
    const nextUserId = userIdOverride ?? userId;
    if (!backendUrl.trim() || !nextToken || !nextUserId) {
      setTodos([]);
      setTodoGoals([]);
      return;
    }

    setIsLoadingTodos(true);
    try {
      const [nextTodos, nextGoals] = await Promise.all([
        listTodos(backendUrl, nextToken, nextUserId),
        listTodoGoals(backendUrl, nextToken, nextUserId),
      ]);
      setTodos(nextTodos);
      setTodoGoals(nextGoals);
    } catch (error) {
      syncMessageSetter(error instanceof Error ? error.message : 'Todo refresh failed.');
    } finally {
      setIsLoadingTodos(false);
    }
  }, [authToken, backendUrl, syncMessageSetter, userId]);

  const filteredTodos = useMemo(() => todos.filter((todo) => {
    if (!matchesTodoFilter(todo, todoFilter)) {
      return false;
    }
    if (todoGoalFilter === 'all') {
      return true;
    }
    if (todoGoalFilter === 'none') {
      return !todo.goalId;
    }
    return todo.goalId === Number(todoGoalFilter);
  }), [todoFilter, todoGoalFilter, todos]);
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
      const nextBucket = nextStatus === 'done' ? 'done' : nextStatus === 'blocked' ? 'blocked' : (todo.bucket === 'done' || todo.bucket === 'blocked' ? '' : todo.bucket);
      const savedTodo = await updateTodo(backendUrl, authToken, { ...todo, status: nextStatus, bucket: nextBucket, userId });
      setTodos((current) => current.map((entry) => (entry.id === savedTodo.id ? savedTodo : entry)));
      syncTodoIntoPages(savedTodo);
    } catch (error) {
      syncMessageSetter(error instanceof Error ? error.message : 'Todo update failed.');
    } finally {
      setUpdatingTodoId(null);
    }
  }, [authToken, backendUrl, syncMessageSetter, syncTodoIntoPages, userId]);

  const handleTodoChange = useCallback(async (todo: BackendTodo, patch: Partial<BackendTodo>) => {
    if (!authToken || !userId) {
      return;
    }
    const nextTodo = { ...todo, ...patch, userId };
    setUpdatingTodoId(todo.id);
    try {
      const savedTodo = await updateTodo(backendUrl, authToken, nextTodo);
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
    setTodoGoals([]);
    setActiveTodoId(null);
  }, []);

  return {
    todos,
    setTodos,
    todoGoals,
    todoFilter,
    setTodoFilter,
    todoGoalFilter,
    setTodoGoalFilter,
    activeTodoId,
    setActiveTodoId,
    updatingTodoId,
    isLoadingTodos,
    filteredTodos,
    activeTodo,
    loadTodoList,
    handleTodoStatusChange,
    handleTodoChange,
    clearTodos,
  };
}
