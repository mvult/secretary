import { formatTodoTimestamp, todoStatusTone } from '../../app/format';
import { TODO_STATUS_ORDER, type TodoFilter } from '../../app/types';
import type { BackendTodo } from '../../lib/backend';

interface TodosViewProps {
  authToken: string;
  userId: number | null;
  isLoadingTodos: boolean;
  filteredTodos: BackendTodo[];
  activeTodo: BackendTodo | null;
  todoFilter: TodoFilter;
  updatingTodoId: number | null;
  onSetTodoFilter: (filter: TodoFilter) => void;
  onSetActiveTodoId: (id: number | null) => void;
  onOpenTodoSource: (todo: BackendTodo) => void;
  onHandleTodoStatusChange: (todo: BackendTodo, status: BackendTodo['status']) => void;
}

export function TodosView({
  authToken,
  userId,
  isLoadingTodos,
  filteredTodos,
  activeTodo,
  todoFilter,
  updatingTodoId,
  onSetTodoFilter,
  onSetActiveTodoId,
  onOpenTodoSource,
  onHandleTodoStatusChange,
}: TodosViewProps) {
  return (
    <section className="todos-shell">
      <header className="page-header">
        <p className="page-date">Canonical tasks</p>
        <div className="page-heading-row">
          <h2 className="page-title settings-title">Todos</h2>
          <span className="page-kind">{filteredTodos.length}</span>
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
        </div>
        <div className="todo-list-scroll">
          <div className="search-results">
            {!authToken || !userId ? (
              <div className="search-empty">Log in again to load your todos.</div>
            ) : isLoadingTodos ? (
              <div className="search-empty">Loading todos...</div>
            ) : filteredTodos.length === 0 ? (
              <div className="search-empty">No todos yet. Mark a block as a task and it will show up here.</div>
            ) : (
              filteredTodos.map((todo) => (
                <article
                  key={todo.id}
                  className="todo-card"
                  data-active={activeTodo?.id === todo.id ? 'true' : 'false'}
                  data-todo-id={todo.id}
                  onClick={() => onSetActiveTodoId(todo.id)}
                >
                  <div className="todo-card-header">
                    <div>
                      <h3 className="search-result-title">{todo.name}</h3>
                      <p className="todo-card-meta">{formatTodoTimestamp(todo)}</p>
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
                  {todo.desc ? <p className="todo-card-desc">{todo.desc}</p> : null}
                  <div className="todo-card-footer">
                    <span className="todo-card-meta">#{todo.id}</span>
                    {todo.sourceDocumentId ? (
                      <button type="button" className="todo-link-button" onClick={() => onOpenTodoSource(todo)}>
                        Open source
                      </button>
                    ) : null}
                    {todo.createdAtRecordingName ? <span className="todo-card-meta">From {todo.createdAtRecordingName}</span> : null}
                  </div>
                </article>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
