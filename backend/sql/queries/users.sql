-- name: ListUsers :many
SELECT
  u.id,
  u.first_name,
  u.last_name,
  u.role
FROM "user" u
ORDER BY u.id;

-- name: GetUserByEmail :one
SELECT
  u.id,
  u.first_name,
  u.last_name,
  u.role,
  u.email,
  u.password_hash
FROM "user" u
WHERE u.email = $1;

-- name: GetUser :one
SELECT
  u.id,
  u.first_name,
  u.last_name,
  u.role
FROM "user" u
WHERE u.id = $1;
