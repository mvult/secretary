# Architecture and Persistence Reliability PRD

## 1. Summary

- **Context:** Secretary has a React/Tauri desktop client, a React web client, a Go/ConnectRPC backend, PostgreSQL, and a Python recording TUI. A React Native client is planned in `docs/PRD.md`.
- **Scope:** Implement the first five priorities from the architecture review: explicit session states and durable drafts; reliable document saves; shared document/TODO application services; a shared generated TypeScript API client; and document-scoped state and undo.
- **Goal:** An edit is either acknowledged by the server, durably retained locally, or visibly conflicted. Authentication and network failures must not masquerade as an empty workspace or successful persistence.
- **Delivery:** Incremental changes to the existing applications and APIs. Keep the single backend deployment and existing editing workflows.
- **Status:** Phase 1 implementation is complete, with packaged-app verification outstanding. Phase 2 includes internal transactional save/delete services, backend writer locks/revisions, native durable saves/deletes, manual conflicts and strict command barriers. Versioned public writes remain gated. Phase 3 is partially implemented; Phase 4 and the main Phase 5 state/cache redesign remain ahead. Phase 6 integrated release verification is outstanding. See the live checklist below and Section 9 for evidence; historical handoffs describe their date's state, not today's next action.

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
- [x] Record automated regression cases for auth failure, in-flight edits, duplicate retries, AI ordering/writer control flow and TODO metadata; database-free and hook tests are implemented.
- [ ] Exercise cross-writer behavior in the integrated app.

### Phase 1: Session states and durable drafts

- [x] Add explicit session/workspace loading states and centralized auth-error handling.
- [x] Add scoped/versioned draft storage and startup recovery, including local-storage failure reporting.
- [x] Persist pending draft state independently of network save timing.
- [x] Preserve cached content through reauthentication and validate scope before resuming saves. Legacy uncertain saves pause for comparison rather than replaying without receipts.
- [x] Remove the failed-load-to-empty-workspace behavior and blanket refresh overwrite path, including journal creation inside editor hydration.
- [x] Verify expired-token startup, cached offline edits, account switching, and restart recovery with hook/IndexedDB tests; see the latest verification checkpoint for current suite results.
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
- PostgreSQL testing is excluded by explicit owner decision (2026-09-26), including migration/backfill test infrastructure. It is not an implementation or release requirement.
- [x] Regenerate sqlc/Protobuf outputs and implement transactional save/delete services with atomic revision checks and receipt replay; public v1 routing is activated in source.
- [x] Make document list/get reads snapshot-consistent using read-only repeatable-read transactions.
- [x] Make audited backend writers participate in shared lock/revision rules, including AI and document-linked TODO operations; database-free coverage passes.
- [x] Implement the headless per-document save controller and durable pending request envelopes, behind explicit v1 capability.
- [x] Implement manual conflict comparison/reload/copy, save against the reviewed revision, and safe journal create-on-open handling.
- [x] Implement durable online note deletion and native strict save/cache barriers for deletion, TODO changes, repository moves and on-deck pulls.
- [x] Implement repository-move/on-deck-pull command receipts, canonical inputs and affected-document results; public v1 routing is activated in source.
- [x] Verify lost responses, edits during saves/deletes, exact replay, fresh-ID recovery copies and barriers with native controller/hook/IndexedDB tests (81 passing at the latest native checkpoint).
- [x] Implement native durable repository/pull requests, including authenticated initial server-local journal-date resolution and exact-request recovery through live-cache refresh.
- [x] Implement internal TODO update receipts/atomic field patches and native retained update requests, including user-scoped unlinked TODO recovery.
- [x] Implement durable AI run/provider-call identity, retained exact arguments, atomic mutation receipts, and transactional AI directory creation.
- [x] Complete standalone directory/client coordination: shared transaction owner, locked field-presence patches, strict native save/refresh barriers, and session-scoped results.
- [x] Audit remaining activation work: public versioned read/write routing, web TODO legacy updates, and command coverage/legacy-write policy; see the 2026-09-28 handoff.
- [ ] Verify packaged-webview restart recovery.
- [x] Activate coherent v1 public reads/writes and typed legacy-write rejection together in source; migrate web TODO create/update/delete to retained receipted commands.
- [ ] Deploy/rebuild the coordinated backend/native/web versions and verify integrated behavior with retained drafts.

### Phase 3: Shared document/TODO services

