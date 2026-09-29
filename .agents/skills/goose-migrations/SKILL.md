---
name: goose-migrations
description: Create and validate Goose SQL migrations for the backend PostgreSQL schema, maintain the sqlc schema reference, and apply migrations after user approval.
---

# Goose migrations

- Work from `backend/`. Load `DATABASE_URL` from the intended environment.
- Goose is the migration runner. Atlas is retired; no checksum or dev database is needed.
- Create a timestamped migration: `goose -dir migrations create descriptive_name sql`.
- Write `-- +goose Up` SQL and update `sql/schema.sql` as the current-schema reference.
- Keep applied migrations immutable, including `20260928000000_baseline.sql`.
- Prefer forward fixes. If rollback is unsupported, make `Down` explicitly raise an error; never use a misleading no-op rollback.
- Wrap procedural bodies containing semicolons in `-- +goose StatementBegin` / `-- +goose StatementEnd`.
- Validate SQL migration structure without a database: `goose -dir migrations validate`.
- Regenerate query bindings with `sqlc generate` when schema/queries change.
- **Always ask before applying migrations.** After approval: `goose -dir migrations postgres "$DATABASE_URL" up`.
- Inspect the migration ledger with `goose -dir migrations postgres "$DATABASE_URL" status` only on initialized databases. Goose can create its ledger when missing.
- The current `db.evenlift.io` deployment requires `PGSSLMODE=disable`; do not disable TLS on unrelated deployments.
- PostgreSQL tests are excluded. Use database-free checks appropriate to the change.
- The baseline initializes a fresh database. An existing untracked database requires explicit schema verification and metadata-only baselining; do not run baseline DDL there.
- `scripts/baseline-existing.sql` records the one-time 2026-09-28 cutover. It rejects already initialized databases and is not a recurring migration command.

Report migrations applied and any data changes. After backend Go changes, tell the user in all caps to rebuild/restart the Go server.
