# Goose Migration — Completed

## Decision

Goose replaces Atlas. The owner chose a fresh baseline of the current schema rather than preserving migration history. Old SQL migrations, Atlas configuration/checksum files and the Atlas-specific project skill have been removed. No application data was changed.

## Current workflow

From `backend/`, load the intended environment:

```sh
set -a
source .env
set +a
# Required for the current non-TLS db.evenlift.io deployment only:
export PGSSLMODE=disable

goose -dir migrations validate
goose -dir migrations postgres "$DATABASE_URL" status
# Apply after explicit approval:
goose -dir migrations postgres "$DATABASE_URL" up
```

Create future changes with `goose -dir migrations create descriptive_name sql`.
Write `Up` SQL, maintain `sql/schema.sql` as the current-schema reference, and run `sqlc generate`. Keep applied migrations immutable. Use a safe intentional `Down` or explicitly reject rollback. The baseline's `Down` raises an error instead of deleting application data or pretending to undo it.

## Baseline

- File: `backend/migrations/20260928000000_baseline.sql`.
- Fresh empty databases execute the baseline normally using Goose `up`.
- Existing `secretary_db` on `db.evenlift.io` was marked at that version **without executing baseline DDL**.
- Tracking table: `public.goose_db_version`, containing Goose's zero version and the applied baseline.
- Old `public.atlas_schema_revisions` was dropped in the same transaction that created/populated Goose's ledger.
- The one-time SQL is retained in `backend/scripts/baseline-existing.sql` for audit. It checks the database name and completed Atlas state, rejects pre-existing Goose metadata, locks the Atlas ledger, and performs the metadata cutover atomically. It is outside the migration directory and is not a recurring setup command.
- Do not use that cutover on another populated database without separately comparing its schema. Goose `status` may initialize missing metadata, so first inspect untracked databases read-only.

## Verification and evidence

Verified against live PostgreSQL 18.6 using read-only catalog inspection and a schema export before the cutover. The schema has 31 application tables and four enum types. There are no custom public routines, non-internal triggers, views, policies, extra extensions, or non-public application tables requiring separate migration handling.

SQL AST comparison covered 436 named table/column/constraint/index/enum definitions. Differences in statement ordering, quoting, source locations, implicit versus explicit text/JSONB literal casts, explicit nullable declarations, and equivalent `IN`/`ANY` forms were normalized or reviewed. The repository schema lacked two already-live constraints, `todo_status_check` and `todo_history_status_check`; these were added to the reference and baseline, without altering the live database.

After the owner authorized the cutover:

- [x] Baseline and corrected schema reference compared equal to live application definitions.
- [x] Goose v3.27.0 `validate` passed without a database.
- [x] `sqlc generate` completed with **no generated code changes**.
- [x] Metadata-only cutover committed; baseline is marked applied and Atlas's ledger is absent.
- [x] Before/after live application-schema comparison: **436 definitions, zero differences**.
- [x] Goose `status` reports `20260928000000_baseline.sql` applied.
- [x] Goose `up` reports **no migrations to run; current version 20260928000000**.
- [x] README and agent migration guidance switched to Goose.

Fresh-database DDL execution was not performed. Validation was static SQL/Goose parsing plus live schema comparison and operational metadata verification, not a PostgreSQL test suite. Other deployment databases were not inspected or baselined.
