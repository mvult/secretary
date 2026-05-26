---
name: atlas-migrations
description: Create, update, re-hash, and apply Atlas migrations for this repository's backend Postgres schema. Use when changing `backend/sql/schema.sql`, editing files in `backend/migrations/`, running `atlas migrate apply`, resolving Atlas checksum mismatches, or fixing migration failures caused by real database contents not matching new constraints.
---

# Atlas Migrations

Use this skill for schema work in `backend/`.

## Repo Workflow

- Work from `backend/`.
- Atlas config is in `backend/atlas.hcl` and expects `DATABASE_URL` from env.
- Local apply command for this repo is:

```sh
set -a && source .env && atlas migrate apply --env neon
```

- Common supporting commands:

```sh
atlas migrate hash
atlas migrate diff <name> --env neon --to file://sql/schema.sql --dev-url "$DEV_DATABASE_URL"
sqlc generate
PATH="$PATH:$(go env GOPATH)/bin" buf generate proto
```

## Defaults

- Prefer forward-only migrations.
- Update `backend/sql/schema.sql` and query files together with the migration.
- Regenerate sqlc/proto code after schema or proto/query changes.
- Run targeted verification after applying migrations.

## Safe Process

1. Update `backend/sql/schema.sql` to reflect the intended final schema.
2. Add or edit the migration in `backend/migrations/`.
3. If any existing migration file changed, run `atlas migrate hash` before `atlas migrate apply`.
4. Apply with `set -a && source .env && atlas migrate apply --env neon`.
5. If schema/query code changed, run `sqlc generate`.
6. If proto changed, regenerate protobuf clients.
7. Run relevant tests/builds.

## Repo-Specific Gotchas

- Atlas will fail with `checksum mismatch` if a previously tracked migration file was edited. Fix that by running `atlas migrate hash` in `backend/` before applying.
- A migration can succeed in theory but fail against the real DB because old data violates a new constraint. In this repo, the right fix is usually to add data-normalization SQL in that migration before adding the constraint.
- Example pattern for status cleanup before tightening a check constraint:

```sql
UPDATE "public"."todo_history"
SET "status" = CASE
  WHEN "status" = 'pending' THEN 'todo'
  WHEN "status" IN ('in_progress', 'in progress') THEN 'doing'
  ELSE "status"
END
WHERE "status" IN ('pending', 'in_progress', 'in progress');
```

- Keep `backend/migrations/`, `backend/sql/schema.sql`, and generated `backend/internal/db/gen/` in sync.
- Do not assume `.env` is already loaded in the shell; source it explicitly when applying migrations.

## Verification

- Backend schema/query work: run `go test ./internal/server` from `backend/`.
- Native/frontend changes caused by proto updates: run `bun run build` in `native/` and `frontend/`.

## Completion Notes

- Report which migrations were applied.
- Mention any data cleanup SQL added to make the migration succeed.
- If backend Go behavior changed too, remind the user in all caps to rebuild/restart the Go server.
