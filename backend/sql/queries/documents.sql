-- name: ListDocumentsByWorkspace :many
SELECT
  d.id,
  d.workspace_id,
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
  kind,
  title,
  journal_date
) VALUES ($1, $2, $3, $4)
RETURNING id, workspace_id, kind, title, journal_date, created_at, updated_at;

-- name: UpdateDocument :one
UPDATE document
SET
  kind = $2,
  title = $3,
  journal_date = $4,
  updated_at = now()
WHERE id = $1
RETURNING id, workspace_id, kind, title, journal_date, created_at, updated_at;

-- name: ListBlocksByDocument :many
SELECT
  b.id,
  b.document_id,
  b.parent_block_id,
  b.sort_order,
  b.text,
  b.status,
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
  status,
  todo_id
) VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id, document_id, parent_block_id, sort_order, text, status, todo_id, created_at, updated_at;

-- name: UpdateBlock :one
UPDATE block
SET
  document_id = $2,
  parent_block_id = $3,
  sort_order = $4,
  text = $5,
  status = $6,
  todo_id = $7,
  updated_at = now()
WHERE id = $1
RETURNING id, document_id, parent_block_id, sort_order, text, status, todo_id, created_at, updated_at;
