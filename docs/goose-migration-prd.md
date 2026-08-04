# Goose Migration PRD

## Summary

Replace Atlas with Goose for backend PostgreSQL migrations. The repo already uses hand-written SQL migrations, and Goose should make applying migrations simpler with less checksum/dev-database overhead.

## Goals

- Use Goose as the only migration runner for backend schema changes.
- Keep migrations as plain SQL files in `backend/migrations/`.
- Keep `backend/sql/schema.sql` as the manually maintained current-schema reference.
- Make local and deploy migration commands simple and explicit.
- Avoid mixing the migration-tool switch with unrelated product/schema changes.

## Non-Goals

- Do not redesign the database schema as part of this migration.
- Do not introduce ORM-style schema management.
- Do not require Atlas after the transition is complete.
- Do not rely on auto-generated schema diffs in the first Goose version.

## Desired Workflow

- Create forward SQL migrations in `backend/migrations/`.
- Apply locally with a command equivalent to:
  - `goose -dir backend/migrations postgres "$DATABASE_URL" up`
- Roll back only when a migration has a safe, intentional down migration.
- Update `backend/sql/schema.sql` manually in the same change as migration files.
- Run `sqlc generate` after query/schema changes.

## Migration Plan

1. Add Goose tooling to the backend developer workflow.
2. Decide whether to use the Goose CLI directly or wrap it in a small backend script/Make target.
3. Add Goose annotations to existing migration files if reusing them directly.
4. Baseline Goose against the current applied database state if annotating old migrations is not worth it.
5. Replace Atlas commands in docs/agent instructions with Goose commands.
6. Remove Atlas-only config/workflow after Goose is verified.

## Existing Migration Handling

Preferred approach:

- Keep existing migration filenames.
- Add `-- +goose Up` at the start of each migration.
- Add `-- +goose Down` only when a rollback is safe and obvious.
- For irreversible or risky migrations, use an empty/no-op Down section or document that rollback is not supported.

Alternative approach:

- Create a Goose baseline at the current production schema version.
- Keep old Atlas migrations for historical reference only.
- Use Goose only for new migrations after the baseline.

## Acceptance Criteria

- A fresh developer can run backend migrations with Goose using one documented command.
- Existing applied migrations are not accidentally rerun against the real database.
- New migrations can be created, applied, and tracked by Goose.
- `backend/sql/schema.sql`, `backend/migrations/`, and generated sqlc code remain in sync.
- Atlas is no longer required for normal backend development after the migration.

## Risks

- Existing migration files may need annotation edits.
- Baseline mistakes could cause Goose to rerun already-applied migrations.
- Losing Atlas schema diffing means humans must keep `schema.sql` accurate.

## Open Questions

- Should we annotate all existing migrations or create a Goose baseline?
- Should Goose run from a Make target, Go task, shell script, or direct CLI command?