- [x] Establish internal transaction-owning document save/delete services and shared writer lock/revision primitives.
- [x] Route AI document creation through internal transaction-owning services and shared document persistence instead of a synthetic Connect request.
- [x] Extract transaction-owning repository/pull command entry points used by thin RPC adapters and shared domain mutation helpers.
- [x] Complete transport-independent document-linked TODO/directory/AI mutation entry points and route handlers/adapters through them. Shared inline lifecycle/history rules live in `todo_lifecycle.go`; transaction ownership remains in command services.
- [x] Audit the deferred TUI exception and implement shared metadata-preserving inline TODO reconciliation and history actor fixes.
- [x] Verify TODO lifecycle/link/history preservation across extracted services with database-free regression coverage, including metadata/actor preservation and stopping on history failure.
- [ ] Exercise integrated editor/API/AI/TODO application flows, including multi-document mutations.

### Phase 4: Shared generated client package

- [x] Establish `packages/api` and aligned, reproducible TS generation/runtime dependencies with one root Bun lockfile.
- [x] Migrate native and web to shared generated RPC transport, typed errors, and deliberate identity/revision adapters. Native domain adapters remain explicit and migrate incrementally.
- [ ] Add query-cache integration without moving draft ownership into server cache.
- [x] Update container/build code-generation paths for the workspace package.
- [x] Verify native and web builds, mocked-HTTP API compatibility, and generated-output drift checks; CI checks generation and both builds.
- [x] Document how the future mobile client consumes the package.

### Phase 5: Document-scoped state and undo

- [x] Fix the immediate undo regression: unchanged commits/cursor-only changes do not add history; undo restores prior content without reopening the newer draft buffer and skips legacy no-op snapshots. This does not complete document-scoped history or transport-identity separation below.
- [x] Instrument native load stages and backend document query count/time; expose latest native timings in Settings.
- [x] Capture the owner's full-workspace startup baseline: 941 queries / 91.83 seconds backend time; block/TODO reads dominate. See Section 9.
- [x] Batch workspace blocks and linked TODO statuses into one read, reducing successful `ListDocuments` calls to four queries; verify SQL results against the existing workspace using read-only queries.
- [x] Record owner-confirmed post-batching backend timing: four reads / 928.772 ms versus 941 queries / 91.83 seconds for the same workspace (approximately 99× faster).
- [ ] Collect post-batching native startup/Sync now timings and representative small/large workspace comparisons.
- [x] Add metadata-only document index with immutable-ID keyset pagination and authenticated workspace title/body substring search with bounded snippets.
- [ ] Add indexed PostgreSQL full-text search and verify query performance on representative workspaces; current search preserves literal native matching without a schema migration.
- [x] Migrate native startup/navigation to index-plus-on-demand bodies; reuse complete equal-revision cached baselines on refresh.
- [ ] Add bounded cache eviction and native query-cache integration, keeping dirty/pending/conflicted drafts protected and metadata separate from editable bodies.
- [ ] Move draft dirty tracking and undo to document-local state with stable identity mapping.
- [ ] Remove whole-workspace cloning/hashing from ordinary edit/persistence/undo paths.
- [ ] Verify search completeness, journal navigation, links, selection, and TODO behavior.
- [ ] Compare before/after profiles using identical fixtures; document results and remaining bottlenecks.

### Phase 6: Integrated release verification

- [ ] Run the acceptance scenarios below against the integrated client/backend build.
- [ ] Run database-free regression suites and generated-output/build checks for the coordinated release.
- [ ] Verify deployment compatibility and restart recovery with retained local drafts.
- [ ] Document operational commands, architecture ownership, limitations, and rollback behavior.

**Dependencies:** These phases express investment priorities, not rigid implementation silos. Minimal application-service extraction and client generation needed to implement the revision contract may land in Phase 2. Revision enforcement must not ship while an in-scope backend writer bypasses it. Phase 4 becomes the only shared API implementation before mobile work copies another client. Phase 5 builds on the stable draft/save contract.

### Shared services/API handoff (2026-09-28)

- Extracted the inline TODO lifecycle from document handlers into `todo_lifecycle.go`, shared by editor/AI persistence. Standalone create/update/delete now use the same history writer as inline/repository/pull operations. Database-free query-boundary tests verify status-only edits preserve separately renamed TODOs and metadata, actor versus owner history, creation/link order, history failure propagation, no-op behavior and missing-canonical-TODO rejection. Existing dependency-lock/revision tests cover multi-document coordination; deployed integrated flows remain unchecked.
- Added Bun workspace `@secretary/api`. Pinned Protobuf/ES generator 1.10.1 and Connect runtimes/generator 1.7.0, consolidated root lockfile, generated all seven services (including previously missing activities and stale AI methods), and removed duplicate TS outputs/templates. Native ordinary RPCs use generated descriptor serialization; its explicit numeric/domain adapter rejects unsafe integer conversion. Revisions stay decimal. Retained requests bypass reserialization and keep exact original bytes.
- Web generated clients and retained-command HTTP transport now use shared auth/error handling. `BackendError` preserves wire codes/details and decodes persistence details; session transitions stay application-owned. The package has no React/Tauri/storage dependencies or global session state. Existing web Query caches remain separate from retention. Native TanStack Query adoption is deliberately paired with the next index/body-loading slice.
- Generation: `bun install --frozen-lockfile`, `bun run api:generate`, `bun run api:check`, `bun run api:test` from root. CI regenerates into a temporary directory and checks drift, tests the transport, and builds both apps. Docker consumes the root lockfile/package and the same pinned TS generators. Future mobile consumption is documented in `packages/api/README.md`.
- Checks: 103 native tests, 8 web recovery tests, 4 API transport/identity tests, database-free Go server/agent tests, full Go build and both production builds passed. Static Compose validation passed with the installed `docker-compose` executable; the local `.env` lacks `JWT_SECRET`, so target deployment environment/runtime validation is still outstanding. No containers or migrations were run.
- **REBUILD/RESTART THE GOLANG SERVER OR THESE CHANGES WILL NOT BE LIVE.** Rebuild web/native using the root workspace installation.

