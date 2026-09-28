-- name: ListDocumentIndex :many
SELECT d.*, coalesce((
  SELECT substring(b.text FROM greatest(1, strpos(lower(b.text), lower(sqlc.arg(query))) - 60) FOR 240)
  FROM block b WHERE b.document_id = d.id AND sqlc.arg(query)::text <> ''
    AND strpos(lower(b.text), lower(sqlc.arg(query))) > 0
  ORDER BY b.sort_order, b.id LIMIT 1
), '')::text AS snippet
FROM document d
WHERE d.workspace_id = sqlc.arg(workspace_id)
  AND (sqlc.arg(before_id)::integer = 0 OR d.id < sqlc.arg(before_id))
  AND (sqlc.arg(query)::text = '' OR strpos(lower(d.title), lower(sqlc.arg(query))) > 0
    OR EXISTS (SELECT 1 FROM block b WHERE b.document_id = d.id AND strpos(lower(b.text), lower(sqlc.arg(query))) > 0))
ORDER BY d.id DESC
LIMIT sqlc.arg(page_limit);

-- name: ListDocumentsByWorkspace :many
SELECT
  d.id,
  d.workspace_id,
  d.directory_id,
  d.kind,
  d.title,
  d.journal_date,
  d.created_at,
  d.updated_at,
  d.client_key,
  d.revision
FROM document d
WHERE d.workspace_id = $1
ORDER BY
  CASE WHEN d.kind = 'journal' THEN 0 ELSE 1 END,
  d.journal_date DESC NULLS LAST,
  d.updated_at DESC,
  d.id DESC;

-- name: GetDocument :one
SELECT
  d.id,
  d.workspace_id,
  d.directory_id,
  d.kind,
  d.title,
  d.journal_date,
  d.created_at,
  d.updated_at,
  d.client_key,
  d.revision
FROM document d
WHERE d.id = $1;

-- name: CreateDocument :one
INSERT INTO document (
  workspace_id,
  directory_id,
  kind,
  title,
  journal_date
) VALUES ($1, $2, $3, $4, $5)
RETURNING id, workspace_id, directory_id, kind, title, journal_date, created_at, updated_at, client_key, revision;

-- name: UpdateDocument :one
UPDATE document
SET
  directory_id = $2,
  kind = $3,
  title = $4,
  journal_date = $5,
  updated_at = now()
WHERE id = $1
RETURNING id, workspace_id, directory_id, kind, title, journal_date, created_at, updated_at, client_key, revision;

-- name: DeleteDocument :exec
DELETE FROM document
WHERE id = $1;

-- name: ListDocumentHistoryByDocument :many
SELECT
  id,
  document_id,
  capture_reason,
  content_hash,
  snapshot_json,
  captured_at
FROM document_history
WHERE document_id = $1
ORDER BY captured_at DESC, id DESC;

-- name: GetDocumentHistoryEntry :one
SELECT
  id,
  document_id,
  capture_reason,
  content_hash,
  snapshot_json,
  captured_at
FROM document_history
WHERE id = $1;

-- name: GetLatestDocumentHistoryEntryByDocument :one
SELECT
  id,
  document_id,
  capture_reason,
  content_hash,
  snapshot_json,
  captured_at
FROM document_history
WHERE document_id = $1
ORDER BY captured_at DESC, id DESC
LIMIT 1;

-- name: GetLatestDocumentHistoryEntryForDay :one
SELECT
  id,
  document_id,
  capture_reason,
  content_hash,
  snapshot_json,
  captured_at
FROM document_history
WHERE document_id = $1
  AND captured_at >= $2
  AND captured_at < $3
ORDER BY captured_at ASC, id ASC
LIMIT 1;

-- name: CreateDocumentHistoryEntry :one
INSERT INTO document_history (
  document_id,
  capture_reason,
  content_hash,
  snapshot_json,
  captured_at
) VALUES ($1, $2, $3, $4, $5)
RETURNING id, document_id, capture_reason, content_hash, snapshot_json, captured_at;

-- name: DeleteOldDocumentHistoryByDocument :exec
DELETE FROM document_history
WHERE document_id = $1
  AND captured_at < $2;

-- name: ListDirectoriesByWorkspace :many
SELECT
  id,
  workspace_id,
  parent_id,
  name,
  position,
  created_at,
  updated_at
FROM directory
WHERE workspace_id = $1
ORDER BY parent_id NULLS FIRST, position ASC, lower(name) ASC, id ASC;

-- name: GetDirectory :one
SELECT
  id,
  workspace_id,
  parent_id,
  name,
  position,
  created_at,
  updated_at
FROM directory
WHERE id = $1;

-- name: CreateDirectory :one
INSERT INTO directory (
  workspace_id,
  parent_id,
  name,
  position
) VALUES (
  $1,
  $2,
  $3,
  COALESCE((SELECT MAX(position) + 1 FROM directory WHERE workspace_id = $1 AND parent_id IS NOT DISTINCT FROM $2), 0)
)
RETURNING id, workspace_id, parent_id, name, position, created_at, updated_at;

