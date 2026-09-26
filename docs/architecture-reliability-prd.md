# Architecture and Persistence Reliability PRD

## 1. Summary

- **Context:** Secretary has a React/Tauri desktop client, a React web client, a Go/ConnectRPC backend, PostgreSQL, and a Python recording TUI. A React Native client is planned in `docs/PRD.md`.
- **Scope:** Implement the first five priorities from the architecture review: explicit session states and durable drafts; reliable document saves; shared document/TODO application services; a shared generated TypeScript API client; and document-scoped state and undo.
- **Goal:** An edit is either acknowledged by the server, durably retained locally, or visibly conflicted. Authentication and network failures must not masquerade as an empty workspace or successful persistence.
- **Delivery:** Incremental changes to the existing applications and APIs. Keep the single backend deployment and existing editing workflows.
- **Status:** Phase 1 draft recovery, startup batching and save-identity fixes are implemented. Phase 2 internal transactional document services and backend writer locking/revision participation are implemented; the public versioned protocol remains gated pending client/controller and coordinated activation work. See Section 9 and [Persistence Contract and Writer Inventory](persistence-contract.md) for current evidence and remaining limits.

### Confirmed decisions

1. Resolve concurrent edits manually. Preserve the local draft and offer comparison, an explicit server reload, or saving a separate copy. No automatic merging in this effort.
2. Support offline editing of cached notes/journals and creation of local drafts. Do not build full offline workspace replication or a general offline queue for moves and deletions.
3. Defer the Python TUI's migration to backend APIs. Consolidate backend/API/AI document and TODO mutations now and document direct TUI writes as an exception.
4. Preserve Go, ConnectRPC/Protobuf, sqlc/pgx, PostgreSQL, React, Tauri, Bun, and existing JWT login. Use the repository's active migration workflow; do not change authentication or migration technologies as part of this effort.
5. The owner is the only client user. Coordinate app/server updates directly; no extended legacy-client rollout window or fleet inventory is needed.

### Non-goals

- Implementing the mobile application itself.
- CRDTs, collaborative cursors, automatic block merges, or full offline synchronization.
- AI model selection changes or durable AI job execution; those were the sixth review priority.
- Moving audio capture, transcription, or Python processing into Go.
- Microservices, a message broker, generic repository frameworks, or a wholesale editor rewrite.
- Redesigning TODO lifecycle semantics, journal date rules, or the keyboard-first native UI.
- General deployment/observability cleanup beyond diagnostics and checks needed to verify these changes.

### Relationship to existing requirements

- `docs/PRD.md` remains the mobile product scope. This PRD supplies the shared persistence/API foundation and replaces its earlier recommendation to copy manual native API wrappers.
- `docs/todos-system-prd.md` defines TODO behavior. Service extraction must preserve source/current/completion references, buckets, permissions, and history.
- `docs/native-performance-optimization-prd.md` covers the narrower render optimization pass. This PRD separately authorizes document-scoped history, caching, loading, and persistence changes.
- `docs/goose-migration-prd.md` describes a separate migration-tool transition. Atlas is the currently configured workflow at authoring; recheck the active workflow before implementation if that transition has landed.

## 2. Users and Core Flows

### Primary users

- Existing keyboard-first desktop users creating and editing notes, journals, and inline TODOs.
- Existing web users changing TODOs that may be represented in documents.
- The same user on multiple devices, including the future mobile client.
- Backend AI tools acting on documents while a client may hold an editable copy.

### Required flows

1. **Startup:** Show available cached state, validate the session, and refresh the workspace. Distinguish loading, failed loading, reauthentication, and a successfully empty workspace.
2. **Interrupted connection:** Continue editing a cached document, persist the draft locally, and resume saving after connectivity and authentication recover.
3. **App restart:** Restore retained drafts and reconcile any interrupted save before submitting newer changes.
4. **Editing during a save:** Acknowledge only the submitted snapshot, preserve newer edits, and submit the remaining changes afterward.
5. **Concurrent edit:** Reject a stale save without changing server content; retain the local draft and show the server version for manual resolution.
6. **Lost create response:** Retry the same operation without creating a duplicate note, block, or TODO.
7. **TODO or AI mutation:** Apply the same domain rules and document revision rules as an editor save.
8. **Navigation and undo:** Navigate without losing edits, and undo content changes within the active document without restoring unrelated documents or old transport identities.

## 3. Data and Persistence

### 3.1 Authoritative state and ownership

| State | Owner | Durability and responsibility |
| --- | --- | --- |
| Committed documents, blocks, TODOs, revisions | Backend application services/Postgres | Authoritative shared state |
| Auth and selected backend/account/workspace | Client session controller | Stored session metadata; explicit validation and expiration handling |
| Last fetched index and document bodies | Client server cache | Useful cached snapshots, never evidence that a draft was saved |
| Local draft and pending save envelope | Client draft repository/save controller | Durable recovery state independent of React renders |
| Selection, caret, navigation, modal state | UI/editor state | Ephemeral; does not determine persistence acknowledgment |
| Undo history | Per-document editor history | Content changes only; session-local history in this release |

### 3.2 Database changes

Continue using the configured PostgreSQL `DATABASE_URL`; do not embed connection strings in documentation or tests. No database access or migrations are required to author this PRD.

Required logical additions:

- **Document revision:** A monotonically increasing revision on each document, returned with document snapshots and index entries. Backfill existing documents to an initial revision.
- **Stable client identities:** Persist a document client key and block client keys, backfilling existing rows. Keep existing integer primary keys and references. Document keys must be unique within a workspace; block keys within a document.
- **Mutation receipts:** Store a client-generated mutation ID, its authenticated/workspace scope, operation identity, canonical payload fingerprint, and the acknowledged result/identity mapping. Store the receipt atomically with the successful mutation.

The implementation may use a focused receipt table and additive columns. Exact DDL, indexes, backfill approach, and receipt storage format are an implementation checkpoint. Existing history is for recovery/browsing and does not substitute for revision checks or mutation receipts.

Do not expire receipts in this release until a supported retry horizon exists. Replaying an old operation must not recreate a subsequently deleted resource. Client-key uniqueness alone is insufficient for replaying a response whose blocks were also created.

### 3.3 Local storage

- Use IndexedDB behind a small draft/cache repository for the native webview. Keep simple preferences/session settings in their current storage unless a change is required for scope isolation.
- Do not add a Rust/SQLite bridge solely for this effort. Storage adapters must be replaceable for a future mobile implementation.
- Scope all cached data and pending operations by normalized backend identity, user ID, and workspace ID. An endpoint, account, or workspace change must not rebind existing drafts.
- Persist the latest draft, stable local keys, base server revision, acknowledged baseline, local edit generation, and any pending request's exact payload and mutation ID.
- Persist an in-flight request envelope before sending it. On restart, resolve/replay that envelope before sending later edits for that document.
- Retain dirty and conflicted drafts until acknowledged or explicitly discarded. Cache eviction must never remove them.
- Bound clean cached document bodies with an LRU policy; initially retain up to 100 clean recent documents, excluding open and dirty documents. Handle quota/write failures explicitly rather than reporting successful local persistence.
- Queue local persistence promptly after edits, independently of the network-save debounce. Show local persistence failure as a distinct state. Do not rely on `pagehide` or app termination to write the last draft.
- Draft durability means a successful local transaction is recoverable after restart. An edit still awaiting that transaction must not be labeled locally retained or saved.
- Use a versioned local schema and non-destructive upgrades. A failed upgrade must leave the recoverable payload intact.