### Index/on-demand loading handoff (2026-09-28)

- Added `ListDocumentIndex`: distinct metadata message (no blocks), descending immutable-ID keyset, default 100 / maximum 200 entries per request, directory metadata on the first non-search page, and protocol-one capability. Each read authenticates workspace membership inside a repeatable-read transaction. Pages are separate snapshots; later inserts appear on the next traversal. Missing index rows are never sufficient evidence to discard a cached document.
- Native normal startup no longer calls `ListDocuments`. It traverses metadata pages, fetches up to three recent journals plus today's journal (or one note in a note-only workspace), and reconciles existing loaded/recovery documents. Complete cached baselines with matching key/ID/revision are reused; changed, legacy, pending, conflicted and explicitly invalidated bodies are fetched, with at most four concurrent reads. A body/index failure does not publish a partial successful refresh.
- Metadata-only navigation projections remain outside editor state/IndexedDB drafts and are rejected by draft tracking and serialization. Opening an uncached note/journal loads and validates its body before editing, deduplicates concurrent opens, and guards account/workspace epochs. Directory listing and link pickers include all index pages. Rename/move/copy load the source body before editing it. Cold startup therefore avoids workspace-wide block downloads; existing cached bodies remain retained, not evicted in this slice.
- Search uses the paginated index endpoint with literal case-insensitive title/body filtering and a 240-character plain-text snippet. Native debounces server searches, ignores stale account/query results, overlays cached/local bodies and explicitly labels offline body-search coverage. Search results beyond the first page do not require body downloads. This preserves ordinary substring matching; indexed linguistic full-text search and cross-block phrase matching remain follow-ups.
- Verification: 112 native tests (including nine new index/loading/search regressions), 8 web recovery tests, 4 shared API tests, database-free Go server/agent tests, full Go build, native/web production builds, generated-output drift check and `git diff --check` passed. Existing protocol-0/1 recovery fixtures retain an injected snapshot loader; new hook tests exercise the production indexed loader. No schema change, migration, or PostgreSQL test was run. Packaged-client behavior and real-workspace timing remain owner/integrated checks.
- **REBUILD/RESTART THE GOLANG SERVER OR THESE CHANGES WILL NOT BE LIVE.** Rebuild native alongside it; the new native build requires `ListDocumentIndex`. Retained v1 drafts/requests are preserved if that endpoint is unavailable.

**Next action:** Add bounded native caching/query-cache integration and document-local dirty tracking/undo, then remove whole-workspace cloning/hashing. Profile cold/warm startup and Sync on the owner's workspace. Deployed editor/API/AI/TODO flows and packaged-native restart recovery remain unverified. PostgreSQL tests are excluded.

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
- Backend database-free tests: revision/writer control flow, duplicate request fingerprints/replay, journal rules, TODO reconciliation, and AI/service identity propagation. PostgreSQL tests are out of scope by owner decision; existing unexecuted opt-in fixtures are not release gates.
- Client integration/smoke tests: reauthentication, conflict handling, offline cached editing, lazy-loading/search, and keyboard behavior.
- Required checks: focused Go tests, TypeScript checks, native/web production builds, Protobuf/sqlc generation consistency, and static Compose validation if deployment inputs change.
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
- Verified backend tests (database integration skipped), native/web builds, sqlc generated consistency, and Atlas migration-directory validation/checksum. New tests verify typed rejection before DB access, legacy validation, optional revision presence including zero, and int64 JSON precision above JavaScript's safe integer range. Atlas directory validation did not execute DDL/backfill against Postgres.
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
- **Superseding owner decision (2026-09-26):** no PostgreSQL tests will be performed. They are not development prerequisites, release requirements, or future follow-ups. Existing opt-in fixtures remain unexecuted historical work; no database testing or migration application is authorized by this decision.
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

