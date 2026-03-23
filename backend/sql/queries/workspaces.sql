-- name: ListWorkspacesByUser :many
SELECT
  w.id,
  w.name,
  w.created_at
FROM workspace w
JOIN workspace_user_rel wur ON wur.workspace_id = w.id
WHERE wur.user_id = $1
ORDER BY w.created_at ASC, w.id ASC;

-- name: CreateWorkspace :one
INSERT INTO workspace (
  name
) VALUES ($1)
RETURNING id, name, created_at;

-- name: AddWorkspaceUser :exec
INSERT INTO workspace_user_rel (
  workspace_id,
  user_id,
  role
) VALUES ($1, $2, $3);

-- name: GetWorkspaceMembership :one
SELECT
  workspace_id,
  user_id,
  role,
  created_at
FROM workspace_user_rel
WHERE workspace_id = $1 AND user_id = $2;