### 3.4 Offline scope

- Allow content/title edits and inline TODO changes within cached documents.
- Allow new local note/journal drafts using stable client keys. Sync them only after account/workspace access is validated.
- Note creation may target a known directory. If that directory disappears before sync, retain the draft and require a valid destination.
- Require a connection for document/directory deletion, moving existing documents between directories, and standalone TODO mutations outside the document editor. Do not pretend these actions were queued offline.
- An uncached body is unavailable offline even if its index entry is cached. Display that distinction; never substitute a blank editable body.
- Offline full-text search covers cached bodies and must identify its limited scope. Online search must cover the workspace.

## 4. Architecture and Functional Requirements

### 4.1 Explicit session and loading states

Create a session controller with explicit states such as `restoring`, `signed-out`, `validating`, `ready`, `reauth-required`, and `unavailable`. Keep workspace-request state separate from auth state; a network failure is not proof that a token is invalid.

- Use an authenticated session lookup, reusing an existing endpoint if suitable or adding a small typed endpoint. Validate the selected workspace against current access.
- An authentication rejection transitions to `reauth-required`, pauses remote saves, and exposes a concise login action. Preserve local drafts and last known data.
- A permission denial identifies unavailable workspace/document access. A transport failure leaves session validity unknown and provides retry. Do not classify either as an empty workspace.
- After successful login, validate the account/workspace before resuming pending saves. Ignore late responses from a previous session scope.
- Manual logout clears credentials and hides account-specific cached content. Retain unresolved drafts under the original account scope for recovery after that account logs in; provide an explicit discard action.
- Successful remote loading of zero documents is the only basis for the empty-workspace state. A local cached index can be labeled cached/stale, not presented as a successful fresh result.
- Do not create and upload an empty journal as a consequence of failed initial loading. Opening today's journal may create a local draft, with server uniqueness resolved by the journal rules below.
- Ordinary startup refresh must not require the existing blanket overwrite confirmation. Refresh clean cache entries; preserve dirty drafts and handle divergence through the conflict workflow.
- Keep state visible with minimal status text and explicit shortcuts/actions, consistent with the native power-user interface.

### 4.2 Document save protocol

Continue full-document snapshot saves initially. Add typed request/response fields for an expected revision, a mutation ID, stable client keys, and the acknowledged revision/result.

**Server requirements:**

1. Authorize the operation and scope before accessing mutation receipts or document data.
2. Detect an already committed mutation before evaluating a new revision conflict. An exact replay returns its original acknowledged result; reuse of the same key for a different payload is an error.
3. For an existing document, atomically check the expected revision and perform all content/TODO/link/history changes in one transaction. A mismatch returns a typed conflict and causes no partial writes.
4. Advance the revision for successful mutations that change the document's persisted or save-relevant representation, including title/directory changes and inline TODO state. No-op detection may avoid a bump; a replay must always avoid another bump.
5. Return complete client-key-to-server-ID mappings for saved documents/blocks. Clients must not guess identities by array position.
6. Record the receipt and mutation result in the same transaction as the content changes. Concurrent duplicate requests must produce one mutation.
7. Preserve journal uniqueness by workspace/date. A create-on-open operation that finds an existing journal returns that existing document without replacing its contents. A nonempty local journal draft then enters manual resolution if it cannot be acknowledged as the same content.
8. Treat a remotely deleted document as a recovery conflict/not-found state. Retain the draft for saving as a new note; do not silently recreate the deleted document under a new identity.
9. During rollout, return a typed upgrade/precondition error for unsupported unversioned writes once enforcement is active. Never silently bypass the revision check for legacy clients.

**Client save-controller requirements:**

- Implement a headless, testable controller independent of React component lifetime, with one active request per document and bounded concurrency across documents.
- Track the latest local draft separately from the exact submitted snapshot and acknowledged baseline. Use local edit generations for dirty tracking rather than repeatedly hashing the entire workspace.
- Expose at least `clean`, `locally-persisting`, `pending`, `saving`, `failed`, and `conflicted`, plus reasons such as offline or reauthentication. UI wording must distinguish local retention from server acknowledgment.
- Preserve the current 10-second network debounce initially; navigation/manual save can request a flush. Local durability does not wait for that debounce.
- A response acknowledges only its submitted generation. If newer edits exist, preserve them and schedule the next save using the newly acknowledged revision.
- Retry an uncertain request with the same mutation ID and unchanged payload. Submit newer edits with a new mutation ID only after resolving the prior request.
- Pause on auth/permission/conflict/validation errors. Use bounded backoff for transient failures and retry on reconnect or explicit request, without an infinite tight loop.
- Leaving an editor view must not cancel the document's save controller or discard its draft. A pending request from a previous account scope must not mutate current UI/cache state.
- Recovered stale block identities must not trigger automatic recreation that defeats conflict detection. Preserve and surface the draft if its identity mapping is invalid.

### 4.3 Manual conflict resolution

- Preserve the local draft and its base snapshot while retrieving the latest authorized server snapshot.
- Present local and server content for comparison, with a clear indication that the server changed since the base revision.
- Provide explicit actions to continue manual resolution, discard the local draft and use the server copy, or save the local content as a separate note.
- A manually resolved version must be saved against the newly reviewed revision; another concurrent change must conflict again. There is no unconditional force-save route.
- Saving a separate copy uses fresh document/block creation keys and a new mutation ID, while preserving outline structure and text.
- Copies must not reuse existing TODO identities/current-location links. Inline TODO markers create independent TODOs when saved. Recovery copies of journals become ordinary notes, preserving journal uniqueness.
- Reloading cached data, reauthentication, or a background refresh must not silently resolve a conflict or discard either version.

### 4.4 Shared document and TODO application services

Introduce focused Go application services outside the HTTP transport layer. Keep concrete service types and use sqlc directly; introduce interfaces only for actual adapter/test boundaries.

```text
Connect/HTTP handlers ----+
AI mutation adapters -----+--> Document/TODO application services --> sqlc/Postgres
Backend background work --+
```