### Native durable save controller implemented (2026-09-26)

- Added headless `native/src/features/session/documentSaveController.ts`, owned by the authenticated workspace session. One in-flight operation per draft, with at most two documents sending concurrently. Navigation/editor component lifetime does not own the queue; scope changes prevent old responses from changing the active session.
- Each v1 save commits an exact serialized request, UUID, scope, submitted snapshot and edit generation before sending. Retries replay those bytes and identities rather than rebuilding from newer editor state. Acknowledgment advances only the submitted generation; newer edits remain dirty and use the acknowledged revision on their next request. Authentication pauses, transient failures use bounded backoff/three automatic attempts, and Sync now/reconnect/restart can explicitly resume retained requests. A 30-second request timeout is treated as uncertain, never as proof of rollback.
- Revisions are decimal strings end to end. Existing persisted document/block keys come from the acknowledged server baseline, not editor/undo metadata or response position. Legacy dirty drafts can adopt coherent v1 baseline keys/revisions only when the old baseline content still matches; uncertain legacy saves remain comparison conflicts. Unknown/deleted block identities are retained for recovery rather than recreated silently. Directory copies clear inherited server keys/revisions and create independent identities.
- Added `ListDocumentsResponse.persistence_protocol_version` (tag 3), regenerated Go/TS definitions, and wired native capability selection. **The backend still leaves this at zero and rejects v1 public Save/Delete requests.** Native selects v1 only on explicit advertisement plus coherent positive-revision snapshots, and refuses to downgrade a retained v1 request/baseline to legacy writes. The current live-compatible path remains the legacy bridge.
- Upgraded local IndexedDB to version 2 non-destructively, preserving all existing stores, v1 drafts, uncertain-save flags and recovery candidates. New fields include exact envelopes, generations/acknowledged generations and retry/refresh state. Old binaries requesting database version 1 cannot write through the new format. No local/application storage was cleared.
- Interrupted saves replay after authenticated workspace validation and before newer edits for that draft. Workspace refresh and old whole-workspace undo cannot drop a retained envelope. Replayed receipts are checked against the live document afterward: deletion or a later server revision preserves a recovery conflict, rather than treating historical acknowledgment as present-day existence. Related-document effects fetch fresh bodies; failed refreshes block later writes without inventing a new baseline revision.
- Conflict review retains local/server content and now offers **Save local using reviewed revision** when a versioned snapshot is available. The reviewed revision is checked again before rebasing, and a further concurrent change requires another review. Reload/discard and independent recovery-copy actions remain. Only untouched generated journals may adopt `EXISTING_JOURNAL`; edited drafts remain conflicts.
- Verification: **67 native tests pass**, including durable-before-send, lost create/update responses, replay after restart/deletion, edits during save, failed local acknowledgment, scope/auth isolation, bounded retries/concurrency, generation tracking, v1 IndexedDB upgrade/reopen, capability downgrade rejection, baseline adoption, and repeated manual conflicts. Native and web builds pass; DB-disabled Go server tests and `go build ./...` pass. No new dependencies, migrations or application-database writes were introduced. Real-webview and real-Postgres runtime checks remain unexecuted.
- **Next slice:** complete versioned online deletion and command envelopes/receipts (TODO/repository/pull and stable AI tool-call identity), coordinate their document-cache invalidation and pending-save barriers, then activate coherent v1 reads, public save/delete services, capability advertisement and legacy-write rejection together. Do not enable the new capability field by itself. Shared generated API packaging and full transport-independent service extraction remain later phases.
- **Remaining state/performance work:** the existing React/editor adapter still clones/hashes workspace snapshots to observe edits and local persistence still writes workspace snapshots. The new controller uses retained edit/acknowledgment generations, but per-document editor state/storage writes, bounded cache and undo transport-identity separation remain Phase 5; this slice does not claim those optimizations are finished.
- Rebuild/reload the native app for its local format/controller changes. **REBUILD/RESTART THE GOLANG SERVER OR THE GENERATED BACKEND API CHANGES WILL NOT BE LIVE.** This does not activate v1.

### Native online deletion and command barriers implemented (2026-09-26)

