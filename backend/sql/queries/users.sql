-- name: ListUsers :many
SELECT
  u.id,
  u.first_name,
  u.last_name,
  u.role
FROM "user" u
ORDER BY u.id;
