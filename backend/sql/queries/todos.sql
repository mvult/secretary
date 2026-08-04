-- name: ListTodosByUser :many
SELECT
  t.id,
  t.name,
  t."desc",
  t.status,
  t.user_id,
  t.workspace_id,
  t.bucket,
  t.priority_rank,
  t.deadline_date,
  t.goal_id,
  g.name as goal_name,
  t.source_kind,
  t.source_document_id,
  t.source_block_id,
  t.current_document_id,
  t.current_block_id,
  t.completed_at,
  t.completed_document_id,
  t.completed_block_id,
  t.created_at_recording_id,
  t.updated_at_recording_id,
  t.created_at,
  t.updated_at,
  r.name as recording_name,
  r.created_at as recording_date
FROM todo t
LEFT JOIN recording r ON t.created_at_recording_id = r.id
LEFT JOIN todo_goal g ON t.goal_id = g.id
WHERE t.user_id = $1
ORDER BY t.priority_rank ASC NULLS LAST, t.deadline_date ASC NULLS LAST, t.created_at DESC, t.id DESC;

-- name: ListTodosByRecording :many
SELECT
  t.id,
  t.name,
  t."desc",
  t.status,
  t.user_id,
  t.workspace_id,
  t.bucket,
  t.priority_rank,
  t.deadline_date,
  t.goal_id,
  g.name as goal_name,
  t.source_kind,
  t.source_document_id,
  t.source_block_id,
  t.current_document_id,
  t.current_block_id,
  t.completed_at,
  t.completed_document_id,
  t.completed_block_id,
  t.created_at_recording_id,
  t.updated_at_recording_id,
  t.created_at,
  t.updated_at,
  r.name as recording_name,
  r.created_at as recording_date
FROM todo t
LEFT JOIN recording r ON t.created_at_recording_id = r.id
LEFT JOIN todo_goal g ON t.goal_id = g.id
WHERE t.created_at_recording_id = $1
ORDER BY t.priority_rank ASC NULLS LAST, t.deadline_date ASC NULLS LAST, t.created_at DESC, t.id DESC;

-- name: GetTodo :one
SELECT
  t.id,
  t.name,
  t."desc",
  t.status,
  t.user_id,
  t.workspace_id,
  t.bucket,
  t.priority_rank,
  t.deadline_date,
  t.goal_id,
  g.name as goal_name,
  t.source_kind,
  t.source_document_id,
  t.source_block_id,
  t.current_document_id,
  t.current_block_id,
  t.completed_at,
  t.completed_document_id,
  t.completed_block_id,
  t.created_at_recording_id,
  t.updated_at_recording_id,
  t.created_at,
  t.updated_at,
  r.name as recording_name,
  r.created_at as recording_date
FROM todo t
LEFT JOIN recording r ON t.created_at_recording_id = r.id
LEFT JOIN todo_goal g ON t.goal_id = g.id
WHERE t.id = $1;