- Added revision-checked note deletion to the session-owned durable controller. After a strict save barrier, an online delete retains its exact request, mutation ID, scope, acknowledged revision and submitted draft before transport. Retries use the same bytes, including startup replay when the document is already absent. The existing internal backend delete receipt service supplies the protocol; its public RPC remains gated.
- A delete acknowledgment must match the mutation and deleted document ID. Related-document refresh and local removal complete before discarding the retained request. Transport, cache refresh and local acknowledgment failures remain replayable. Edits made after the delete request become a retained recovery conflict, rather than being deleted with the older snapshot. Whole-workspace undo cannot silently drop conflict or uncertain-request records.
- `useSessionSync.runDocumentCommand` now coordinates note deletion, TODO edits/status changes, repository moves and on-deck pulls. It awaits current saves and drains newer edits, rejects unresolved/failed saves, serializes these commands, retains conservative workspace-body invalidation before sending, and pauses autosave through the post-command refresh. Edits arriving during the local durability barrier abort the command; edits during the remote operation survive refresh and conflict when necessary. Session changes prevent late deletion acknowledgments from removing another session's draft.
- TODO commands fetch the current TODO after the save barrier before constructing the legacy full-update payload. This prevents the old UI row from undoing an inline rename/metadata change flushed by the barrier. Full body refresh replaces the prior status-only optimistic document patch. This adds a TODO-list request and currently uses the existing full-workspace refresh; it is not the future bounded body-cache architecture or atomic server-side patch semantics.
- Known-offline server deletion is rejected without queuing intent. Purely local notes can be removed locally unless an unresolved/in-flight save could have allocated a server identity. Against the current capability-zero server, deletion still uses the legacy endpoint; strict command barriers/cache refresh are active, but expected-revision checks and exact delete receipts are not.
- IndexedDB now opens version **3**, retaining existing stores and accepting metadata versions 1–3. Version-1 save envelopes remain supported; local envelope version 2 explicitly identifies deletion. Version-1/2 database openers are excluded so an older binary cannot reinterpret a retained deletion. This is a non-destructive local-format upgrade, not a Postgres migration.
- Verification: **81 native tests pass**, native production build passes. Added tests cover durable delete transport, lost responses/replay, local acknowledgment and related-cache failures, edits during deletion, stale revision and scope guards, offline rejection, actual IndexedDB startup replay/removal and v1/v2 upgrades, failed-save command blocking, edits during save/local retention/remote command, and post-barrier TODO metadata preservation. No backend source changes, new dependencies, Postgres migration or application-database writes in this slice. Packaged-webview checks remain outstanding.
- **Next slice:** server command envelopes/receipts for TODO/repository/pull and stable AI tool-call identity, with native durable command retention and affected-body results. TODO requests still use the legacy full-update RPC and are not safe to automatically replay on an uncertain outcome. Directory/AI command coordination and shared service extraction also remain. Then activate coherent v1 reads, public save/delete services, capability advertisement and legacy-write rejection together. **Capability remains zero; do not enable it in isolation.**
- Rebuild/reload the native app for this slice.

### Backend repository/pull command receipts implemented (2026-09-26)

- Reconciled the Phase 0–6 checklist with implementation evidence: completed writer participation, native envelopes/conflicts/deletion/barriers, partial service extraction and owner-confirmed batching timing are now checked. Runtime checks remain separate unchecked items. Removed the obsolete next-action instruction to provision a database before continuing; the owner's no-new-test-DB prerequisite decision still applies.
- Added `todo_commands.go` application-service entry points for repository moves and on-deck pulls. Legacy RPC adapters use the same transaction owner/domain helpers; versioned internal calls additionally authorize workspace access before receipt lookup, serialize the actor/workspace/mutation receipt, verify target scope on fresh operations, and atomically commit domain changes, history, affected revisions and the serialized result receipt. Receipt replay precedes target-existence checks and returns the historical counts/identities/effects without reapplying the command.
- Added command workspace/protocol/mutation fields and result effects without renumbering existing fields. Pull v1 additionally requires a canonical explicit `journal_date` in the immutable input. Legacy initial resolution retains the server-local calendar convention; internal retries retain that date. Native v1 integration still needs an authenticated way to resolve the initial server-local date before retaining the envelope—do not substitute the device date. Replays never derive a new target day from the current clock.
- Commands act on current locked state rather than accepting a document snapshot expected revision. Their fixed v1 fingerprint uses the shared canonical hash with expected-revision sentinel zero and operation-specific document/date input. Mutation IDs share the save/delete receipt namespace; altered scope, operation or input cannot reuse a receipt. No new receipt schema or migration was needed. Created journals report revision 1 in effects, including a zero-TODO pull.
- Public repository/pull handlers reject full or partial versioned envelopes with typed protocol-upgrade errors before database access. Public Save/Delete and capability advertisement remain gated as before; native/web callers still use the legacy command wire format. This slice does not make live command retries idempotent yet.
- Verification passed: database-disabled `go test ./internal/server/...`, `go build ./...`, `sqlc diff`, frontend production build and diff checks. Database-free tests cover protocol/ID validation, canonical command identity, midnight/date behavior and historical typed result replay. Added three opt-in PostgreSQL scenarios (concurrent move/replay/deletion, pull replay versus later eligible TODOs/deleted journals, receipt-failure rollback), and extended access-revocation coverage; these compiled but were **not executed**. Existing 81 native tests/build remain the preceding native checkpoint; native source was not changed in this slice.
- Regenerated Go and frontend TypeScript TODO definitions. Frontend generation also catches up already-existing TODO-goal and repository/pull service descriptors; it does not introduce new TODO-goal behavior.
- **Next:** native repository/pull envelopes and server-date preparation, TODO update receipts/patch semantics, durable AI tool-call identity and remaining coordination, followed by coordinated protocol activation. Full service/package extraction, document-local state/cache/undo and release verification remain tracked above.
- **REBUILD/RESTART THE GOLANG SERVER OR THE BACKEND CHANGES WILL NOT BE LIVE.** Restart does not enable the versioned protocol.

