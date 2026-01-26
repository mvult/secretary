## Atlas

From `backend/`:

```sh
atlas migrate hash
atlas migrate diff test_change --env neon --to file://sql/schema.sql --dev-url "$DEV_DATABASE_URL"
atlas migrate apply --env neon
```