- Handlers own request decoding and transport error mapping. Services own authorization, domain validation, transaction boundaries, identity/revision rules, and related updates.
- Replace synthetic calls from AI tools to Connect handlers with direct service calls.
- Route editor saves, AI document creation/insertion/movement, document deletion, and TODO operations affecting document bodies/inline state through shared mutation rules.
- Preserve current TODO source, current location, completion context, history, permissions, and document-link behavior. Document saving must not independently invent a second TODO lifecycle.
- When a TODO mutation changes a representation returned in one or more document snapshots, advance affected document revisions in the same transaction. Lock multiple affected documents in a deterministic order.
- Document all in-scope mutation entry points and add tests demonstrating that each participates in revision enforcement. A stale full-document save must not undo a newer AI or TODO mutation.
- Keep the Python TUI's direct recording/TODO writes explicitly listed as a deferred exception. Audit those paths for document-linked updates before claiming complete revision coverage. If they bypass a required invariant, record the limitation and request a narrowly scoped follow-up decision rather than silently expanding into a TUI rewrite.

### 4.5 Shared generated TypeScript API package

- Add a workspace package, initially `packages/api`, consumed by `native/` and `frontend/` through Bun workspace dependencies.
- Generate clients/types from the repository's Protobuf definitions, including documents, workspaces, TODOs, users, recordings, activities, and AI.
- Align supported Protobuf/Connect runtime and generator versions, pin generation tools, and document one reproducible generation command. Verify generated outputs are current in automated checks.
- Keep JWT login and existing REST-only endpoints supported through small typed adapters; this effort does not require converting every endpoint to RPC.
- Centralize transport configuration, bearer-token injection, cancellation, and typed error classification. The transport reports authentication failures; the session controller owns the resulting UI/session transition.
- Preserve wire error codes/details instead of reducing every response to a message string or using regular expressions to identify auth/conflicts.
- Keep 64-bit IDs/revisions lossless. Convert them deliberately at an application boundary when needed; do not silently coerce arbitrary Protobuf `int64` values into JavaScript numbers.
- Keep React, Tauri, DOM storage, editor types, UI components, and global mutable session state out of this package so mobile can consume it later.
- Replace native handwritten wire models/normalizers incrementally and move the web clients onto the same transport contract. Keep explicit domain adapters where editor-friendly types differ from generated messages.
- Use TanStack Query for client server-backed indexes/lists/details and invalidation. Draft state and the save queue remain independent of query cache replacement/refetch behavior.

### 4.6 Document-scoped state, loading, and undo

- Separate the lightweight document/directory index from loaded document bodies, local drafts, and UI navigation/selection state.
- Add a metadata-only, paginated document-index API with ID/client key, kind/date/title, directory, revision, timestamps, and any deliberately bounded journal preview fields.
- Keep the existing full-document list API during compatibility rollout; native must stop depending on it for normal startup/navigation.
- Fetch bodies on open and prefetch a bounded nearby set for journal navigation. Large workspaces must not require downloading every block before editing the selected note.
- Introduce workspace full-text search backed by PostgreSQL, with stable ordering, pagination, snippets, and access checks. Preserve current title/body search behavior as closely as possible. Overlay matching local drafts without falsely claiming uncached offline coverage.
- Document links and directory browsing should resolve from the index without loading all bodies. Search/navigation tests must include results outside the first index page.
- Keep each document's editor state and undo history separate. Navigation does not count as a content undo operation.
- Undo restores user-editable content and stable logical block identity, not cached server snapshots, server revisions, mutation receipts, credentials, or unrelated pages.
- Maintain server-ID mappings outside undo snapshots. Undoing a server-acknowledged block deletion creates a new insertion identity; it must not submit a deleted server block ID as still existing.
- Keep up to 100 grouped undo entries per document for this release, preserving current grouping semantics where practical. Drafts survive restarts; full undo-history persistence is out of scope.
- A clean remote replacement resets that document's obsolete undo history. Dirty documents enter conflict handling rather than being replaced. No undo action should reverse another device's edit unintentionally.
- Dirty tracking, draft persistence, and editor undo operations must not clone or serialize the full workspace. Preserve working keyboard motions, visual selection, block trees, journal navigation, and TODO indicators.

## 5. Technology Choices and Repository Boundaries

| Area | Decision |
| --- | --- |
| Backend | Existing Go, ConnectRPC/Protobuf, sqlc/pgx, net/http, Postgres |
| Auth | Existing email/password login and bearer JWT; explicit validation/reauth, no refresh-token redesign |
| Native | Existing React/Tauri/Vite, pure editor transformations, Bun tooling |
| Server cache | TanStack Query; explicitly separate from durable drafts |
| Local drafts | IndexedDB repository with scoped/versioned records |
| API sharing | Bun workspace package with generated Connect clients and small adapters |
| Client state | Focused controllers/stores; a wholesale Zustand conversion is not required |
| Migrations | Active project workflow; Atlas at authoring, separate Goose transition tracked elsewhere |

Suggested responsibility boundaries, not a requirement to create empty framework layers:

```text
packages/api/                     generated clients, transport, typed wire errors
backend/internal/documents/       document application service and mutation rules
backend/internal/todos/           TODO application service and shared lifecycle
backend/internal/server/          transport handlers and adapter composition
native/src/features/session/      session controller and login/settings integration
native/src/lib/storage/           scoped draft/cache repository
native/src/features/notes/        per-document draft/save controllers
native/src/features/outline/      pure editing operations and document-scoped undo
```

Resolve package dependencies so document/TODO coordination does not create Go import cycles. A small shared application package is acceptable if it keeps the transactional owner explicit.

## 6. Live Implementation Checklist and Delivery Order

Update this checklist as work lands. Completed work must include its required verification; record follow-ups and the next active task instead of treating a compiling refactor as completion.

### Phase 0: Contracts and baseline

- [x] Review representative architecture and failure paths.
- [x] Confirm manual conflicts, cached-document offline editing, and deferred TUI migration.
- [x] Record the five-priority scope and coordinate with the mobile PRD.
- [x] Inventory source-level document/TODO writers, repository client versions, and generated client/toolchain versions; record the TUI exception in `docs/persistence-contract.md`.
- [x] Specify revision/error/receipt semantics and local storage records before implementing the protocol; see `docs/persistence-contract.md`.
- [x] Confirm rollout scope: owner is the only client user; coordinate app/server updates without an extended compatibility window.
- [ ] Capture representative small/large workspace fixtures and baseline startup/edit/undo profiles.
- [ ] Record reproducible regression cases for auth failure, in-flight edits, duplicate retries, AI changes, and stale TODO state.

### Phase 1: Session states and durable drafts