### Native durable repository/pull requests implemented (2026-09-26)

- Native repository/pull actions now use session-owned command preparation behind the existing strict save barrier. With advertised v1, the session retains one immutable command envelope per backend/account/workspace before transport. Snapshot autosave and other commands remain blocked while that envelope is unresolved. Legacy capability-zero commands continue through the existing barrier.
- IndexedDB version 4 adds the command to workspace metadata, atomically retained alongside drafts/cache invalidation under the existing cross-window CAS. Versions 1–3 upgrade without clearing records; older openers are excluded. This is recovery for commands initiated online, not an offline command queue.
- Added authenticated `TodosService.GetTodoCommandContext`, which validates workspace membership and returns server-local `journal_date`. Pull preparation resolves it once before retaining the envelope; restart/replay keeps the original date and mutation ID. Generated Go/TypeScript contracts include the endpoint.
- Startup/Sync validates membership and capability before replaying exact bytes, then fetches live versioned document bodies. Envelope removal is persisted with the reconciled cache; failed transport/acknowledgment, refresh or storage retains recovery state. The immediate command-refresh path also replays the receipt once; subsequent retries require another Sync/reconnect/restart, avoiding an automatic retry loop. Historical receipts never reconstruct deleted journal bodies. New local edits survive refresh and conflict when the baseline changed.
- Typed `not_found` after receipt lookup definitively rejects a missing target; recovery refreshes live bodies before releasing that command slot and reports rejection. Auth/protocol failures and ambiguous outcomes retain the envelope. Scope/epoch checks exclude late responses from another session.
- Verification: **91 native tests passed**, native and frontend production builds passed, database-disabled Go server tests and Go build passed. Coverage includes exact retained bytes/server dates, lost acknowledgment, restart after refresh failure, in-flight edits, auth/capability guards, storage failure, malformed acknowledgment/scope, missing-target rejection, and v1–v3 IndexedDB upgrades. Expanded opt-in PostgreSQL context-date/membership coverage compiles but remains unexecuted; packaged-webview verification is still outstanding.
- Capability remains zero and public versioned writes remain gated. Next is TODO-update receipts/atomic patch semantics plus native retention, followed by AI identity/remaining coordination and coordinated activation.
- **REBUILD/RESTART THE GOLANG SERVER OR THE BACKEND CHANGES WILL NOT BE LIVE.** Rebuild/reload the native app for this client slice.

### Atomic TODO patches and native update recovery implemented (2026-09-26)

- Added optional-field `TodoPatch` to versioned `UpdateTodoRequest`, with protocol/mutation/scope fields and response receipt/effects. Supported fields are name, description, status, bucket, priority, deadline and goal. Omission preserves current data; explicit empty description/deadline or zero priority/goal clears it. Mixed legacy-full-update/patch input, invalid IDs/status/dates and empty patches are rejected. Existing public versioned/partial-envelope guards remain closed.
- `todo_patch.go` applies the patch to the current locked TODO inside the shared command transaction. Status-only bucket transitions use that locked value. TODO changes, history, affected-document revisions and the typed result receipt commit together. `PatchTodo` preserves completion timestamp/location for metadata-only changes and preserves assignment/recording metadata; it requires no schema migration.
- Linked TODO commands use their declared workspace scope. Owned unlinked TODOs use authenticated user receipt scope (`workspace_id=0`), with ownership/unlinked state rechecked after TODO locking. Scope kind participates in canonical hashing; existing workspace v1 hashes remain unchanged. Current workspace access is checked before workspace receipt replay. Goal changes require a goal belonging to the TODO owner. TODO read models now expose workspace identity for native preparation.
- Native `runTodoUpdate` drains inline saves, re-reads current TODO scope, retains only the requested patch, then uses the existing exact-command replay/live-body-refresh path. Legacy fallback still builds its full request from the post-barrier current TODO. Status UI no longer sends a stale derived bucket. After completion, live TODO reads replace historical receipt data; recovery also requests a TODO-list refresh. Account/backend/token guards prevent old TODO view responses from updating another session.
- IndexedDB v5 preserves v1–v4 data and excludes older writers; local command envelope v2 adds TODO update requests without changing existing v1 repository/pull envelopes. User-scoped wire commands remain retained inside their original local backend/account/workspace cache scope.
- Verification: **95 native tests passed**, native/frontend production builds passed, DB-disabled Go server tests/build and `sqlc diff` passed. New tests cover presence-sensitive hashing, field preservation/clears, status/bucket transitions, public gates, post-save legacy/v1 metadata, exact update replay/live results, user-scoped restart recovery and v4 storage upgrade. Added opt-in PostgreSQL scenarios for concurrent duplicate patches/history/revisions, completion preservation, scope rejection and replay after unlinked TODO deletion; compiled but **not executed**.
- Capability remains zero. Next is stable AI tool-call identity and remaining directory/AI coordination, followed by coordinated activation and release verification.
- **REBUILD/RESTART THE GOLANG SERVER OR THE BACKEND CHANGES WILL NOT BE LIVE.** Rebuild/reload native for this client slice.

