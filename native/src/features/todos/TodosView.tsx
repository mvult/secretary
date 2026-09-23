import { useMemo, useState } from 'react';
import { formatTodoTimestamp, todoStatusTone } from '../../app/format';
import { TODO_STATUS_ORDER, type TodoFilter } from '../../app/types';
import type { BackendTodo, BackendTodoBucket, BackendTodoGoal } from '../../lib/backend';

const TODO_BUCKETS: Array<{ key: BackendTodoBucket; label: string }> = [
  { key: 'inbox', label: 'Inbox' },
  { key: 'on_deck', label: 'On deck' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'done', label: 'Done' },
];

function todayDateKey() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getDueState(todo: BackendTodo): 'overdue' | 'today' | '' {
  if (!todo.deadlineDate || todo.status === 'done' || todo.status === 'skipped') {
    return '';
  }
  const today = todayDateKey();
  if (todo.deadlineDate < today) {
    return 'overdue';
  }
  if (todo.deadlineDate === today) {
    return 'today';
  }
  return '';
}

interface TodosViewProps {
  authToken: string;
  userId: number | null;
  isLoadingTodos: boolean;
  filteredTodos: BackendTodo[];
  todoGoals: BackendTodoGoal[];
  activeTodo: BackendTodo | null;
  todoFilter: TodoFilter;
  todoGoalFilter: string;
  updatingTodoId: number | null;
  onSetTodoFilter: (filter: TodoFilter) => void;
  onSetTodoGoalFilter: (filter: string) => void;
  onSetActiveTodoId: (id: number | null) => void;
  onOpenTodoSource: (todo: BackendTodo) => void;
  onHandleTodoStatusChange: (todo: BackendTodo, status: BackendTodo['status']) => void;
  onHandleTodoChange: (todo: BackendTodo, patch: Partial<BackendTodo>) => void;
  onMoveCurrentDocumentTodosToRepository: () => void;
  onPullOnDeckTodosIntoToday: () => void;
}