- [x] Add explicit session/workspace loading states and centralized auth-error handling.
- [x] Add scoped/versioned draft storage and startup recovery, including local-storage failure reporting.
- [x] Persist pending draft state independently of network save timing.
- [x] Preserve cached content through reauthentication and validate scope before resuming saves. Legacy uncertain saves pause for comparison rather than replaying without receipts.
- [x] Remove the failed-load-to-empty-workspace behavior and blanket refresh overwrite path, including journal creation inside editor hydration.
- [x] Verify expired-token startup, cached offline edits, account switching, and restart recovery with hook/IndexedDB tests (`bun test`: 35 passing including subsequent undo regressions; `bun run build`: passing).
- [x] Fix blank-journal conflict regression: preserve server snapshots, render review controls beside each conflicted document, derive restored conflicts from draft records, and adopt only provably untouched generated placeholders. Cover actual journal rendering and journal creation during startup; apply UUID-generating actions once.
- [x] Owner confirmed the journal recovery fix works in the running app. This is narrower than completion of the full packaged-webview smoke checklist.
- [x] Bound journal/note status labels to a fixed 24ch slot (maximum 40% of heading width), truncate with ellipsis, and expose the full displayed text on hover.
- [x] Debounce ordinary saving-status presentation by 3.5 seconds; errors/conflicts remain immediate. Do not delay local persistence or alter the existing 10-second network-save debounce.
- [x] Wrap long settings text, including WhatsApp pairing payloads, within constrained grid columns; allow settings buttons to wrap.
- [x] Correct the misleading `validating`/`offline` labels during full-workspace loading. Distinguish authentication, document loading, local-cache persistence, and genuine failures without weakening save/conflict guards.
- [ ] Smoke-test IndexedDB durability and the recovery UI in the packaged Tauri webview on the owner's machine; automated tests use fake-indexeddb and mocked HTTP.

### Phase 2: Reliable document save contract

- [x] Prepare additive schema/migration and generated query/API definitions for revisions, client identities, and mutation receipts; reject versioned writes until the transactional service is implemented.
- [x] Owner reports applying the prepared foundation migration. This is not yet a versioned save rollout.
- [ ] Validate migration/backfill/constraints on a dedicated disposable database.
- [x] Regenerate sqlc/Protobuf outputs and implement internal transactional save/delete services with atomic revision checks and receipt replay. Public protocol activation remains gated; database integration execution is pending.
- [x] Make document list/get reads snapshot-consistent using read-only repeatable-read transactions.
- [ ] Make every in-scope backend writer revision-aware, including AI and document-linked TODO operations.
- [ ] Implement the headless per-document save controller and durable pending request envelopes.
- [ ] Implement manual conflict comparison/reload/copy and safe journal create-on-open behavior.
- [ ] Verify lost responses, concurrent retries, edits during saves, deletes, and fresh-ID recovery copies.
- [ ] Coordinate client/backend rollout and activate rejection of unversioned writes only when supported clients are ready.

### Phase 3: Shared document/TODO services

- [ ] Move mutation ownership and authorization/transaction rules into application services.
- [ ] Route Connect handlers and AI tools through those services; remove synthetic handler calls and duplicated domain mutation paths.
- [ ] Preserve TODO lifecycle/link/history semantics and record the deferred TUI exception.
- [ ] Run integration tests across editor/API/AI/TODO paths, including multi-document mutations.

### Phase 4: Shared generated client package

- [ ] Establish `packages/api` and aligned, reproducible generation/runtime dependencies.
- [ ] Migrate native and web to shared clients, typed errors, and deliberate identity/revision adapters.
- [ ] Add query-cache integration without moving draft ownership into server cache.
- [ ] Update container/build code-generation paths for the workspace package.
- [ ] Verify native and web builds, API compatibility, and generated-output drift checks.
- [ ] Document how the future mobile client consumes the package.

### Phase 5: Document-scoped state and undo

- [x] Fix the immediate undo regression: unchanged commits/cursor-only changes do not add history; undo restores prior content without reopening the newer draft buffer and skips legacy no-op snapshots. This does not complete document-scoped history or transport-identity separation below.
- [x] Instrument native load stages and backend document query count/time; expose latest native timings in Settings.
- [x] Capture the owner's full-workspace startup baseline: 941 queries / 91.83 seconds backend time; block/TODO reads dominate. See Section 9.
- [x] Batch workspace blocks and linked TODO statuses into one read, reducing successful `ListDocuments` calls to four queries; verify SQL results against the existing workspace using read-only queries.
- [ ] Collect post-batching startup/Sync now measurements and representative small/large workspace comparisons; run the database integration regression on dedicated test infrastructure.
- [ ] Add paginated document index and workspace search APIs.
- [ ] Migrate native startup/navigation to index-plus-on-demand bodies and bounded caching.
- [ ] Move draft dirty tracking and undo to document-local state with stable identity mapping.
- [ ] Remove whole-workspace cloning/hashing from ordinary edit/persistence/undo paths.
- [ ] Verify search completeness, journal navigation, links, selection, and TODO behavior.
- [ ] Compare before/after profiles using identical fixtures; document results and remaining bottlenecks.

### Phase 6: Integrated release verification

- [ ] Run the acceptance scenarios below against the integrated client/backend build.
- [ ] Run database integration tests on a dedicated test database in CI/target infrastructure and make skipped required tests fail that job.
- [ ] Validate migration/backfill on disposable representative data after approval.
- [ ] Verify deployment compatibility and restart recovery with retained local drafts.
- [ ] Document operational commands, architecture ownership, limitations, and rollback behavior.

**Dependencies:** These phases express investment priorities, not rigid implementation silos. Minimal application-service extraction and client generation needed to implement the revision contract may land in Phase 2. Revision enforcement must not ship while an in-scope backend writer bypasses it. Phase 4 becomes the only shared API implementation before mobile work copies another client. Phase 5 builds on the stable draft/save contract.

**Next action:** Resume from the latest Section 9 handoff. The internal transactional save/delete service is implemented behind the protocol gate. Obtain a dedicated, migrated persistence-test database/CI target and execute its integration suite, then make legacy/editor, AI, TODO and directory writers participate in the lock/revision discipline. Implement native durable envelopes and baseline adoption before protocol activation. Startup batching and the save-time row displacement correction are already implemented.

## 7. Acceptance Criteria and Verification

### Required behavioral scenarios

| Scenario | Pass condition |
| --- | --- |
| Expired/invalid token at startup | Cached content/drafts remain available in the appropriate account scope; UI requests login and does not report an empty successful sync |
| Server unavailable | No credentials are cleared solely due to transport failure; local editing/persistence works for cached bodies |
| Restart after local draft commit | Exact retained text/outline is recovered and remains dirty until server acknowledgment |
| IndexedDB failure/quota exhaustion | UI exposes local durability failure and never claims the draft is safely retained |
| Edit while save is in flight | Response acknowledges only the submitted snapshot; newer text remains pending and is subsequently saved |
| Commit succeeds, response is lost | Replaying the persisted request returns the original acknowledgment without duplicate content, revisions, or TODOs |
| Same mutation ID, different payload | Typed rejection; no second mutation |
| Another client/AI changes the note | Old revision is rejected atomically; local draft and server content both survive |
| TODO changes inline representation | Affected document revisions advance; stale document snapshots cannot reverse that change |
| Two clients open a missing daily journal | One journal exists; neither client overwrites the other's nonempty contents through a create path |
| Remote deletion while a draft exists | Draft remains recoverable as a separate note; no automatic resurrection |
| Conflict copy | Text/tree retained; fresh identities used; existing TODO location/history is not stolen |
| Logout/account/backend switch | No request/draft/cache is replayed into another scope; original drafts can be recovered by the original account |
| Undo after save or block deletion | Only the active document's intended edit changes; no deleted server ID is submitted as live |
| Search after lazy loading | Online results include authorized matches outside cached bodies and the first index page; offline scope is explicit |
| Existing native workflows | Keyboard selection/motions, document links, TODO lifecycle, and journal date behavior remain functional |
| Older client during enforcement | Receives an actionable upgrade/precondition error rather than an unsafe unversioned write |