### Durable AI tool calls implemented (2026-09-26)

- The runner passes the persisted run ID, provider call ID, actor/workspace and exact argument string into one internal mutation service. Deterministic phase-separated UUIDs identify intent and application receipts. Reusing a call ID with different tool/argument bytes is rejected; distinct runs/calls remain independent.
- Before domain writes, the existing immutable receipt store retains the complete call envelope. This needs no schema migration. Run-origin actor and workspace authorization are checked before either receipt can replay; the shared receipt transaction also checks current workspace access.
- AI create/insert/move now use the shared bounded-retry receipt transaction. Block writes, linked-document revisions, history and result receipts commit together. Replay returns the historical result before target lookup, so deleted resources are not reconstructed. AI-created document identities are reserved through the existing document-save creation-key constraint.
- AI directory creation and note persistence now occur in the same transaction under the shared workspace lock. Insert/move retain sorted dependency locking and locked System-document validation. A failed mutation stops the model turn, preventing a fresh provider call from being generated automatically for an uncertain write.
- Retained calls survive independently of mutable run debug JSON. This adds durable mutation identity, not automatic resumption of model jobs; durable job execution remains outside this PRD.
- Database-free tests cover exact-byte identity/replay, changed-intent rejection, scope/identity validation, malformed/range-invalid arguments and runner fail-stop behavior. PostgreSQL testing has been removed from all remaining requirements per owner direction.
- Verification passed: database-free `go test ./internal/server/...`, `go build ./...`, and `git diff --check`. No schema, generated API or native changes in this slice.
- **Next:** standalone directory/client coordination and supported-writer activation audit. Capability remains zero until the coordinated rollout.
- **REBUILD/RESTART THE GOLANG SERVER OR THESE CHANGES WILL NOT BE LIVE.**

### Directory coordination and activation audit (2026-09-28)

- Directory RPCs are thin adapters over `directory_service.go`, with one transaction owner. IDs are range-checked before narrowing. Create/update/delete serialize against document placement under the existing workspace lock; update/delete re-read their target after locking, then validate parent cycles or directory emptiness.
- Additive `DirectoryPatch` distinguishes rename intent from move intent. Omitted fields preserve locked current values; explicit parent ID zero moves to root. Empty/mixed patches are rejected. Legacy full-field requests retain their original semantics.
- Native directory requests now use the strict session command barrier, draining local edits and blocking unresolved saves before transport, retaining invalidation and refreshing the live cache afterward. Historical responses never overwrite refreshed directory metadata. Note rename/move/copy also use strict completion rather than best-effort flush.
- Directory edits dispatch through the session's synchronous state bridge so a just-created/renamed/moved note is visible to the barrier before React's next render. Regression coverage catches recursive copy continuing past an unsaved note.
- Backend/token/workspace changes clear directory navigation, prompts and clipboard. In-flight responses/errors cannot publish into the new scope, recursive copies stop when scope or saves fail, and a synchronous action ticket prevents duplicate submissions. A partial directory copy retains its already-created directories and local notes; it is not an atomic recursive operation or an automatically replayed command.
- Directory operations remain online-only with no automatic retry after uncertain creation. Directory metadata does not change document body/placement identities, so renaming/moving a directory alone does not advance document revisions. Body/placement changes continue through document saves.
- **Activation audit:** native save/delete/update/repository/pull controllers and AI receipt services exist. Public handlers still reject versioned requests and public reads still advertise zero/revision zero. `frontend/src/components/EditTodoDrawer.tsx` still sends legacy TODO updates; standalone TODO create/delete command coverage and explicit legacy rejection boundaries must be finalized in the coordinated rollout. The TUI remains the documented unlinked recording-TODO insertion exception.
- **Next:** coordinated client/backend v1 activation work described above, followed by the remaining shared-service/API-package and document-local state work. Packaged-native recovery verification remains; PostgreSQL testing is excluded.
- Verification passed: **103 native tests** (`bun test tests`, including concurrent outline work already in the workspace), native/web production builds, database-free Go server/agent tests, full Go build, and diff checks. Directory coverage includes locked patch preservation, deletion revalidation/emptiness/access checks, integer overflow rejection, failed-save barriers, live-cache precedence, late logout responses, duplicate submission suppression and interrupted recursive copy.
- **REBUILD/RESTART THE GOLANG SERVER OR THESE CHANGES WILL NOT BE LIVE.** Rebuild/reload native for directory patch/barrier changes; deploy the updated backend first.

