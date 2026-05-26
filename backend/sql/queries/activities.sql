-- name: ListActivityTypesByUser :many
SELECT
  id,
  user_id,
  key,
  name,
  unit,
  created_at
FROM activity_type
WHERE user_id = $1
ORDER BY lower(name) ASC, id ASC;

-- name: GetActivityTypeForUser :one
SELECT
  id,
  user_id,
  key,
  name,
  unit,
  created_at
FROM activity_type
WHERE id = $1 AND user_id = $2;

-- name: GetActivityTypeByKeyForUser :one
SELECT
  id,
  user_id,
  key,
  name,
  unit,
  created_at
FROM activity_type
WHERE key = $1 AND user_id = $2;

-- name: CreateActivityType :one
INSERT INTO activity_type (
  user_id,
  key,
  name,
  unit
) VALUES ($1, $2, $3, $4)
RETURNING id, user_id, key, name, unit, created_at;

-- name: EnsureActivityType :one
INSERT INTO activity_type (
  user_id,
  key,
  name,
  unit
) VALUES ($1, $2, $3, $4)
ON CONFLICT (user_id, key) DO UPDATE
SET
  name = EXCLUDED.name,
  unit = EXCLUDED.unit
RETURNING id, user_id, key, name, unit, created_at;

-- name: DeleteActivityTypeForUser :exec
DELETE FROM activity_type
WHERE id = $1 AND user_id = $2;

-- name: ListActivityEntriesForUser :many
SELECT
  e.id,
  e.activity_type_id,
  t.key AS activity_type_key,
  e.occurred_at,
  e.value,
  e.note,
  e.data,
  e.created_at
FROM activity_entry e
JOIN activity_type t ON t.id = e.activity_type_id
WHERE t.user_id = sqlc.arg(user_id)
  AND (sqlc.narg(activity_type_id)::integer IS NULL OR e.activity_type_id = sqlc.narg(activity_type_id)::integer)
  AND (sqlc.narg(activity_type_key)::text IS NULL OR t.key = sqlc.narg(activity_type_key)::text)
  AND (sqlc.narg(start_at)::timestamptz IS NULL OR e.occurred_at >= sqlc.narg(start_at)::timestamptz)
  AND (sqlc.narg(end_at)::timestamptz IS NULL OR e.occurred_at < sqlc.narg(end_at)::timestamptz)
ORDER BY e.occurred_at DESC, e.id DESC
LIMIT sqlc.arg(limit_count);

-- name: CreateActivityEntry :one
INSERT INTO activity_entry (
  activity_type_id,
  occurred_at,
  value,
  note,
  data
) VALUES (sqlc.arg(activity_type_id), COALESCE(sqlc.narg(occurred_at), now()), sqlc.narg(value), sqlc.narg(note), COALESCE(sqlc.narg(data), '{}'::jsonb))
RETURNING id, activity_type_id, occurred_at, value, note, data, created_at;

-- name: UpdateActivityEntryForUser :one
UPDATE activity_entry e
SET
  occurred_at = sqlc.arg(occurred_at),
  value = sqlc.narg(value),
  note = sqlc.narg(note),
  data = COALESCE(sqlc.narg(data), '{}'::jsonb)
FROM activity_type t
WHERE e.id = sqlc.arg(id)
  AND e.activity_type_id = t.id
  AND t.user_id = sqlc.arg(user_id)
RETURNING e.id, e.activity_type_id, t.key AS activity_type_key, e.occurred_at, e.value, e.note, e.data, e.created_at;

-- name: DeleteActivityEntryForUser :exec
DELETE FROM activity_entry e
USING activity_type t
WHERE e.id = $1
  AND e.activity_type_id = t.id
  AND t.user_id = $2;