export function TodosView({
  authToken,
  userId,
  isLoadingTodos,
  filteredTodos,
  todoGoals,
  activeTodo,
  todoFilter,
  todoGoalFilter,
  updatingTodoId,
  onSetTodoFilter,
  onSetTodoGoalFilter,
  onSetActiveTodoId,
  onOpenTodoSource,
  onHandleTodoStatusChange,
  onHandleTodoChange,
  onMoveCurrentDocumentTodosToRepository,
  onPullOnDeckTodosIntoToday,
}: TodosViewProps) {
  const [backlogQuery, setBacklogQuery] = useState('');
  const query = backlogQuery.trim().toLowerCase();
  const { backlogTodos, todosByBucket } = useMemo(() => {
    const nextBacklogTodos: BackendTodo[] = [];
    const nextTodosByBucket = new Map<BackendTodoBucket, BackendTodo[]>(
      TODO_BUCKETS.map(({ key }) => [key, []]),
    );

    for (const todo of filteredTodos) {
      if (todo.bucket) {
        nextTodosByBucket.get(todo.bucket)?.push(todo);
      } else if (!query || `${todo.name} ${todo.desc} ${todo.goalName}`.toLowerCase().includes(query)) {
        nextBacklogTodos.push(todo);
      }
    }

    return { backlogTodos: nextBacklogTodos, todosByBucket: nextTodosByBucket };
  }, [filteredTodos, query]);

  function renderTodoCard(todo: BackendTodo, compact = false) {
    const goalName = todo.goalName || todoGoals.find((goal) => goal.id === todo.goalId)?.name || '';
    const dueState = getDueState(todo);
    return (
      <article
        key={todo.id}
        className="todo-card"
        data-active={activeTodo?.id === todo.id ? 'true' : 'false'}
        data-due-state={dueState}
        data-todo-id={todo.id}
        onClick={() => onSetActiveTodoId(todo.id)}
      >
        <div className="todo-card-header">
          <div>
            <h3 className="search-result-title">{todo.name}</h3>
            <p className="todo-card-meta">
              {formatTodoTimestamp(todo)}
              {dueState ? <span className="todo-due-badge" data-due-state={dueState}>{dueState === 'overdue' ? 'Overdue' : 'Due today'}</span> : null}
            </p>
          </div>
          <label className="todo-status-control" data-status={todoStatusTone(todo.status)} data-busy={updatingTodoId === todo.id}>
            <span className="todo-status-dot" aria-hidden="true" />
            <select
              className="todo-status-select"
              value={todo.status}
              disabled={updatingTodoId === todo.id}
              aria-label={`Set status for ${todo.name}`}
              onChange={(event) => onHandleTodoStatusChange(todo, event.target.value as BackendTodo['status'])}
            >
              {TODO_STATUS_ORDER.map((status) => (
                <option key={status} value={status}>{status[0].toUpperCase() + status.slice(1)}</option>
              ))}
            </select>
            <span className="todo-status-caret" aria-hidden="true">v</span>
          </label>
        </div>
        {todo.desc && !compact ? <p className="todo-card-desc">{todo.desc}</p> : null}
        <div className="todo-planning-row">
          <label className="todo-planning-field">
            <span>Rank</span>
            <input
              type="number"
              min="1"
              defaultValue={todo.priorityRank || ''}
              disabled={updatingTodoId === todo.id}
              onBlur={(event) => {
                const priorityRank = Number(event.currentTarget.value) || 0;
                if (priorityRank !== todo.priorityRank) {
                  onHandleTodoChange(todo, { priorityRank });
                }
              }}
            />
          </label>
          <label className="todo-planning-field">
            <span>Due</span>
            <input
              type="date"
              defaultValue={todo.deadlineDate}
              disabled={updatingTodoId === todo.id}
              onBlur={(event) => {
                if (event.currentTarget.value !== todo.deadlineDate) {
                  onHandleTodoChange(todo, { deadlineDate: event.currentTarget.value });
                }
              }}
            />
          </label>
          <label className="todo-planning-field">
            <span>Bucket</span>
            <select
              value={todo.bucket}
              disabled={updatingTodoId === todo.id}
              onChange={(event) => onHandleTodoChange(todo, { bucket: event.target.value as BackendTodoBucket })}
            >
              <option value="">Backlog</option>
              {TODO_BUCKETS.map((bucket) => <option key={bucket.key} value={bucket.key}>{bucket.label}</option>)}
            </select>
          </label>
          <label className="todo-planning-field">
            <span>Goal</span>
            <select
              value={todo.goalId || ''}
              disabled={updatingTodoId === todo.id}
              onChange={(event) => onHandleTodoChange(todo, { goalId: Number(event.target.value) || 0 })}
            >
              <option value="">No goal</option>
              {todoGoals.map((goal) => <option key={goal.id} value={goal.id}>{goal.name}</option>)}
            </select>
          </label>
        </div>
        <div className="todo-card-footer">
          <span className="todo-card-meta">#{todo.id}{goalName ? ` / ${goalName}` : ''}</span>
          {todo.currentDocumentId || todo.sourceDocumentId ? (
            <button type="button" className="todo-link-button" onClick={() => onOpenTodoSource(todo)}>
              Open source
            </button>
          ) : null}
          {todo.createdAtRecordingName ? <span className="todo-card-meta">From {todo.createdAtRecordingName}</span> : null}
        </div>
      </article>
    );
  }

  return (
    <section className="todos-shell">
      <header className="page-header">
        <p className="page-date">Canonical tasks</p>
        <div className="page-heading-row">
          <h2 className="page-title settings-title">Todos</h2>
          <span className="page-kind">{filteredTodos.length}</span>
        </div>
        <div className="todo-command-row">
          <button type="button" className="todo-filter-button" onClick={onMoveCurrentDocumentTodosToRepository}>
            m Move doc todos to repository
          </button>
          <button type="button" className="todo-filter-button" onClick={onPullOnDeckTodosIntoToday}>
            p Pull on deck into today
          </button>
          <span className="todo-card-meta">h/l bucket | [/ ] rank</span>
        </div>
      </header>

      <div className="todo-list-panel">
        <div className="todo-filter-row">
          {(['all', 'open', 'done', 'blocked', 'skipped'] as TodoFilter[]).map((filter) => (
            <button
              key={filter}
              type="button"
              className="todo-filter-button"
              data-active={todoFilter === filter}
              onClick={() => {
                onSetTodoFilter(filter);
                onSetActiveTodoId(null);
              }}
            >
              {filter}
            </button>
          ))}
          <select
            className="todo-goal-filter"
            value={todoGoalFilter}
            onChange={(event) => {
              onSetTodoGoalFilter(event.target.value);
              onSetActiveTodoId(null);
            }}
            aria-label="Filter todos by goal"
          >
            <option value="all">All goals</option>
            <option value="none">No goal</option>
            {todoGoals.map((goal) => <option key={goal.id} value={goal.id}>{goal.name}</option>)}
          </select>
        </div>
        <div className="todo-list-scroll">
          {!authToken || !userId ? (
            <div className="search-empty">Log in again to load your todos.</div>
          ) : isLoadingTodos ? (
            <div className="search-empty">Loading todos...</div>
          ) : filteredTodos.length === 0 ? (
            <div className="search-empty">No todos yet. Mark a block as a task and it will show up here.</div>
          ) : (
            <div className="todo-planning-layout">
              <div className="todo-kanban-board">
                {TODO_BUCKETS.map((bucket) => {
                  const bucketTodos = todosByBucket.get(bucket.key) ?? [];
                  return (
                    <section key={bucket.key} className="todo-kanban-column">
                      <header className="todo-kanban-header">
                        <span>{bucket.label}</span>
                        <span>{bucketTodos.length}</span>
                      </header>
                      <div className="todo-kanban-cards">
                        {bucketTodos.length ? bucketTodos.map((todo) => renderTodoCard(todo, true)) : <p className="todo-card-meta">Empty</p>}
                      </div>
                    </section>
                  );
                })}
              </div>

              <section className="todo-backlog-panel">
                <header className="todo-kanban-header">
                  <span>Backlog</span>
                  <span>{backlogTodos.length}</span>
                </header>
                <input
                  className="todo-backlog-search"
                  value={backlogQuery}
                  onChange={(event) => setBacklogQuery(event.target.value)}
                  placeholder="Search unbucketed TODOs"
                />
                <div className="search-results">
                  {backlogTodos.length ? backlogTodos.map((todo) => renderTodoCard(todo)) : <div className="search-empty">No backlog matches.</div>}
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