### Coordinated v1 activation (2026-09-28)

- `ListDocuments` now advertises protocol **1**; list/get return persisted immutable keys and positive revisions from repeatable-read snapshots. Public Save/Delete/UpdateTodo/repository/pull adapters invoke transaction-owning v1 services. Legacy and unsupported protocol requests get typed `protocol_upgrade_required` before writes. Obsolete legacy Save/Delete/UpdateTodo implementations were removed.
- Standalone TODO create/delete also require v1 mutation IDs and atomically store receipts with domain changes/history/revisions. Creation is actor-scoped and has no document placement. Deletion retains admin-only authorization, checks current admin status **before receipt replay**, authorizes workspace scope, rechecks target scope under writer locks, and advances linked-document revisions. Exact replay still works after target deletion. No schema migration is needed.
- Web create/update/delete retain exact operation/request bytes in account/backend-scoped localStorage before transport, with a Web Lock preventing concurrent tabs from replacing the slot. Updates contain only changed fields. One outstanding command blocks new commands; recovery runs once on mount/reconnect or explicitly through Retry / refresh. Tokens are captured for transport and checked against the retained account; stale sessions cannot reconcile or clear another session's request.
- Acknowledgments are validated and followed by a live read/query refresh before releasing retention; historical receipt results never populate live caches. Lost responses, malformed acknowledgments and refresh/storage/auth/protocol failures preserve exact requests. Typed missing-target rejections release only after live reconciliation. This is bounded online-command recovery, not an offline queue.
- Directory metadata mutations remain online-only under their workspace-lock/barrier contract. The Python TUI's unlinked recording-TODO insertion remains the explicitly deferred direct-DB exception. TODO goals do not change document wire snapshots.
- Rollout: rebuild/restart backend and reload rebuilt native/web together. Existing native capability negotiation selects the durable controllers; legacy dirty baselines are adopted/reviewed by existing reconciliation. Old clients now receive upgrade errors. Do not roll the backend back to an unversioned writer while retaining v1 clients/drafts; keep pending requests and restore a compatible v1 build instead. Source activation is complete; deployed behavior and packaged-webview recovery still need application verification.
- Verification: **103 native tests, 8 web recovery tests**, database-free Go server/agent tests, full Go build, native/web production builds and diff checks passed. New regression coverage verifies public activation/rejection, create fingerprint completeness, user/workspace scope separation, current admin authorization, exact web replay across lost responses/restarts, create/delete recovery, malformed acknowledgments, missing targets, storage failures and scope changes.
- **REBUILD/RESTART THE GOLANG SERVER OR THESE CHANGES WILL NOT BE LIVE.**

### Verification and working tree

- Latest checkpoint: **95 passing native tests** with `bun test`; native and frontend production builds, DB-disabled Go server tests/build and `sqlc diff` passed. Database integration cases remain intentionally unexecuted. Status tests allow for the 3.5-second presentation delay.
- Tests include hook lifecycle/IndexedDB simulations plus rendered journal markup. They do not replace actual packaged-webview interaction or startup performance measurements. The first test pass missed user-visible journal/conflict defects; verify the real screen and user workflow, not merely internal flags.
- Relevant implementation files: `native/src/features/session/{useSessionSync.ts,draftReconciliation.ts,DraftConflicts.tsx,useSaveStatus.ts}`, `native/src/lib/{draftStorage.ts,backend.ts}`, `native/src/features/outline/{state.ts,tree.ts}`, journal/note/settings views, and `native/src/styles.css`.
- Relevant tests: `native/tests/{sessionRecovery.test.tsx,draftStorage.test.ts,journalConflictView.test.tsx,saveReconciliation.test.ts,outlineUndo.test.ts}`. Contract details remain in `docs/persistence-contract.md`.
- Changes remain in the working tree; preserve existing work and inspect status before further edits. No commit/push was requested. The owner reports the foundation migration applied. The latest backend changes require a Go server rebuild/restart. Public protocol activation remains pending as described above.