### Structural and performance acceptance

- Normal native startup uses metadata/index plus selected/prefetched document bodies, not an all-block workspace download.
- Changing a document does not clone/hash other document bodies or place their snapshots in its undo history.
- Clean cache and undo history remain bounded; dirty drafts are not evicted to meet clean-cache limits.
- Profiles against the same representative workspaces show reduced full-workspace work and no unexplained editing/navigation regression. Record measurements; do not claim performance success from code inspection alone.
- Shared wire types/clients come from Protobuf generation, with explicit REST adapters for remaining endpoints. Both existing TypeScript applications compile against them.
- In-scope business mutation entry points share service-level rules and have integration coverage. A source-level inventory records any remaining direct writer exception.

### Test and check strategy

- Pure unit tests: save-controller transitions, replay identity, scope isolation, editor undo semantics, and stable identity mapping.
- Repository/controller tests: local commit/restart recovery, schema upgrades, quota failures, and uncertain in-flight operations using a controllable storage/transport implementation.
- Backend integration tests: atomic revisions, duplicate requests, journal uniqueness, TODO reconciliation, AI/service parity, and concurrent mutations using a dedicated Postgres database.
- Client integration/smoke tests: reauthentication, conflict handling, offline cached editing, lazy-loading/search, and keyboard behavior.
- Required checks: focused Go tests, TypeScript checks, native/web production builds, Protobuf/sqlc generation consistency, and static Compose validation if deployment inputs change.
- Database-test CI must supply its dedicated database and report required test execution explicitly; a suite skipped for missing `DATABASE_URL` is not evidence of passing persistence tests.
- The local macOS environment has no Docker daemon. Runtime database/container validation belongs in CI or on the target server. Do not run database-writing tests against the application database or apply migrations as an implicit part of a test command; migration application requires separate approval.

## 8. Rollout, Checkpoints, and Open Questions

### Compatibility and migration rollout

1. Prepare additive schema/backfills and compatible API/client fields. Preserve existing primary keys, content, and references.
2. Implement revision participation in every in-scope backend write path; migrate supported native/web writers and AI adapters.
3. Verify draft-store upgrades and preserve pre-upgrade local keys/pending operations. Do not clear local state to simplify rollout.
4. Activate enforcement with a coordinated client/backend release. Old writers get explicit precondition errors; never silently fall back to last-write-wins.
5. Keep legacy read APIs until consumers migrate. Retire handwritten wire wrappers only after contract/build verification.
6. Rollback may retain additive columns/receipts and disable new writes with an actionable message. Do not roll back to a writer that bypasses enforced revision protection or discard draft storage.

### Checkpoints requiring guidance

- Review exact schema/backfill and API compatibility changes before database application. **Always obtain explicit permission before applying migrations**, using the active project migration skill/workflow.
- Ask before widening scope into TUI migration, automatic merge, full offline mutation replication, changing journal/TODO product semantics, or replacing auth/migration technology.
- Pause if the mutation inventory finds a direct writer that invalidates the promised revision protection and cannot be covered within the agreed scope.
- Before production enforcement, confirm supported client versions/deployment order and report completion of required acceptance tests.

Continue autonomously through implementation and focused verification within agreed scope. Record blockers, test evidence, and checklist progress rather than repeatedly requesting approval for routine refactoring.

### Remaining implementation and rollout questions

- What capability/precondition signal will accompany the coordinated owner-only app/server update? An extended client transition window is not required.
- What are the reviewed DDL/indexes/backfill implementing the logical receipt, key and revision contract? Fingerprinting and deleted-resource replay semantics are specified in `docs/persistence-contract.md`.
- Do runtime regression fixtures confirm the source-audited TODO/cascade effects and preservation rules in `docs/persistence-contract.md`?
- Has the separate Goose migration transition landed by implementation time, or is Atlas still active?
- Which dedicated test database/CI runner and representative workspace fixtures are available for integration and performance checks?

### Known limitations after this effort

- The TUI remains a direct database client until its separate migration. The revision guarantee is explicitly bounded by the audited write paths.
- Offline access covers cached bodies and local drafts, not every historical note or all mutation types.
- Conflicts require manual resolution; this release does not promise automatic cross-device merging.
- Existing AI request-lifetime/job-recovery limitations remain outside scope.

## 9. Continuation Notes — Owner Feedback and Current State (2026-09-23)

### Scope and decisions to preserve

- The owner is the only client user. Coordinate native/web/backend updates directly; do not spend time designing an extended fleet-compatibility window.
- The owner explicitly chose to start with session handling and local draft durability before backend schema work. This implementation changed native code and local IndexedDB storage, not Postgres schema or Go backend code.
- Postgres revisions, persisted client keys and mutation receipts remain proposed Phase 2 additions. They solve concurrent-write and uncertain-retry problems that caching alone cannot solve. No migration has been applied.
- Existing product decisions stand: manual conflicts, cached-document offline editing/new local drafts, deferred TUI migration.

### Blank journal incident: observed, investigated, fixed

1. After the initial implementation, today's journal appeared as one/two blank lines with `review below`, and no discoverable review controls.
2. Read-only server inspection found journal **225**, workspace **4**, dated **2026-09-23**, with **59 nonempty blocks / 2,045 text characters**, last updated **18:26:59 UTC**. History entries **914** and **913** also contained substantial text. These are incident-time observations, not a permanent assertion about current data. No server content or history was modified during inspection or the fix.
3. The reconciliation code retained a blank local draft while removing the matching populated server journal from the visible set. It did not retain a usable server snapshot for comparison. The separate conflict-list state was also not restored with IndexedDB records, so a conflict label could exist without controls. When controls did render, they were below the entire journal stack.
4. Fixed by retaining `serverCopy` on each conflict record, deriving conflict controls from those same records, and rendering **Review conflict** directly beneath the affected journal/note header. Cached comparison works offline. **Use server copy and discard local draft** fetches the identified server document and replaces the local record; it does not save over the server document. A local journal without its own backend ID resolves through the matched server copy's ID.
5. Newly generated blank journals carry a placeholder fingerprint. It is permanently removed on editing, including typing and then erasing. Only proven untouched placeholders without a baseline, server ID, or uncertain save adopt the matching server journal automatically. Legacy/ambiguous blanks and intentional deletions of existing content require review.
6. An integration regression test exposed another bug: the session wrapper ran UUID-generating reducer actions once for its refs and again through React, producing different identities. It now computes the state once and passes that state to React via `applySessionState`.
7. **Owner subsequently confirmed: “ok that worked.”** Preserve these regression tests and do not clear IndexedDB to simplify future changes.

