-- name: ListAIThreadsByWorkspace :many
SELECT
  id,
  workspace_id,
  document_id,
  title,
  created_by_user_id,
  created_at,
  updated_at
FROM ai_thread
WHERE workspace_id = $1
ORDER BY updated_at DESC, id DESC;

-- name: GetAIThread :one
SELECT
  id,
  workspace_id,
  document_id,
  title,
  created_by_user_id,
  created_at,
  updated_at
FROM ai_thread
WHERE id = $1;

-- name: CreateAIThread :one
INSERT INTO ai_thread (
  workspace_id,
  document_id,
  title,
  created_by_user_id
) VALUES ($1, $2, $3, $4)
RETURNING id, workspace_id, document_id, title, created_by_user_id, created_at, updated_at;

-- name: TouchAIThread :exec
UPDATE ai_thread
SET updated_at = now()
WHERE id = $1;

-- name: DeleteAIThread :exec
DELETE FROM ai_thread
WHERE id = $1;

-- name: ListAIMessagesByThread :many
SELECT
  id,
  thread_id,
  role,
  content,
  created_by_user_id,
  run_id,
  created_at
FROM ai_message
WHERE thread_id = $1
ORDER BY created_at ASC, id ASC;

-- name: GetAIMessage :one
SELECT
  id,
  thread_id,
  role,
  content,
  created_by_user_id,
  run_id,
  created_at
FROM ai_message
WHERE id = $1;

-- name: CreateAIMessage :one
INSERT INTO ai_message (
  thread_id,
  role,
  content,
  created_by_user_id,
  run_id
) VALUES ($1, $2, $3, $4, $5)
RETURNING id, thread_id, role, content, created_by_user_id, run_id, created_at;

-- name: ListAIRunsByThread :many
SELECT
  r.id,
  r.trigger_message_id,
  r.status,
  r.mode,
  r.provider,
  r.model,
  r.request_json,
  r.response_json,
  r.input_tokens,
  r.output_tokens,
  r.latency_ms,
  r.error_message,
  r.started_at,
  r.completed_at,
  r.created_at
FROM ai_run r
JOIN ai_message m ON m.id = r.trigger_message_id
WHERE m.thread_id = $1
ORDER BY r.created_at ASC, r.id ASC;

-- name: GetAIRun :one
SELECT
  id,
  trigger_message_id,
  status,
  mode,
  provider,
  model,
  request_json,
  response_json,
  input_tokens,
  output_tokens,
  latency_ms,
  error_message,
  started_at,
  completed_at,
  created_at
FROM ai_run
WHERE id = $1;

-- name: CreateAIRun :one
INSERT INTO ai_run (
  trigger_message_id,
  status,
  mode,
  provider,
  model,
  request_json,
  response_json,
  input_tokens,
  output_tokens,
  latency_ms,
  error_message,
  started_at,
  completed_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
RETURNING id, trigger_message_id, status, mode, provider, model, request_json, response_json, input_tokens, output_tokens, latency_ms, error_message, started_at, completed_at, created_at;

-- name: UpdateAIRun :one
UPDATE ai_run
SET
  status = $2,
  mode = $3,
  provider = $4,
  model = $5,
  request_json = $6,
  response_json = $7,
  input_tokens = $8,
  output_tokens = $9,
  latency_ms = $10,
  error_message = $11,
  started_at = $12,
  completed_at = $13
WHERE id = $1
RETURNING id, trigger_message_id, status, mode, provider, model, request_json, response_json, input_tokens, output_tokens, latency_ms, error_message, started_at, completed_at, created_at;

-- name: ListAIArtifactsByThread :many
SELECT
  a.id,
  a.run_id,
  a.kind,
  a.title,
  a.content_json,
  a.created_at,
  a.applied_at,
  a.applied_by_user_id,
  a.superseded_by_artifact_id
FROM ai_artifact a
JOIN ai_run r ON r.id = a.run_id
JOIN ai_message m ON m.id = r.trigger_message_id
WHERE m.thread_id = $1
ORDER BY a.created_at ASC, a.id ASC;

-- name: GetAIArtifact :one
SELECT
  id,
  run_id,
  kind,
  title,
  content_json,
  created_at,
  applied_at,
  applied_by_user_id,
  superseded_by_artifact_id
FROM ai_artifact
WHERE id = $1;

-- name: CreateAIArtifact :one
INSERT INTO ai_artifact (
  run_id,
  kind,
  title,
  content_json,
  applied_at,
  applied_by_user_id,
  superseded_by_artifact_id
) VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING id, run_id, kind, title, content_json, created_at, applied_at, applied_by_user_id, superseded_by_artifact_id;

-- name: ListAISourceRefsByThread :many
SELECT
  sr.id,
  sr.run_id,
  sr.artifact_id,
  sr.source_kind,
  sr.source_id,
  sr.label,
  sr.quote_text,
  sr.rank,
  sr.created_at
FROM ai_source_ref sr
LEFT JOIN ai_run direct_run ON direct_run.id = sr.run_id
LEFT JOIN ai_artifact artifact ON artifact.id = sr.artifact_id
LEFT JOIN ai_run artifact_run ON artifact_run.id = artifact.run_id
LEFT JOIN ai_message direct_message ON direct_message.id = direct_run.trigger_message_id
LEFT JOIN ai_message artifact_message ON artifact_message.id = artifact_run.trigger_message_id
WHERE COALESCE(direct_message.thread_id, artifact_message.thread_id) = $1
ORDER BY sr.rank ASC NULLS LAST, sr.id ASC;

-- name: CreateAISourceRef :one
INSERT INTO ai_source_ref (
  run_id,
  artifact_id,
  source_kind,
  source_id,
  label,
  quote_text,
  rank
) VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING id, run_id, artifact_id, source_kind, source_id, label, quote_text, rank, created_at;
