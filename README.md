## TypeScript workspace

Install dependencies from the repository root with `bun install --frozen-lockfile`.
Native and web share `@secretary/api`; run `bun run api:generate` after changing
Protobuf and `bun run api:check` to check generated drift. See
[`packages/api/README.md`](packages/api/README.md) for transport and identity boundaries.

Build with `bun run --cwd frontend build` and `bun run --cwd native build`.

## Atlas

From `backend/`:

```sh
atlas migrate hash
atlas migrate diff test_change --env neon --to file://sql/schema.sql --dev-url "$DEV_DATABASE_URL"
atlas migrate apply --env neon
```
