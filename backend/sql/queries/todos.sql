-- name: ListTodosByUser :many
SELECT
  t.id,
  t.name,
  t."desc",
  t.status,
  t.user_id,
  t.created_at_recording_id,
  t.updated_at_recording_id,
  r.name as recording_name,
  r.created_at as recording_date
FROM todo t
LEFT JOIN recording r ON t.created_at_recording_id = r.id
WHERE t.user_id = $1
ORDER BY t.id DESC;

-- name: ListTodosByRecording :many
SELECT
  t.id,
  t.name,
  t."desc",
  t.status,
  t.user_id,
  t.created_at_recording_id,
  t.updated_at_recording_id,
  r.name as recording_name,
  r.created_at as recording_date
FROM todo t
LEFT JOIN recording r ON t.created_at_recording_id = r.id
WHERE t.created_at_recording_id = $1
ORDER BY t.id DESC;

-- name: GetTodo :one
SELECT
  t.id,
  t.name,
  t."desc",
  t.status,
  t.user_id,
  t.created_at_recording_id,
  t.updated_at_recording_id,
  r.name as recording_name,
  r.created_at as recording_date
FROM todo t
LEFT JOIN recording r ON t.created_at_recording_id = r.id
WHERE t.id = $1;

-- name: CreateTodo :one
INSERT INTO todo (
  name,
  "desc",
  status,
  user_id,
  created_at_recording_id,
  updated_at_recording_id
) VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id, name, "desc", status, user_id, created_at_recording_id, updated_at_recording_id;

-- name: UpdateTodo :one
UPDATE todo
SET
  name = $2,
  "desc" = $3,
  status = $4,
  user_id = $5,
  updated_at_recording_id = $6
WHERE id = $1
RETURNING id, name, "desc", status, user_id, created_at_recording_id, updated_at_recording_id;

-- name: DeleteTodo :exec
DELETE FROM todo WHERE id = $1;

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