### UI feedback addressed afterward

- Long status text made headings shift/flicker: fixed width, ellipsis and native hover `title` on note/journal status spans.
- Frequent status transitions were distracting: `native/src/features/session/useSaveStatus.ts` debounces ordinary displayed text by **3.5 seconds**, but switches document/account context immediately and exposes urgent errors/conflicts immediately. This is presentation only.
- WhatsApp pairing payload escaped the settings right boundary: constrained settings grids and wrapping for messages/inline code, plus wrapping action buttons. The full payload remains readable/copyable rather than truncated.

### Current unresolved issue: slow full-workspace refresh

**Observed:** the owner saw `Retained locally · offline` after editing, while Settings showed `validating · workspace 4`. It eventually completed; the owner clarified it was very slow, not permanently stuck. Do not describe a proven request hang or token failure.

**Original findings before loading instrumentation:**

- `useSessionSync.ts` sets `validating` before `ListWorkspaces` and keeps that label through `ListDocuments` and local cache persistence. It does not transition to `ready` or enable server saves until the entire sequence completes.
- Its save-status fallback calls several non-ready states `offline`, even when the app is connected and still loading. Local editing/retention can work while server saves remain paused.
- `backend/internal/server/documents.go:ListDocuments` fetches document metadata, then awaits one `ListBlocksByDocument` query per document sequentially. `loadBlockTodoStatuses` additionally fetches each linked TODO separately. This is an N+1/sequential-round-trip bottleneck candidate, not a measured attribution of all observed latency.
- Native still fetches all document bodies and persists workspace snapshots. The metadata-index/on-demand-body architecture and per-document persistence performance work are not implemented yet. Local serialization/storage cost must be measured too.
- The full refresh runs on **every app restart**, login/refresh-login, **Sync now**, the browser/webview `online` event, and actions that explicitly request refresh (e.g. moving document TODOs to the repository or pulling on-deck TODOs into today). Ordinary edits/autosaves do **not** trigger the full document reload; a successful save may refresh TODO data separately.
- Requests currently have no explicit session-loading timeout. Retry/login controls can remain disabled while loading. A timeout/cancellation change was considered, but the owner clarified that loading eventually finishes; **no timeout, stage-label, or backend batching changes were made**.
- The 3.5-second status-display debounce is unrelated to the slow fetch. Network autosave still waits 10 seconds after editing stops, and also requires completed workspace loading.

**Loading instrumentation and status correction implemented afterward:**

- Native now transitions through local restore, authentication, document loading, draft reconciliation, and local-cache persistence. After authentication the session is `loading`, rather than continuing to claim it is `validating`. Settings, the session banner, empty-workspace state, and dirty-page status use readable stage labels. Generic failures say `Sync unavailable`; loading no longer implies offline. Save/retry controls remain gated for the entire load.
- Settings shows per-stage elapsed milliseconds plus total for the latest load. Document-loading time includes the HTTP request, transfer, and JSON decoding; reconciliation is separate. Cache persistence includes waiting for queued local writes. These are diagnostic operation timings, not render/paint measurements. Failed loads retain timings for the attempted stages; cancelled/previous-account loads cannot publish late timings.
- Successful backend `ListDocuments` calls log `list_documents` with workspace/document/block/linked-TODO counts and query/stage timings. The initial instrumentation counted `3 + documents + linked TODO blocks`; the batched implementation now reports `queries=4`, `blocks_todos_read`, and `assemble`. Handler total excludes Connect serialization and transfer. No content or credentials are logged.
- Regression test gates auth, document fetch, and cache persistence independently, edits a cached draft during loading, checks readable labels/timings, and confirms no saves are sent before a retained validated baseline is ready. Failure-path assertions cover partial timing and unavailable status.
- No schema change or migration was needed for instrumentation or the subsequent batching change.

**Owner baseline and batching implementation (2026-09-23):**

- Owner supplied the post-restart log at 18:11:34 for workspace 4: **180 documents, 1,832 blocks, 758 linked TODOs, 941 queries**. Backend access 172.020 ms; directories 256.699 ms; document metadata 261.298 ms; blocks 17,645.162 ms; TODOs 73,488.904 ms; total **91,829.427 ms**.
- Native measured restore 62 ms, authentication 1,062 ms, document request 91,867 ms, reconciliation 20 ms, cache persistence 294 ms, total **93,305 ms**. Sequential block/TODO reads account for over 99% of handler time; transfer/decoding added approximately 38 ms to this request. This is one measured startup, not a small/large-workspace benchmark suite.
- Implemented `ListBlocksWithTodoStatusByWorkspace` in `backend/sql/queries/documents.sql`, regenerated sqlc output, and changed `ListDocuments` to group the bulk result by document ID. The query joins authorized-workspace documents to blocks, left-joins TODO statuses, and sorts by document ID / sort order / block ID. Existing document ordering, empty documents, block identities/parents, and response conversion are preserved. Single-document loading remains an independent reference path.
- Read-only validation against workspace 4 returned the same 1,832 block rows and 758 TODO links with **zero differing rows** versus the prior lookup semantics. `EXPLAIN (ANALYZE, BUFFERS)` measured **2.835 ms database execution** for the bulk query (1.535 ms planning). This excludes network transfer and the other endpoint reads; it is **not** a measured post-change handler/startup time. The workspace currently has no empty documents, so an added integration regression compares bulk and single-document results using fixtures that include three empty documents, a parent/child outline, and linked/unlinked TODOs.
- `env -u DATABASE_URL -u INSPECT_DATABASE_URL go test ./internal/server/...`, `sqlc diff`, Go formatting, and `git diff --check` passed. Database-writing integration tests, including the extended fixture regression, were **not run** against the application DB; run them on dedicated test infrastructure.
- **Owner-confirmed post-batching result (2026-09-24 09:44:48):** same 180 documents / 1,832 blocks / 758 TODO links; **4 queries**, access 116.730 ms, directories 200.449 ms, document metadata 213.117 ms, combined block/TODO read 395.578 ms, assembly 2.897 ms, total **928.772 ms**. This is approximately **99× faster** than the 91,829.427 ms baseline. Backend performance is verified for this workspace; post-change native timings and broader fixture comparisons remain outstanding.

**Next measurement workflow:**

1. Rebuild/restart the Go server and reload the updated native app. For the same workspace, capture Settings → Load timings after a cold app start and after Sync now (warm local repository).
2. Match each load with the server's `list_documents workspace_id=…` log. Confirm `queries=4` and compare `blocks_todos_read`, handler total, and native document-load time with the baseline above. Verify the same document/block/TODO counts if content has not changed.
3. Repeat with representative small/large workspaces and address any remaining measured cost. Keep the real-webview restart/durability smoke test pending until run on the owner's machine.

**Broader continuation:**

1. Preserve the accurate loading stages and safe-save gates: the relevant draft needs a validated baseline and resolved conflict/uncertain-save state before saving.
2. Longer term, validate the session and load a lightweight index, then fetch changed/open bodies as needed instead of making each launch wait for every block in the workspace.
3. If request timeouts/cancellation are added, retain drafts and distinguish cancellation/uncertain write results; verify retry recovery rather than treating an aborted request as proof a save did not commit.

