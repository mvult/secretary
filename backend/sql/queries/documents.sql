-- name: ListDocumentsByWorkspace :many
SELECT
  d.id,
  d.workspace_id,
  d.directory_id,
  d.kind,
  d.title,
  d.journal_date,
  d.created_at,
  d.updated_at
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
  d.updated_at
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
RETURNING id, workspace_id, directory_id, kind, title, journal_date, created_at, updated_at;

-- name: UpdateDocument :one
UPDATE document
SET
  directory_id = $2,
  kind = $3,
  title = $4,
  journal_date = $5,
  updated_at = now()
WHERE id = $1
RETURNING id, workspace_id, directory_id, kind, title, journal_date, created_at, updated_at;

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
  b.updated_at
FROM block b
WHERE b.document_id = $1
ORDER BY b.sort_order ASC, b.id ASC;

-- name: CreateBlock :one
INSERT INTO block (
  document_id,
  parent_block_id,
  sort_order,
  text,
  todo_id
) VALUES ($1, $2, $3, $4, $5)
RETURNING id, document_id, parent_block_id, sort_order, text, todo_id, created_at, updated_at;

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
RETURNING id, document_id, parent_block_id, sort_order, text, todo_id, created_at, updated_at;

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
  source_block_id
) VALUES ($1, $2, $3, $4, $5, 'block', $6, $7)
RETURNING id, name, "desc", status, user_id, workspace_id, source_kind, source_document_id, source_block_id, created_at_recording_id, updated_at_recording_id, created_at, updated_at;

-- name: UpdateCanonicalTodoForBlock :one
UPDATE todo
SET
  name = $2,
  "desc" = $3,
  status = $4,
  user_id = $5,
  workspace_id = $6,
  source_kind = 'block',
  source_document_id = $7,
  source_block_id = $8,
  updated_at = now()
WHERE id = $1
RETURNING id, name, "desc", status, user_id, workspace_id, source_kind, source_document_id, source_block_id, created_at_recording_id, updated_at_recording_id, created_at, updated_at;
