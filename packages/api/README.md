# Shared API

From the repository root:

```sh
bun install --frozen-lockfile
bun run api:generate
bun run api:check
bun run api:test
```

Requires Buf (the container uses 1.47.2). Local generator/runtime versions are pinned in workspace manifests and the root `bun.lock`. The generation check regenerates into a temporary directory and compares every output, including added/deleted files. `packages/api/src/gen` is the only supported TypeScript wire output; never edit it manually.

`createAPI({ baseUrl, getToken, onAuthFailure })` supplies generated Connect clients for documents, workspaces, TODOs, users, recordings, activities and AI. Calls accept Connect cancellation options. Auth callbacks report the captured token; the application owns session transitions. Errors preserve codes and details as `BackendError`; `persistenceDetails()` decodes typed persistence details.

Native's incremental `rpcJson` bridge validates/serializes via generated descriptors and leaves editor-friendly adaptation in `native/src/lib/backend.ts`. Wire int64s remain bigint/decimal strings; `safeInteger` is the explicit checked boundary for existing numeric app IDs. Revisions stay decimal strings.

Durable mutation replay uses `postJsonBody` with **original retained bytes**, never generated reserialization. Retention, Web Locks, IndexedDB, account epochs, and query-cache reconciliation remain app-owned. Native REST-only endpoints stay in its explicit adapter. Web TanStack Query continues owning live server caches, not drafts or mutation receipts. Native query-cache adoption remains a follow-up with document-index loading.

Future mobile clients can import `createAPI`, generated messages and identity helpers through the same workspace dependency. Supply the platform fetch implementation if necessary and keep token storage/recovery in the app. This package imports no React, Tauri or storage APIs and has no mutable session singleton; the fetch/Headers/Request/Response/AbortSignal and base64 APIs must be available in the host runtime.