### Undo report and focused correction before compaction

- Owner reported that undo seemed to record movement commands rather than edits.
- Root causes in `native/src/features/outline/state.ts`: `withHistory` only checked object identity, while `commitEdit` can return a new state for an unchanged commit or just leaving insert mode. Those UI-only changes consumed undo entries. Pre-commit snapshots also retained the newer `draftText`, so restoring the snapshot reopened the very text being undone instead of visibly showing the older page content.
- Changed history admission to compare editable page/node content, ignoring cursor/mode and server bookkeeping. Real outline-row moves remain undoable; cursor moves and unchanged commits do not.
- Undo skips same-content entries already present in a live session, restores the prior pages in normal mode, and clears the obsolete editing buffer/selection. Added `native/tests/outlineUndo.test.ts` with five regression cases covering edits followed by movements/unchanged commits, visible text restoration, navigation without edits, real row reordering, and legacy no-op history.
- This is a focused correction, **not** the full Phase 5 undo architecture. History still contains whole-workspace snapshots; per-document boundaries, transport-ID handling, bounds and refresh/history behavior still need the planned work. Owner confirmation of this latest correction is pending.

### Phase 2 foundation prepared (2026-09-24)

- Prepared **unapplied** Atlas migration `20260924100000_add_persistence_foundation.sql` and matching `sql/schema.sql`. It backfills existing document/block keys as `document-<id>` / `block-<id>`, adds scoped uniqueness and nonempty checks, and initializes positive bigint document revisions at 1. UUID defaults support inserts that have not adopted explicit client identities yet; those defaults do not mean the legacy API now honors submitted keys.
- Added `mutation_receipt`: actor/scope/mutation primary key, protocol/operation/hash, target IDs, optional document creation identity, typed/versioned response bytes, and commit timestamp. A partial unique index reserves document creation keys across actors in a workspace. No resource-delete cascade or expiry; user deletion is restricted until an explicit retention policy exists. Historical deleted creation keys cannot be reconstructed by this migration; reservation starts with protocol receipts.
- Added sqlc primitives for scoped receipt reads/inserts, creation-key reservation checks, transaction-scoped receipt/workspace locks, explicit-key creates, locked document reads, and conditional revision increments. These are not yet wired into a transaction-owning application service.
- Added `Document.revision`, optional save/delete expected revisions, protocol/mutation fields, save outcome, mutation effects, and typed persistence errors without changing existing field numbers. Regenerated Go and TypeScript outputs. TS generation also caught up the existing document-history RPC definitions.
- Versioned SaveDocument/DeleteDocument requests now return `failed_precondition` with `PROTOCOL_UPGRADE_REQUIRED`, including partially populated envelopes. Legacy handlers must never silently ignore version/revision/mutation fields. Reads still emit legacy revision 0 and legacy synthetic identities; no capability advertises v1 and no native envelope/retry behavior changed.
- Verified backend tests (database integration skipped), native/web builds, sqlc generated consistency, and Atlas migration-directory validation/checksum. New tests verify typed rejection before DB access, legacy validation, optional revision presence including zero, and int64 JSON precision above JavaScript's safe integer range. Atlas directory validation is not execution of the DDL/backfill against Postgres; that remains a dedicated-database check.
- **Deployment dependency:** generated reads now select the added columns. Do not deploy this new backend build against the unmigrated database. Migration application requires separate explicit approval. No migration or application-DB write was performed in this slice.
- **Next implementation:** canonical fingerprint/receipt replay and transaction-owning document service, consistent read snapshots, then all AI/TODO/directory writer participation before enabling protocol v1. Wire persisted keys/revisions only with that service and coordinated client baseline adoption; do not claim concurrent-save protection from these schema fields alone.

### Save-time row displacement regression (2026-09-24)

- Owner clarified that “Polish camera flow” moves down/duplicates **when saving**, rather than while typing. Read-only inspection found three persisted copies in document 226 (blocks 6134, 6133, 6132); no content cleanup or DB write was performed. Their intended original contents must not be guessed.
- Reproduced two interacting native bugs with failing tests: `normalizePageForSave` grouped all descendants before the next root, moving a newly inserted/outdented root past later children even when every parent already preceded its children. Then `tree.ts:buildNodeIdMap` mapped new blocks by array position, attaching the active “Polish” draft to a different returned block. `saveReconciliation.ts` also used positional allocation matching for concurrent edits.
- Fixed normalization to preserve any valid parent-before-child visible order; repair remains for invalid ordering/cycles. Kept the server's echoed `client_key` as optional block metadata in the native adapter. Focus/edit identity mapping and in-flight reconciliation now match backend IDs or explicit client/local identities, never row position. Missing save mappings fail and retain the draft instead of inventing identities.
- Six new regression cases cover visible ordering, reordered responses with an active draft, identity allocation during concurrent edits, missing mapping rejection, malformed-order repair, and a session-hook test that saves the active new row, continues typing, and saves again without moving it or overwriting another row. The original three repro tests failed before the fix and pass afterward.
- **42 native tests pass; native build and diff checks pass.** Real-webview owner confirmation is pending. This is a native save-acknowledgment correction; v1 server service/controller work remains outstanding.
- Owner separately reported the foundation migration applied successfully using `PGSSLMODE=disable atlas migrate apply --env neon`. The earlier “unapplied” foundation notes describe preparation time; deployment status is now owner-reported applied. The connection command was verified with read-only Atlas status before the owner applied it; no agent-run migration occurred.

### Transactional document service implemented (2026-09-25)