-- name: CreateTodo :one
INSERT INTO todo (
  name,
  "desc",
  status,
  user_id,
  bucket,
  priority_rank,
  deadline_date,
  goal_id,
  created_at_recording_id,
  updated_at_recording_id
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING id, name, "desc", status, user_id, workspace_id, bucket, priority_rank, deadline_date, goal_id, source_kind, source_document_id, source_block_id, current_document_id, current_block_id, completed_at, completed_document_id, completed_block_id, created_at_recording_id, updated_at_recording_id, created_at, updated_at;

-- name: UpdateTodo :one
UPDATE todo
SET
  name = $2,
  "desc" = $3,
  status = $4,
  user_id = $5,
  bucket = $6,
  priority_rank = $7,
  deadline_date = $8,
  goal_id = $9,
  updated_at_recording_id = $10,
  completed_at = CASE WHEN $4 = 'done' AND completed_at IS NULL THEN now() WHEN $4 <> 'done' THEN NULL ELSE completed_at END,
  completed_document_id = CASE WHEN $4 = 'done' THEN current_document_id WHEN $4 <> 'done' THEN NULL ELSE completed_document_id END,
  completed_block_id = CASE WHEN $4 = 'done' THEN current_block_id WHEN $4 <> 'done' THEN NULL ELSE completed_block_id END,
  updated_at = now()
WHERE id = $1
RETURNING id, name, "desc", status, user_id, workspace_id, bucket, priority_rank, deadline_date, goal_id, source_kind, source_document_id, source_block_id, current_document_id, current_block_id, completed_at, completed_document_id, completed_block_id, created_at_recording_id, updated_at_recording_id, created_at, updated_at;

-- name: ListTodoGoalsByUser :many
SELECT id, user_id, name, description, created_at, updated_at
FROM todo_goal
WHERE user_id = $1
ORDER BY name ASC, id ASC;

-- name: CreateTodoGoal :one
INSERT INTO todo_goal (user_id, name, description)
VALUES ($1, $2, $3)
RETURNING id, user_id, name, description, created_at, updated_at;

-- name: UpdateTodoGoal :one
UPDATE todo_goal
SET name = $2, description = $3, updated_at = now()
WHERE id = $1 AND user_id = $4
RETURNING id, user_id, name, description, created_at, updated_at;

-- name: DeleteTodoGoal :exec
DELETE FROM todo_goal
WHERE id = $1 AND user_id = $2;

-- name: DeleteTodo :exec
DELETE FROM todo WHERE id = $1;

-- name: MoveTodoToRepository :one
UPDATE todo
SET
  current_document_id = NULL,
  current_block_id = NULL,
  updated_at = now()
WHERE id = $1
  AND COALESCE(status, 'todo') <> 'done'
RETURNING id, name, "desc", status, user_id, workspace_id, bucket, priority_rank, deadline_date, goal_id, source_kind, source_document_id, source_block_id, current_document_id, current_block_id, completed_at, completed_document_id, completed_block_id, created_at_recording_id, updated_at_recording_id, created_at, updated_at;

-- name: ListOnDeckTodosForPull :many
SELECT id, name, "desc", status, user_id, workspace_id, bucket, priority_rank, deadline_date, goal_id, source_kind, source_document_id, source_block_id, current_document_id, current_block_id, completed_at, completed_document_id, completed_block_id, created_at_recording_id, updated_at_recording_id, created_at, updated_at
FROM todo
WHERE user_id = $1
  AND workspace_id = $2
  AND bucket = 'on_deck'
  AND current_block_id IS NULL
  AND COALESCE(status, 'todo') <> 'done'
ORDER BY priority_rank ASC NULLS LAST, deadline_date ASC NULLS LAST, created_at DESC, id DESC;

-- name: MoveTodoToDocumentBlock :one
UPDATE todo
SET
  current_document_id = $2,
  current_block_id = $3,
  bucket = NULL,
  updated_at = now()
WHERE id = $1
  AND bucket = 'on_deck'
  AND current_block_id IS NULL
  AND COALESCE(status, 'todo') <> 'done'
RETURNING id, name, "desc", status, user_id, workspace_id, bucket, priority_rank, deadline_date, goal_id, source_kind, source_document_id, source_block_id, current_document_id, current_block_id, completed_at, completed_document_id, completed_block_id, created_at_recording_id, updated_at_recording_id, created_at, updated_at;

-- name: CreateTodoHistory :exec
INSERT INTO todo_history (
  todo_id,
  actor_user_id,
  change_type,
  name,
  "desc",
  status,
  user_id,
  created_at_recording_id,
  updated_at_recording_id
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);

-- name: ListTodoHistory :many
SELECT
  h.id,
  h.todo_id,
  h.actor_user_id,
  h.change_type,
  h.name,
  h."desc",
  h.status,
  h.user_id,
  h.created_at_recording_id,
  h.updated_at_recording_id,
  h.changed_at
FROM todo_history h
WHERE h.todo_id = $1
ORDER BY h.changed_at DESC;
