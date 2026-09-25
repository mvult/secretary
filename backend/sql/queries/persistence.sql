-- All lock/revision/receipt writes are service-transaction primitives, not
-- standalone mutations. Authorize the scope before looking up receipts.

-- name: LockPersistenceReceipt :exec
SELECT pg_advisory_xact_lock(hashtextextended('secretary.receipt:' || sqlc.arg(receipt_key)::text, 0));

-- name: LockPersistenceWorkspace :exec
SELECT pg_advisory_xact_lock(1, sqlc.arg(workspace_id)::integer);

-- name: GetMutationReceipt :one
SELECT * FROM mutation_receipt
WHERE actor_user_id = $1 AND scope_kind = $2 AND scope_id = $3 AND mutation_id = $4;

-- name: CreateMutationReceipt :one
INSERT INTO mutation_receipt (
  actor_user_id, scope_kind, scope_id, mutation_id, protocol_version, operation,
  payload_sha256, target_ids, creation_key, result_type, result_version, result_payload
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
RETURNING *;

-- name: ListDocumentMutationTodos :many
SELECT * FROM todo
WHERE id IN (SELECT todo_id FROM block WHERE document_id = sqlc.arg(document_id))
   OR current_document_id = sqlc.arg(document_id)
   OR completed_document_id = sqlc.arg(document_id)
   OR (sqlc.arg(deleting)::boolean AND source_document_id = sqlc.arg(document_id))
ORDER BY id;

-- name: ListTodoDocumentDependencies :many
SELECT d.* FROM document d
WHERE d.id = sqlc.arg(document_id)
   OR d.id IN (SELECT document_id FROM block WHERE todo_id = ANY(sqlc.arg(todo_ids)::integer[]))
   OR d.id IN (
     SELECT unnest(ARRAY[source_document_id, current_document_id, completed_document_id])
     FROM todo WHERE id = ANY(sqlc.arg(todo_ids)::integer[])
   )
ORDER BY d.id;

-- name: LockPersistenceTodos :exec
SELECT id FROM todo WHERE id = ANY(sqlc.arg(todo_ids)::integer[]) ORDER BY id FOR UPDATE;

-- Snapshot saves own only explicit inline text/status changes. Keep standalone
-- metadata and current location; preserve completion context on text-only edits.
-- name: UpdateInlineTodo :one
UPDATE todo SET
  name = sqlc.arg(name),
  status = sqlc.arg(status),
  completed_at = CASE WHEN status IS NOT DISTINCT FROM sqlc.arg(status)::text THEN completed_at
    WHEN sqlc.arg(status)::text = 'done' THEN now() ELSE NULL END,
  completed_document_id = CASE WHEN status IS NOT DISTINCT FROM sqlc.arg(status)::text THEN completed_document_id
    WHEN sqlc.arg(status)::text = 'done' THEN current_document_id ELSE NULL END,
  completed_block_id = CASE WHEN status IS NOT DISTINCT FROM sqlc.arg(status)::text THEN completed_block_id
    WHEN sqlc.arg(status)::text = 'done' THEN current_block_id ELSE NULL END,
  updated_at = now()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: DocumentCreationKeyReserved :one
SELECT EXISTS (
  SELECT 1 FROM mutation_receipt
  WHERE scope_kind = 'workspace' AND scope_id = $1 AND creation_key = $2
);

-- name: GetDocumentByClientKey :one
SELECT * FROM document WHERE workspace_id = $1 AND client_key = $2;

-- name: CreateDocumentWithClientKey :one
INSERT INTO document (workspace_id, directory_id, kind, title, journal_date, client_key)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: CreateBlockWithClientKey :one
INSERT INTO block (document_id, parent_block_id, sort_order, text, todo_id, client_key)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: LockDocumentForPersistence :one
SELECT * FROM document WHERE workspace_id = $1 AND id = $2 FOR UPDATE;

-- name: AdvanceDocumentRevision :one
UPDATE document SET revision = revision + 1, updated_at = now()
WHERE workspace_id = $1 AND id = $2 AND revision = sqlc.arg(expected_revision)
RETURNING *;