- Added internal `Server.saveDocumentMutation` / `deleteDocumentMutation` application-service entry points in `backend/internal/server/document_persistence.go`. They own authorization, receipt/workspace/document/TODO locks, dependency rediscovery, expected-revision checks, domain writes, revision effects, response materialization, receipt insertion and commit. Contention/deadlock/serialization retries retain operation identity; ambiguous commit errors are not treated as proven rollbacks.
- Added fixed v1 canonical JSON/SHA-256 fingerprints and typed identity/tree/revision/replay errors in `persistence_input.go`. IDs are range-checked before int32 casts; keys are immutable; duplicate IDs/keys, foreign blocks, missing/mismatched parents and invalid orders are rejected. **Ordering clarification:** v1 requires globally increasing positive `sort_order` in submitted visible order, matching native saves and SQL reads; sibling-only numbering could otherwise displace rows. Valid noncontiguous descendant layouts remain allowed.
- Creates persist document/block client keys and return revision 1. Updates increment the primary document once. Exact receipt replay precedes resource/revision checks and returns the original typed response, including after deletion. Successful create receipts reserve creation keys after deletion. A competing journal create records `EXISTING_JOURNAL` with the untouched existing body, rather than replacing it.
- Dependency discovery includes referenced/sourced/current/completion TODO relationships and their documents/workspaces. Locks are ordered; a changed dependency set causes rollback/rediscovery. The initial service conservatively advances the locked related-document set once per mutation, excluding deleted documents, and reports effects. This may invalidate more related snapshots than strictly necessary but covers cross-document FK effects.
- Extracted block/TODO/link/history persistence so the outer service can commit it atomically with revisions/receipts. Versioned inline changes preserve standalone TODO name when text is unchanged, plus description, assignee, bucket/rank/deadline/goal, current location and unchanged completion context. Creating an already-done block TODO now initializes completion context in the shared create query.
- List/Get document handlers use read-only repeatable-read transactions. Public reads still return legacy revision 0/identities; only internal service responses use persisted keys/revisions. List loading remains four data reads plus transaction control, with commit timing logged separately.
- **Public versioned Save/Delete RPCs remain explicitly rejected.** No capability advertises v1. Legacy, AI, standalone TODO, directory and native controller migration is outstanding; counters/locks in this service alone do not protect against those writers. No new migration or DB write was executed by the agent.
- Checks passed: `env -u DATABASE_URL -u INSPECT_DATABASE_URL -u PERSISTENCE_TEST_DATABASE_URL go test ./internal/server/...`, `go build ./...`, `sqlc diff`, `git diff --check`. New pure tests cover canonical fingerprint/default/order/content/precision behavior, identity/tree validation, typed replay and envelope bounds. Existing public-gate tests remain passing.
- Added **11 dedicated-Postgres integration scenarios**, compiled but not executed: replay/deletion/key reservations, simultaneous retries/stale saves, journal preservation and racing creates, domain/receipt rollback, TODO metadata/completion, delete cascades, consistent snapshots and authorization after access removal. `PERSISTENCE_TEST_DATABASE_URL` is explicit and never falls back to the application DB. `REQUIRE_PERSISTENCE_DB_TESTS=1` makes missing configuration fail; that failure behavior was verified locally.
- **Subsequent owner decision:** do not add a test database as a development dependency or block implementation on provisioning one. Real-Postgres concurrency/rollback verification remains outstanding. The existing opt-in suite can be run later against explicitly approved disposable infrastructure; no application database testing or migration application is authorized by this decision.
- **REBUILD/RESTART THE GOLANG SERVER OR THE BACKEND CHANGES WILL NOT BE LIVE.** The new protocol remains gated after restart; the active changes include coherent reads and initialization of completion context for newly created done TODOs.

### Backend writer participation implemented (2026-09-26)

- Added `persistence_writers.go`: shared dependency discovery and authorization, sorted workspace → document → TODO locks, and dependency checks after workspace and TODO locking. A changed set returns `unavailable` and the caller rolls back rather than acquiring new locks out of order. Command writers operate on current state under these locks; they do not pretend to have a client snapshot baseline.
- Legacy full saves, note deletion, standalone TODO update/admin deletion, repository moves, on-deck pulls, and AI block insert/move now advance the affected existing-document revisions in their domain transaction. Source/current/completion and block-reference dependencies cover indirect FK changes. New documents start at revision 1; deleted documents are excluded from advancement. Related-document bumps are conservative, including accepted no-op repository moves.
- Directory create/update/delete and AI directory creation now serialize validation and writes with document placement through the same workspace lock. Directory rename/reparent changes the directory index, not document snapshot fields, so it does not independently bump body revisions. Delete retains the empty-directory restriction under lock.
- AI note creation calls the internal save service directly instead of constructing a Connect handler request. Its operation UUID is stable across the service's transaction retries; durable run/tool-call replay identity is still future command-envelope work. AI block insertion/movement reloads under lock and rechecks the locked System-document restriction.
- Corrected AI block ordering: positive global positions, retain parent-before-child visible order, move the selected subtree without rewriting unrelated row order, and stage temporary positions before assigning final ones to avoid immediate sibling uniqueness collisions. Fresh blocks are included explicitly in ordering. On-deck pulls append after the maximum global position and roll back if conditional TODO attachment fails, rather than leaving an orphan block.
- Legacy and versioned saves now share metadata-preserving inline TODO reconciliation. Standalone TODO updates/deletions record the authenticated actor; linked workspace access is checked during mutation locking. Unlinked TODO creation does not change a document. TODO-goal CRUD and recording lifecycle do not change document snapshot fields.
- Re-audited the deferred Python exception: `tui/db/service.py` creates unlinked recording TODOs and reads them; no existing-TODO update/delete or document/block mutation path was found. Recording→TODO FKs remain `NO ACTION`. The owner's separately requested vertical TODO-owner grouping was confirmed working.
- Checks passed: DB-disabled `go test ./internal/server/...`, `go build ./...`, `sqlc diff`, and `git diff --check`. New database-free tests cover lock ordering, locked revision use, deleted-document exclusion, dependency changes at both lock stages, authorization rejection, AI subtree/visible-order placement, and positive AI creation ordering. These test application control flow, not real PostgreSQL concurrency/rollback.
- **Activation boundary:** public v1 Save/Delete remain rejected; reads still return legacy identities/revision 0. Legacy requests still lack stale-snapshot rejection and exact retry receipts. This slice establishes writer participation, not live client conflict protection. No migrations, application-DB writes, or new development dependencies were introduced.
- **Next implementation:** native durable request envelopes, server-baseline/key adoption and conflict handling, plus remaining command receipt/envelope work and coordinated capability activation. Broader transport-independent TODO/directory service extraction remains Phase 3 work; current handlers own their transactions and call shared locking/revision primitives.
- **REBUILD/RESTART THE GOLANG SERVER OR THE BACKEND CHANGES WILL NOT BE LIVE.**

### Verification and working tree

- Last native checks: **42 passing tests** with `bun test`; `bun run build` and `git diff --check` passed. Earlier backend foundation tests/build and native/web builds passed; database integration cases were skipped intentionally. Status tests allow for the 3.5-second presentation delay.
- Tests include hook lifecycle/IndexedDB simulations plus rendered journal markup. They do not replace actual packaged-webview interaction or startup performance measurements. The first test pass missed user-visible journal/conflict defects; verify the real screen and user workflow, not merely internal flags.
- Relevant implementation files: `native/src/features/session/{useSessionSync.ts,draftReconciliation.ts,DraftConflicts.tsx,useSaveStatus.ts}`, `native/src/lib/{draftStorage.ts,backend.ts}`, `native/src/features/outline/{state.ts,tree.ts}`, journal/note/settings views, and `native/src/styles.css`.
- Relevant tests: `native/tests/{sessionRecovery.test.tsx,draftStorage.test.ts,journalConflictView.test.tsx,saveReconciliation.test.ts,outlineUndo.test.ts}`. Contract details remain in `docs/persistence-contract.md`.
- Changes remain in the working tree; preserve existing work and inspect status before further edits. No commit/push was requested. The owner reports the foundation migration applied. The latest backend service/read changes require a Go server rebuild/restart. Public protocol activation and runtime database verification remain pending as described above.
