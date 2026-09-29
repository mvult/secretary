## TypeScript workspace

Install dependencies from the repository root with `bun install --frozen-lockfile`.
Native and web share `@secretary/api`; run `bun run api:generate` after changing
Protobuf and `bun run api:check` to check generated drift. See
[`packages/api/README.md`](packages/api/README.md) for transport and identity boundaries.

Build with `bun run --cwd frontend build` and `bun run --cwd native build`.

## Database migrations (Goose)

From `backend/`:

```sh
set -a
source .env
set +a
goose -dir migrations validate
goose -dir migrations postgres "$DATABASE_URL" status
# Apply only after approval:
goose -dir migrations postgres "$DATABASE_URL" up
```

For the current non-TLS `db.evenlift.io` deployment, export `PGSSLMODE=disable`
before connecting. Preserve the connection's TLS settings for other deployments.

Create a change with `goose -dir migrations create descriptive_name sql`, write
its `Up` SQL, and update `backend/sql/schema.sql` in the same change. Run
`sqlc generate` from `backend/` afterward. Use a genuine safe `Down` migration
or explicitly reject rollback; do not silently mark destructive changes undone.

The single `20260928000000_baseline.sql` initializes empty databases. The existing
database was baselined by recording that version without executing its DDL.
Do not run the baseline against an existing untracked database or edit it after
application. See [Goose migration notes](docs/goose-migration-prd.md).