-- name: UpdateDirectory :one
UPDATE directory
SET
  name = $2,
  parent_id = $3,
  updated_at = now()
WHERE id = $1
RETURNING id, workspace_id, parent_id, name, position, created_at, updated_at;

-- name: DeleteDirectory :exec
DELETE FROM directory
WHERE id = $1;

-- name: CountChildDirectories :one
SELECT COUNT(*)
FROM directory
WHERE parent_id = $1;

-- name: CountDocumentsInDirectory :one
SELECT COUNT(*)
FROM document
WHERE directory_id = $1;

-- name: ListBlocksByDocument :many
SELECT
  b.id,
  b.document_id,
  b.parent_block_id,
  b.sort_order,
  b.text,
  b.todo_id,
  b.created_at,
  b.updated_at,
  b.client_key
FROM block b
WHERE b.document_id = $1
ORDER BY b.sort_order ASC, b.id ASC;

-- name: ListBlocksWithTodoStatusByWorkspace :many
SELECT sqlc.embed(b), t.status AS todo_status
FROM block b
JOIN document d ON d.id = b.document_id
LEFT JOIN todo t ON t.id = b.todo_id
WHERE d.workspace_id = $1
ORDER BY b.document_id ASC, b.sort_order ASC, b.id ASC;

-- name: CreateBlock :one
INSERT INTO block (
  document_id,
  parent_block_id,
  sort_order,
  text,
  todo_id
) VALUES ($1, $2, $3, $4, $5)
RETURNING id, document_id, parent_block_id, sort_order, text, todo_id, created_at, updated_at, client_key;

-- name: UpdateBlock :one
UPDATE block
SET
  document_id = $2,
  parent_block_id = $3,
  sort_order = $4,
  text = $5,
  todo_id = $6,
  updated_at = now()
WHERE id = $1
RETURNING id, document_id, parent_block_id, sort_order, text, todo_id, created_at, updated_at, client_key;

-- name: ClearBlockTodo :one
UPDATE block
SET
  todo_id = NULL,
  updated_at = now()
WHERE id = $1
RETURNING id, document_id, parent_block_id, sort_order, text, todo_id, created_at, updated_at, client_key;

-- name: DeleteBlockDocumentLinksByBlock :exec
DELETE FROM block_document_link
WHERE block_id = $1;

-- name: CreateBlockDocumentLink :exec
INSERT INTO block_document_link (
  block_id,
  target_document_id
) VALUES ($1, $2)
ON CONFLICT (block_id, target_document_id) DO NOTHING;

-- name: CountBlockDocumentLinksByTarget :one
SELECT COUNT(*)
FROM block_document_link
WHERE target_document_id = $1;

-- name: CreateCanonicalTodoForBlock :one
INSERT INTO todo (
  name,
  "desc",
  status,
  user_id,
  workspace_id,
  source_kind,
  source_document_id,
  source_block_id,
  current_document_id,
  current_block_id,
  completed_at,
  completed_document_id,
  completed_block_id
) VALUES ($1, $2, $3, $4, $5, 'block', $6, $7, $6, $7,
  CASE WHEN $3::text = 'done' THEN now() END,
  CASE WHEN $3::text = 'done' THEN $6::integer END,
  CASE WHEN $3::text = 'done' THEN $7::integer END)
RETURNING id, name, "desc", status, user_id, workspace_id, bucket, priority_rank, deadline_date, goal_id, source_kind, source_document_id, source_block_id, current_document_id, current_block_id, completed_at, completed_document_id, completed_block_id, created_at_recording_id, updated_at_recording_id, created_at, updated_at;

-- name: UpdateCanonicalTodoForBlock :one
UPDATE todo
SET
  name = $2,
  "desc" = $3,
  status = $4,
  user_id = $5,
  workspace_id = $6,
  current_document_id = $7,
  current_block_id = $8,
  completed_at = CASE WHEN $4 = 'done' AND completed_at IS NULL THEN now() WHEN $4 <> 'done' THEN NULL ELSE completed_at END,
  completed_document_id = CASE WHEN $4 = 'done' THEN $7 WHEN $4 <> 'done' THEN NULL ELSE completed_document_id END,
  completed_block_id = CASE WHEN $4 = 'done' THEN $8 WHEN $4 <> 'done' THEN NULL ELSE completed_block_id END,
  updated_at = now()
WHERE id = $1
RETURNING id, name, "desc", status, user_id, workspace_id, bucket, priority_rank, deadline_date, goal_id, source_kind, source_document_id, source_block_id, current_document_id, current_block_id, completed_at, completed_document_id, completed_block_id, created_at_recording_id, updated_at_recording_id, created_at, updated_at;
