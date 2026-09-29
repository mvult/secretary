# Persistence Contract and Writer Inventory

Technical foundation for architecture and persistence reliability. Initial audit 2026-09-23; backend writer participation re-audited 2026-09-26. This specifies the implementation target; it is not a description of guarantees already deployed. See the dated implementation evidence below and [Reliability Verification](reliability-verification.md).

**Verification scope (owner decision, 2026-09-26):** PostgreSQL tests are excluded. They are not prerequisites, release gates, or planned follow-ups. Existing opt-in fixtures are unexecuted historical work. Continue with database-free tests/builds and application verification.

**Current source status (2026-09-28):** Protocol v1 is activated: coherent public reads advertise capability one; document Save/Delete and TODO create/update/delete/repository/pull require v1; native/web have retained request recovery. Deployment and packaged-native verification remain outstanding. Earlier dated sections record intermediate gated states.

## 1. Current writer inventory

Paths below are relative to the repository root. Generated sqlc methods and migrations are not separate runtime entry points.

| Entry point | Current behavior / source | Required participation |
| --- | --- | --- |
| Native autosave, navigation flush, manual save | `useSessionSync.ts` selects durable `documentSaveController.ts` after public v1 capability; 10-second debounce | Exact retained requests, expected revisions, baseline adoption and conflict recovery; old servers cannot downgrade retained v1 state |
| Native rename, duplicate, directory move | `native/src/features/directory/useDirectoryBrowser.ts` uses the strict session command barrier | Snapshot mutations use the save controller; copies clear server identities; failures stop recursive copy; scope changes suppress late results |
| Native note deletion | App commands → session strict barrier → durable delete controller | Local removal follows acknowledgment and related-cache refresh |
| Native TODO status/details | `useTodos.ts` → session barrier → retained patch → public v1 `UpdateTodo` → live body/TODO refresh | Atomic locked patch/receipt service; native recovery |
| Native move-to-repository / pull-on-deck | App commands → session barrier → retained command → public v1 TODO RPC → exact replay/live body refresh | Receipts, durable envelopes and resolved-date preparation |
| Web TODO create/edit/delete | Components → `todoCommandRecovery.ts` → exact retained protobuf JSON → public v1 services | Account/backend-scoped localStorage and cross-tab Web Lock; intentional patches; live refresh before release; admin-only deletion |
| Document snapshot save | `backend/internal/server/documents.go`: `SaveDocument` | Owns document/blocks, inline TODO reconciliation/deletion, document links, history; all must commit with revision and receipt |
| Document deletion | Same file: `DeleteDocument` | Currently only notes; inspect cascade effects on other documents before deletion, include them in transaction/revision set |
| Standalone TODO mutations | `backend/internal/server/server.go`: `CreateTodo`, `UpdateTodo`, `DeleteTodo` | Shared authorization/transaction owner; discover linked blocks before mutation, including FK-driven clearing on deletion |
| Move document TODOs to repository | `server.go` adapter → `todo_commands.go` transaction owner → shared domain helper | Clears `block.todo_id`, retains text, changes TODO location; revision/effects/receipt atomicity implemented internally |
| Pull on-deck TODOs into today | Same command service boundary | Finds/creates journal, inserts blocks, attaches TODOs; v1 retains resolved date and exact acknowledged counts/identities/effects |
| AI create note | Agent toolbox → `ai_agent_adapter.go` → `ai_tool_commands.go` → shared document persistence | Durable run/provider-call intent and result receipts; directory/note/blocks/history commit atomically; creation identity reserved |
| AI insert/move block | Same command service → `insertDocumentBlock`, `moveDocumentBlock`, `persistBlockOrder` | Exact retained arguments, shared sorted locks/revisions, blocks/history/result receipt in one transaction |
| Directory create/update/delete | Thin document RPC adapters → `directory_service.go`; AI directory creation shares its receipted note transaction | Online-only, workspace-locked target revalidation/emptiness/parent checks; field-presence rename/move patches preserve unrelated metadata; native strict barrier/live refresh |
| TODO goals | `backend/internal/server/server.go`: goal CRUD | Does not change current document wire representation; invalidate TODO/goal queries, no body revision required solely for a goal rename |
| TUI transcript analysis | `tui/services/analysis_service.py` → `tui/db/service.py`: `TodoService.create_todo` | Deferred direct DB exception: inserts recording-derived TODOs with no document/block/workspace links |
| TUI recording lifecycle | `tui/db/service.py`: recording create/update/delete | No direct document writes found. Current recording→TODO FKs are `NO ACTION`, not cascading TODO deletion |

The audited Python code has no path updating/deleting an existing TODO or writing document/block rows. Its creation path does not currently invalidate a document revision. It also bypasses backend TODO history and uses database defaults for newer TODO metadata. This is the precise deferred exception; a future direct writer that attaches or updates existing TODOs requires re-audit.

### Indirect changes that must be included

Sources: `backend/sql/schema.sql`, `backend/sql/queries/{documents,todos}.sql`, `documents.go:loadBlockTodoStatuses`.

- A document response includes block `todo_id` and status loaded from `todo`, not just block columns. TODO status changes must advance every referencing document's revision.
- TODO deletion sets referencing `block.todo_id` to null through a foreign key. Discover all referencing documents, not just `todo.current_document_id`.
- Deleting a source document cascades deletion of its sourced TODOs. A TODO moved to another journal may still reference the original source document; deleting that source can therefore change the other journal's blocks. Include those surviving documents in revision updates. Preserve current cascade behavior pending any separate product decision.
- Directory deletion sets `document.directory_id` to null at the database level. Empty-directory validation and deletion now run in one transaction under the same workspace lock as save/move destination validation, preserving nonempty-directory rejection.
- Snapshot saves now preserve standalone TODO metadata and unchanged canonical names; explicit inline text/status changes remain save-relevant. Revision protection must consider fields a save can overwrite, not only fields visibly returned in `Document`.

### Original audit gaps and current disposition

- Public `SaveDocument` now requires expected revision and mutation receipt identity; journal create-on-open returns an existing journal without replacing its blocks.
- Public reads now expose persisted immutable keys and real revisions; native baseline/key adoption preserves retained local work.
- Native automatic stale-block recreation was removed; invalid identities retain the draft for review.
- Standalone TODO creation/update/deletion derives the history actor from authentication. V1 creation uses `user_id` as intended assignee; patch updates preserve assignment. Linked workspaces are authorized under the shared lock discipline.
- Pull-on-deck now locks candidates and rolls back a failed conditional attachment.
- AI creation now uses positive global positions. Insertion includes the created block explicitly; subtree movement preserves unrelated visible order and temporarily vacates sort positions before reindexing. Database-free ordering regressions cover these corrections.

## 2. Client and toolchain baseline

| Component | Source-controlled baseline |
| --- | --- |
| Native | `native/package.json`: consumes `@secretary/api` through Bun workspace; React/renderer aligned at `19.2.4`; explicit domain adapters remain native-owned |
| Web | `frontend/package.json`: consumes the same generated clients/messages and retained-body transport through `@secretary/api` |
| Workspace lock | Root `bun.lock` replaces separate app lockfiles; frozen install verified |
| Generated TS | `packages/api/src/gen`: ES/Protobuf `1.10.1`, Connect runtime/web/generator `1.7.0`; documents, workspaces, TODOs, users, recordings, AI and activities; duplicate outputs removed |
| Go | `backend/go.mod`: Go `1.25.0`, Connect `1.19.1`, Protobuf runtime `1.36.11`, pgx `5.6.0`; document generated header reports protoc-gen-go `1.36.5` |
| Generation | Root `bun run api:generate` uses `buf.gen.frontend.yaml` and pinned workspace TS plugins; `api:check` regenerates into a temporary directory and checks drift in CI. Go generation still uses `backend/buf.gen.yaml` |
| Migration workflow | Goose, with baseline `20260928000000`; the existing database was metadata-baselined without replaying DDL. See [Goose cutover](#goose-cutover) |

App package versions are not evidence of installed/deployed client builds. The owner confirmed they are the only client user: update the app and server together, with no extended compatibility window or fleet inventory. No deployed server capability was queried.

The shared package stays on the TS Protobuf/Connect v1 family. Both builds and TS drift checks pass. Go generator pinning remains separate toolchain work; the existing Docker Go generator installs still use `latest`.

Shared transport preserves codes/details (`BackendError`), reports auth failures with the captured token, and accepts cancellation. Generated RPC serialization is used for ordinary native calls; exact retained request bytes are sent unchanged. `safeInteger` explicitly rejects unsafe app-ID narrowing and document revisions remain decimal strings. Query caches never own pending requests/drafts. See `packages/api/README.md` for mobile and REST-adapter boundaries.

### Goose cutover

On 2026-09-28, the owner-approved cutover replaced Atlas history with Goose baseline `20260928000000`. Existing `secretary_db` was marked applied without executing baseline DDL; Goose's ledger was created/populated and Atlas's ledger dropped atomically. Application data was untouched. The one-time SQL is retained at `backend/scripts/baseline-existing.sql`; future migrations follow the README and Goose project skill.

Read-only inspection found 31 application tables and four enum types, with no custom public routines, non-internal triggers, views, policies, extra extensions, or non-public application tables. The schema reference and baseline include two previously omitted live constraints: `todo_status_check` and `todo_history_status_check`.

Baseline/reference/live SQL comparisons covered 436 definitions; the before/after application-schema comparison found zero differences. Goose v3.27.0 validation passed, `sqlc generate` produced no code changes, `status` confirmed the baseline applied, and `up` reported no pending migrations. Fresh-database initialization was statically validated but not executed; other deployments were not baselined.

### Index and body loading

`ListDocumentIndex` returns metadata only, in descending immutable-ID pages (100 default, 200 maximum), with authorization on every page. The first ordinary page includes directories. Each page is a separate repeatable-read snapshot, not a workspace-wide snapshot spanning requests. Native validates cursor progress, scope, keys and revisions; it never treats an index entry as an editable body or draft baseline. Ordinary startup/navigation no longer uses the full-body `ListDocuments` endpoint, which remains available.

Startup loads a small journal window (three recent journals and today's if outside that window), or one note if no journals exist. Previously loaded records reconcile against live bodies or their own complete baseline when the index confirms the same ID/key/revision. Pending envelopes, legacy uncertainty, conflicts and explicit invalidations force live reads. An index omission requires an individual `GetDocument`; only a typed `not_found` establishes absence. Any other read failure aborts refresh and preserves retained state. On-demand body reads validate returned identity and scope and cannot publish after an account/workspace epoch changes.

Server-side literal title/body search uses the same pagination and bounds snippets to 240 characters. Local loaded bodies override server matches; unavailable/offline search labels cached-only coverage. Indexed full-text search and document-local undo remain follow-ups. No metadata entry is serialized through SaveDocument, and command/save replay continues to send its original retained bytes.

The scoped IndexedDB `indexes` store retains index metadata for offline navigation. Clean closed bodies use a 100-document LRU budget; the active document and dirty/pending/conflicted/retrying/invalidated or uncertain-baseline records are excluded from eviction. Eviction pauses during commands, saves and body loads. Eligible eviction removes bodies from IndexedDB/editor state and discards that document's undo history, preserving metadata. A failed storage transaction reports failure through the existing persistence error path. TanStack Query separately deduplicates live body reads, holds at most 100 idle results for up to five minutes, always revalidates subsequent opens, and clears on session/refresh cleanup. It never owns drafts or retained requests.

IndexedDB version 6 separates the index from the workspace CAS row. Opening upgrades the database non-destructively and excludes older writers; legacy inline indexes remain readable until the first successful save atomically moves them. Index changes, draft changes, retained commands and the CAS revision commit in one transaction. Unchanged immutable indexes incur no index reads/writes during ordinary saves. A stale writer retains its complete candidate, including its index, in recovery without changing live data. An aborted transaction advances neither the CAS revision nor the in-memory written-index marker, so retry writes the index again.

### Document-local editing and undo

Native live queries additionally cover index/search pages and workspace/TODO/goal lists. Index query keys include account/workspace, search text and pagination cursor; list keys include backend/account. Each read family retains at most 100 idle results for five minutes, independently of document-body results. Matching concurrent reads share transport work, but later calls revalidate. Session/refresh cleanup clears all query families; save completion clears list families before the related TODO refresh. Clearing cancels pending consumers, preventing late results from satisfying a new read. Index validation and caller epoch/search-scope guards still run outside the cache. Credentials are not query keys, and query results never replace retained mutation envelopes or editable drafts.

Undo now retains up to 100 content-only entries per document in memory, not workspace snapshots. Eviction discards that document's history. Undo restores title, logical block identity/tree/text/status and focus, while the live page retains its revision, directory and transport metadata. Block server-ID mappings are maintained separately and reconciled on acknowledgment: a block whose deletion was acknowledged must receive a fresh insertion key when restored, including when undo races the response. A newly inserted block deleted locally before its acknowledgment retains the returned mapping until a deletion is acknowledged. Save reconciliation preserves logical editor IDs across server allocation.

Immutable page identity is the dirty-observation/hash-cache boundary. Projecting an active draft preserves all untouched page references. The native editor uses incremental immutable storage capture and writes only changed document records, while preserving ordered writes, workspace CAS, retained commands and cross-window recovery. No-op/navigation operations do not create content undo entries. Remote replacement invalidates only affected histories. Undo histories are not persisted and never own mutation receipts or credentials.

## 3. Identity, snapshots and revisions

### Identity

- Persist existing API `client_key` fields as immutable logical document/block identities. Backfill existing rows with their current synthetic keys to preserve read identity. New client-created keys use UUID-based values.
- Document key uniqueness is workspace-scoped; block key uniqueness is document-scoped. A key and nonzero server ID must identify the same row. Duplicate keys, foreign IDs, conflicting parent ID/key pairs and invalid trees are typed validation failures.
- Parent keys reference blocks retained in the submitted tree. Require globally increasing positive `sort_order` in visible array order (which also guarantees unique sibling positions) and parent-before-child serialization. This matches native snapshots and SQL's global read ordering; sibling-only numbering would reorder rows on read. Descendants need not be contiguous. Missing old blocks are deletions, not implicit resurrection.
- Server IDs and revisions use Protobuf `int64`; local records use decimal strings and generated TS code uses `bigint`. Validate the actual database integer range before Go casts. Never silently truncate or round an ID.
- New creation keys must not be reused after deletion. Retained successful-create receipts reserve document creation identities even after resource deletion. Undoing an acknowledged block deletion uses a new block creation key/ID; pending requests always retain their original keys.

### Revision meaning

- Existing documents start at revision `1`; newly created documents return `1`. Revision `0` is a create precondition, never a server snapshot revision.
- Increment once per affected existing document per committed logical mutation. Every accepted full snapshot save increments once, even if identical; this avoids introducing no-op detection into the first implementation. Exact receipt replay never increments again.
- Cover title, kind/date, directory, tree structure/order/text, TODO identity/status, and TODO fields the snapshot reconciliation can overwrite. Initially conservatively bump all documents referencing a TODO for any successful TODO update. Goal-only metadata changes need not bump bodies.
- Document-linked TODO reconciliation must preserve independently owned metadata: description, assignee, bucket, rank, deadline and goal are not cleared/reassigned by a snapshot save. Only explicitly changed inline text/status updates canonical name/status; unchanged block text must not undo a standalone TODO rename. Location/completion rules remain shared service responsibilities.
- A revision and its body/TODO statuses must come from one consistent database snapshot. Use a read transaction with repeatable-read isolation for multi-query document loads; ordinary independent queries can produce a body that never belonged to its advertised revision.
- History hashes/timestamps are not revisions. History retention remains independent of receipt retention.

## 4. Save and mutation wire contract

Add fields without renumbering existing Protobuf tags. The following are semantic shapes; exact message definitions and migration DDL land in Phase 2.

```text
SaveDocumentRequest
  document                    existing snapshot, including immutable client keys
  protocol_version            1
  mutation_id                 UUID generated once for this operation
  expected_revision           optional int64; presence required, 0 means create

SaveDocumentResponse
  document                    canonical committed snapshot + revision
  mutation_id                 echoed operation identity
  outcome                     APPLIED | EXISTING_JOURNAL
```

The returned document includes every saved block's client key and ID, serving as the complete mapping; response position is never an identity match. Retain submitted generation only locally.

### Creates and journals

- Existing ID: expected revision must be positive. Missing resource returns `not_found`; never fall back to creation.
- No ID: expected revision must be explicitly zero and the document key must be unused. A different mutation attempting to reuse an existing/reserved creation key gets `already_exists`; this is not an upsert.
- For a journal create, serialize by workspace and use the existing `(workspace_id, journal_date)` database uniqueness constraint. If a journal already exists, return `EXISTING_JOURNAL` and its unmodified snapshot, recording this outcome in the receipt. Do not apply any incoming title/blocks.
- An untouched create-on-open draft can adopt that existing journal. A draft with any user edits is retained as a manual conflict, even if its text happens to match. This avoids guessing TODO/identity equivalence. Adoption is a deliberate identity remap, never changing the server journal key.
- Pull-on-deck also uses the shared journal resolver; it cannot replace journal contents while creating/finding the target.

### Other mutations

- Document delete and move-to-repository carry workspace ID, mutation ID and expected document revision. They remain online-only; serialize with any pending full save first.
- Pull-on-deck and AI insert/move are commands against current state under the same service locks, not full snapshot replacements. They carry stable mutation identities and advance affected document revisions. Missing/moved target blocks fail validation rather than substituting another target.
- Include the resolved journal date in the pull command's immutable input so retrying after midnight does not target another day. Preserve the current server-local date convention when initially resolving it; date behavior is not being redesigned.
- Give an AI operation a stable identity derived from run/tool-call identity. Retrying that operation reuses it; a new model tool call is a new operation. Do not generate a fresh UUID inside each service retry. Durable AI job recovery remains out of scope.
- TODO create/update/delete also use receipts. Unlinked TODO operations use an authenticated-user receipt scope; linked operations additionally authorize and lock their affected workspaces. Standalone TODO-to-TODO concurrent-edit merging is not introduced here; document revision protection still applies.
- Mutations affecting multiple documents return their IDs and new revisions (and deleted IDs where applicable). Invalidate clean snapshots and preserve/flag dirty drafts. Do not update a cached revision without the matching body.

## 5. Atomicity and receipt semantics

### Logical receipt record

```text
actor_user_id
scope_kind                    workspace | user
scope_id                      workspace ID or authenticated user ID
mutation_id                   unique with actor + scope kind + scope ID
protocol_version
operation                     e.g. document.save, todo.update
payload_sha256
target_ids / creation_key      stable lookup metadata, survives target deletion
result_type / result_version
result_payload                original response including mappings/revisions
committed_at
```

Never cascade receipts away when a document/block/TODO is deleted. No expiration in this release. User/workspace lifecycle cleanup needs an explicit policy before adding corresponding destructive endpoints.

### Fingerprint v1

- Build a versioned canonical JSON object from the decoded operation's writable fields, operation name, authenticated scope, target identity and expected revision. Sort object keys recursively; encode all IDs/revisions as canonical decimal strings; explicitly include defaults. Use UTF-8 SHA-256.
- Preserve text/title bytes, including whitespace and Unicode; do not normalize content for fingerprinting. Preserve submitted block array order. Parent relationships and client keys are included. Server-owned timestamps/returned TODO IDs are not writable inputs; exclude them consistently.
- Mutation ID is the receipt lookup key, not part of the payload hash; tokens, transport headers, local generations and retry counters are excluded. If a field becomes writable, version the canonicalization contract.
- Do not hash raw HTTP JSON or depend on unspecified Protobuf serialization order. Equivalent key ordering and omitted/default scalar encoding must fingerprint identically; different content/expected revision must differ. Keep v1 canonicalization available for retained v1 envelopes.

### Transaction order

1. Authenticate, validate protocol/required scope fields, and authorize the operation's scope. Never expose receipts across accounts or lost workspace access.
2. Begin the service transaction and serialize by receipt key (transaction-scoped advisory lock or equivalent unique-key reservation). Look up a committed receipt **before** revision/target-existence checks. Same operation/hash returns its original result; different operation/hash gives `mutation_id_reused`.
3. For the initial implementation, serialize document-affecting service mutations with a workspace transaction lock. Acquire multiple workspace locks in ascending ID order, then document row locks in ascending ID order, then TODO locks in ascending ID order. Include directory mutations. This deliberately favors correctness over fine-grained lock complexity.
4. Re-read dependencies under locks, authorize resources, check revision, validate keys/tree/destination, and discover FK effects. If the affected workspace set changed during discovery, roll back and retry discovery rather than extending the lock set out of order. Unlinked TODO commands recheck that they are still unlinked after locking the TODO.
5. Apply content/TODO/link/history changes, increment affected revisions once, materialize the response, and insert the completed receipt in the same transaction. Commit before responding. No externally visible committed placeholder receipt.
6. Any failure rolls back domain writes and receipt together. A commit whose response is lost is resolved by exact replay. Deadlock/serialization retries reuse the operation identity.

An exact replay after target deletion returns the original acknowledgment, without recreating anything. The client treats it as proof of the old operation, not proof of current existence: refresh before treating a recovered document as current. Newer unsaved edits then encounter deletion/conflict normally. Authorize replay using its retained scope/operation metadata and current permissions, rather than requiring the deleted row to exist.

All in-scope backend writers must adopt this lock/revision discipline before claiming protection. A workspace lock taken only by `SaveDocument` would not protect against the current AI/TODO paths.

## 6. Errors and session validation

Use Connect status codes plus a typed `PersistenceError` detail with `reason`, scoped document ID when authorized, and current revision when available. Clients branch on code/reason, never message regexes.

| Code / reason | Controller behavior |
| --- | --- |
| `unauthenticated` | Preserve state, pause network writes, request reauthentication |
| `permission_denied` | Preserve draft, show access failure; do not reinterpret as logout/empty workspace |
| `aborted / revision_conflict` | Retain draft and base, fetch latest authorized snapshot separately, manual resolution |
| `not_found / document_deleted` | Retain draft for recovery copy; never recreate via update |
| `already_exists / creation_key_exists` | Pause and resolve identity; never invent another key during retry |
| `invalid_argument / mutation_id_reused` | Pause as protocol error; retain exact request |
| `invalid_argument / invalid_identity`, `invalid_tree`, `invalid_destination` | Pause; retain draft and show actionable validation failure |
| `failed_precondition / protocol_upgrade_required` | Retain drafts, request compatible client/server; no legacy fallback |
| `unavailable`, deadline/transport failure, uncertain internal failure | Bounded backoff, reuse exact envelope; never assume rollback from a timeout |

Validation/conflict errors are not successful receipts. They authorize a controller to close that rejected attempt and create a new mutation only after correction/manual resolution. An uncertain transport failure does not. Preserve rejected-attempt context with the draft until resolution.

Add a small authenticated session lookup returning authenticated user ID, accessible workspaces, supported persistence protocol versions and whether revision enforcement is active. The current route set has login and workspace listing, but no authenticated self/capability lookup. A token parsed locally is not account validation.

Current auth middleware returns HTTP 401 `{error: ...}` before Connect handling. During transition, classify HTTP 401 structurally; normalize RPC authentication errors to Connect responses when implementing the shared transport. Keep REST login supported.

Old servers advertising no supported protocol cannot receive v1 envelope retries. Phase 1 may retain the existing legacy save path while adding local durability, visibly without revision/retry guarantees. Once a document has a v1 pending envelope, never downgrade it to legacy writes. Activate backend enforcement only after all supported native/web writers and backend AI/TODO services are migrated.

## 7. IndexedDB records and controller transitions

Use one versioned IndexedDB database behind a platform-neutral repository interface. Keys are compound arrays, not delimiter-concatenated strings.

```text
Scope = [normalizedBackendURL, userIDString, workspaceIDString]

drafts[Scope, documentClientKey]
  schemaVersion
  serverDocumentID?           decimal string
  draft                      title/kind/date/directory + ordered blocks/local keys
  editGeneration             increments for user-content edits only
  baseRevision?              null = no versioned baseline; "0" = known new draft
  acknowledgedGeneration
  acknowledgedSnapshot?      exact server baseline + key/ID mapping
  pending?                   immutable envelope below
  conflict?                  reason, rejected attempt, latest observed server copy
  updatedAt

pending
  protocolVersion
  operation, mutationID
  requestBytes               exact encoded request; no credentials
  encoding                   e.g. Connect JSON v1
  submittedGeneration
  submittedSnapshot          required to reconcile later edits
  expectedRevision
  createdAt

documentCache[Scope, documentClientKey]
  snapshot, revision, fetchedAt, lastAccessedAt

workspaceCache[Scope]
  metadata/index pages, directories, fetchedAt, completeness/cursor metadata
```

- Normalize backend URL using URL parsing: scheme/host/default port normalization, preserve deployment path, remove trailing slash; reject credentials/query/fragment. Never merge HTTP/HTTPS or different deployment paths. Backend changes create a new scope. Replacing a database behind the same URL requires explicit scope reset/revalidation, not silent draft rebinding.
- Preferences/credentials remain in existing settings. Cache/draft records contain no token/password. New drafts require a known prior account/workspace scope; do not assign anonymous content to the next account that logs in.
- Session states: `restoring`, `signed-out`, `validating`, `ready`, `reauth-required`, `unavailable`. Workspace load has independent `idle/loading/ready/failed` state. Track a session epoch so late responses cannot update another scope.
- Reauthentication retains and displays the current account's cached drafts. Explicit logout hides them and retains their records for that account. Workspace access must be validated before replay; offline access is only to the already selected cached scope.

### Local write and save transitions

1. Every content edit increments the per-document generation and schedules a local write immediately, independent of the 10-second network debounce. Coalesce while a write is running, then persist the newest generation. Include active editor draft text, not just committed outline nodes.
2. Show `locally-persisting` until the IndexedDB transaction completes. Track persisted generation separately from current generation; a storage failure cannot mark newer edits retained. Keep the in-memory draft visible and stop preparing new network mutations if their envelopes cannot be persisted.
3. Before a network save, atomically persist current draft plus pending envelope. Only then send it. One unresolved envelope per document; initially at most two different documents saving concurrently.
4. Edits while saving update the current draft/generation and leave the pending request untouched. Acknowledgment atomically updates baseline, mappings and acknowledged generation and clears only the matching mutation ID. Read the latest draft inside that transaction; never replace it with the submitted snapshot if newer edits exist.
5. If newer edits remain, use the new acknowledged revision for the next operation, retaining their text/tree. Apply returned mappings by client key, outside undo history. If reconciling a newer edit needs an identity that was deleted by the acknowledged save, create a new insertion identity rather than restoring the deleted server ID.
6. On restart restore the pending request exactly, validate session/scope/protocol, and resolve it before sending later generations. A crash before local acknowledgment safely replays the server receipt. A replayed old acknowledgment may not replace a newer cached server snapshot; retain acknowledgment history separately and refresh.
7. On conflict retain the local draft, original baseline, rejected request and latest observed server copy. Explicit manual resolution sets the newly reviewed baseline/revision and makes a new operation; another concurrent change conflicts again. A recovery copy gets new document/block keys and no old TODO identities.
8. Explicit discard/reload must first resolve an uncertain pending operation: aborting fetch is not proof the server did not commit. It can discard later local edits once the earlier operation is known, then fetch current server state.

Repository transactions use compare-and-set generation/envelope checks. Two native windows sharing IndexedDB must not silently overwrite each other's drafts: a stale local writer retains its candidate in a separate recovery record and surfaces a local conflict. Simultaneous network replay of the same persisted envelope is safe server-side; two different envelopes must not be installed for one document. Include multi-window coverage in repository tests.

Dirty drafts, pending envelopes, conflict/recovery records and their baselines are never LRU-evicted. Keep up to 100 clean recent bodies, excluding open documents. Evict clean cache on quota pressure; if persistence still fails, expose local durability failure. Non-destructive schema upgrades retain unknown/recoverable payloads and never clear a database to make startup succeed. Undo remains session-local, bounded to 100 groups per document.

## 8. Verification cases and handoff

These are source-derived regression specifications, not executed test results:

1. Failed startup/expired token does not hydrate an empty successful workspace or upload a blank replacement journal (`useSessionSync.ts`).
2. Crash after pending-envelope commit but before send, after server commit but before response, and after response but before local acknowledgment: same mutation, one server effect, newer draft survives.
3. Autosave races directory rename/move: one controller serializes both, no stale full snapshot replaces newer content.
4. Concurrent ID-less journal creates: one journal, second response never claims its local edited body was saved.
5. Standalone TODO status/name/description update followed by stale document save: revision conflict; after refresh an unrelated document edit does not clear TODO-owned metadata.
6. Delete a source note after its TODO moved to another journal: cascade advances the surviving journal revision; stale journal save conflicts.
7. Two simultaneous on-deck pulls and AI insert/move against a dirty editor: no orphan duplicate blocks, consistent positive ordering, advanced document revision.
8. Exact replay after deletion returns old acknowledgment without resurrection; same mutation ID with changed text/revision fails.
9. Logout/backend/workspace switch during response: old scope may settle its retained records, current editor/cache remains isolated.
10. Local quota failure, schema upgrade failure, and two-window stale writes preserve recoverable content and never claim success.
11. Body/TODO read racing a mutation returns a coherent snapshot/revision pair.

### Phase 1 implementation evidence

- `native/src/lib/draftStorage.ts`: IndexedDB v1, separate workspace metadata/document records, queued transactions, cross-window compare-and-set and retained stale-writer recovery snapshots. No destructive upgrade fallback.
- `native/src/features/session/useSessionSync.ts`: explicit session/load states, local restoration before network refresh, immediate local persistence including active editor text, scoped acknowledgments and logout/login/backend-switch handling.
- `native/src/features/session/draftReconciliation.ts` and `DraftConflicts.tsx`: preserve dirty pages and the matched server snapshot through refresh/restart, with review controls directly beside the affected journal/note. Conflict status and controls derive from the same draft records, including offline restoration. Explicit server reload works for a local journal without a server ID via its retained server snapshot. Removed automatic stale-block recreation.
- Generated blank journals carry a placeholder fingerprint that is cleared permanently on editing. Only untouched placeholders with no baseline/server ID/uncertain save adopt the matching server journal automatically. Legacy blank records without provenance require explicit review; intentional empty edits remain drafts. Session actions that create UUIDs execute once, then pass the computed state to React rather than generating different identities a second time.
- `native/src/lib/backend.ts`: structural HTTP/Connect error information and centralized authentication-failure notification. No backend endpoint/schema changes in this slice. Successful authenticated workspace listing validates the JWT remotely; only then is its subject checked against the retained account, and workspace membership checked. The typed self/capability endpoint remains Phase 2 work.
- Directory rename/copy/move document saves now use the shared native save path. Existing server notes cannot be deleted while disconnected. Editor hydration no longer synthesizes a blank journal.
- `bun test` in `native/`: 30 passing tests, including IndexedDB reopen/ordering/isolation/CAS, expired-token and failed startup, offline active-text recovery, reauthentication, account switching, quota failure, in-flight edits, late responses after logout and deleted-document recovery copies. Added blank-local/populated-server journal regressions covering startup actions, offline conflict restoration, intentional empty edits, adjacent review rendering, and read-only server reload. `bun run build` passes.

**Current boundaries:** This is the legacy-protocol bridge, not the v1 server contract above. It stores baseline snapshots/hashes and an uncertain-save marker, not a server revision or replayable receipt envelope. Interrupted legacy saves are paused for comparison. Read/compare before saving is not an atomic concurrency guarantee; Phase 2 supplies that protection. Full-workspace loading/snapshot work and bounded clean-cache eviction remain in Phase 5. Multi-window stale writes are retained separately and surfaced as a storage conflict; an automatic cross-window merge/recovery browser is not implemented. Packaged Tauri webview durability/UI smoke testing remains pending.

### Immediate next implementation slice

The loading follow-up is implemented: accurate stages, native/backend timings, and batched block/TODO reads. Owner measurements show workspace 4 improving from 941 queries / 91.83 seconds to four queries / 928.772 ms, with the same 180 documents, 1,832 blocks, and 758 TODO links.

The Phase 2 schema/API foundation is now prepared, **not deployed**:

- Migration `backend/migrations/20260924100000_add_persistence_foundation.sql` backfills existing synthetic client keys, adds scoped uniqueness, positive revisions starting at 1, and a durable `mutation_receipt` table. UUID defaults cover legacy inserts during expansion; legacy handlers still synthesize read identities and do not honor submitted immutable keys yet. Coordinate initial v1 snapshot/identity adoption rather than assuming old cached keys match newly stored fallback keys.
- Receipt results are encoded response bytes (`bytea`) with explicit type/version, not raw incoming HTTP requests. SHA-256 is stored as 32 bytes. The document creation-key reservation index is workspace-wide across actors; receipt replay lookup remains actor-scoped. Resource deletions cannot cascade receipts; actor deletion is restricted. Polymorphic receipt scope IDs deliberately have no cascading FK. Creation identities deleted before receipt support cannot be recovered retrospectively.
- `backend/sql/queries/persistence.sql` provides transaction locks, receipt storage, creation reservation checks, explicit-key inserts, locked document reads and expected-revision increments. The service must authorize, acquire locks in the prescribed order, fingerprint, replay before resource checks, and atomically commit effects/receipt; generated queries alone do not supply those guarantees.
- `documents.proto` and new `persistence.proto` define additive revision/envelope/outcome/effects/error fields. Go/TS generated outputs are refreshed. Expected revisions preserve explicit zero versus missing and int64 JSON precision.
- Versioned or partially versioned saves/deletes are explicitly rejected with typed `failed_precondition / protocol_upgrade_required` until all writers participate. Legacy reads emit revision 0, not the unused database counter. There is no v1 capability advertisement or durable native envelope support yet.
- Generated SQL now requires the added columns. **Do not deploy this backend build before approved migration application.** Atlas checksums/directory validation, sqlc checks, backend non-DB tests, and native/web builds pass; migration execution, constraint/backfill verification and transactional race tests remain pending on dedicated infrastructure. No migration was applied.

Next: implement canonical fingerprinting and atomic receipt/revision-aware document services, coherent read transactions, and AI/TODO/directory writer participation, then the native controller and coordinated capability activation. Do not manufacture revisions for legacy baselines or replay old uncertain creates as new operations. Obtain permission before applying migrations.

**Subsequent owner feedback:** the owner reported successfully applying the foundation migration with `PGSSLMODE=disable atlas migrate apply --env neon`; no agent applied it. Native save-time row displacement was then reproduced and corrected: preserve already-valid parent-before-child row order, retain echoed block client keys, and match save-response/editor identities without positional fallback. Six new regressions bring native coverage to 42 passing tests. Existing persisted duplicate text requires deliberate recovery/cleanup, not guessed deletion.

### Transactional service implementation (2026-09-25)

- `backend/internal/server/document_persistence.go` implements internal save/delete entry points and a shared transaction runner. Receipt replay precedes target/revision validation; workspace/document/TODO locks and dependency rediscovery cover related-document effects; content, history, revisions and the typed receipt commit together. Creation keys remain reserved and exact replay works after deletion. Journal creates can return an unchanged existing journal with a receipted outcome.
- `persistence_input.go` freezes fingerprint v1 using sorted-key JSON, explicit writable defaults, decimal string identities/revisions, raw content, ordered blocks and authenticated scope. Tests cover alternate JSON encodings, server-owned field exclusion, Unicode/whitespace/order changes and >JS-safe-integer revision precision. Validation rejects int32 overflow, immutable key mismatches and invalid trees/orders before committing.
- `documents.go` shares block/TODO/link/history persistence between legacy saves and the new transaction owner. Versioned TODO reconciliation preserves independently owned metadata and current location/completion context. The shared new-block TODO insert initializes completion context when status starts as done.
- Related-document revisions are conservatively advanced for the discovered/locked dependency set, including source/current/completion relationships. This is intentionally broader than minimal changed-body tracking and can cause extra related-document invalidations.
- Public List/Get document handlers now use read-only repeatable-read snapshots. Public read identities/revisions and write protocol gating remain legacy until all writers and clients participate. **The internal service is not exposed by RPC and is not evidence of deployed concurrency protection.**
- `document_persistence_integration_test.go` added 11 opt-in scenarios behind `PERSISTENCE_TEST_DATABASE_URL`; these compile but were not executed. PostgreSQL testing was subsequently excluded by owner decision. Unit tests, Go build, sqlc consistency and diff checks passed. No migrations or database writes were performed.
- Superseding owner decision (2026-09-26): PostgreSQL testing is excluded entirely, including release requirements and future follow-ups.

### Backend writer participation (2026-09-26)

- `persistence_writers.go` supplies sorted workspace/document/TODO locking, linked workspace authorization, and post-lock dependency revalidation to legacy Save/Delete, standalone TODO Update/Delete, repository moves, on-deck pulls, and AI insert/move. Each caller owns the transaction and advances the conservative affected-document set before commit. Dependency changes fail with `unavailable` and roll back; these unreceipted commands are not automatically replayed after ambiguous commit errors.
- Directory mutations and AI directory creation share workspace locks with destination validation; directory index-only changes do not bump unchanged body snapshots. New unlinked TODO creation and goal CRUD have no document-body effect. Python direct writes remain limited to unlinked TODO creation, as confirmed by the re-audit.
- AI create uses the internal receipted save service directly. The UUID survives internal transaction retries, but durable tool-call-derived identity and receipts for the remaining command RPCs are not implemented yet.
- Legacy inline TODO reconciliation now uses the same metadata-preserving path as versioned saves. New AI and pulled blocks use positive global ordering; AI reordering temporarily vacates occupied sibling positions inside its transaction.
- Database-free tests exercise dependency changes before/after row locking, authorization, lock order, revision advancement/deleted-document exclusion, and AI ordering/identity retention. Go server tests/build, sqlc consistency and diff checks pass. PostgreSQL runtime verification is still unexecuted; no database/dependency was added.
- Next: native durable envelopes and deliberate baseline/key adoption, remaining command envelopes/receipts, then coordinated activation. Public versioned RPCs remain gated and legacy snapshot writes still lack expected revisions. Shared transport-independent TODO/directory service extraction remains later Phase 3 work.

### Native durable snapshot controller (2026-09-26)

- `documentSaveController.ts` is a headless per-scope queue with one operation per draft and concurrency bounded to two. It persists exact request bytes, scope, mutation ID, submitted snapshot and edit generation before send/replay. Only the submitted generation is acknowledged; newer edits remain dirty. Retried operations never get a fresh mutation ID or payload.
- IndexedDB version 2 retains the original stores and v1 records non-destructively. Drafts add `draftId`, generation/acknowledged generation, envelope, retry and refresh metadata. Envelope schema version is independently checked. Old version-1 openers cannot overwrite the new format; failed opens/upgrades never clear storage. Tokens are not part of stored envelopes.
- Positive server revisions remain decimal strings, including values above JavaScript's safe integer range. Keys and expected revision come from the acknowledged baseline outside editor undo. Legacy baseline adoption requires unchanged server content and no uncertain legacy save; identities map by server ID. A deleted/unknown block ID is not silently converted into a new insertion.
- Startup authenticates and validates workspace access, reads capability/snapshots, and then replays retained operations before submitting newer edits for those drafts. Scope changes ignore late results. A receipt replay is followed by a live-document read so a historical result cannot silently resurrect a deleted document. Related effects refresh bodies instead of advancing cached revision counters alone.
- Transient failures/timeouts/cancellation retain the request; automatic attempts are bounded at three with backoff. Authentication pauses remote writes. Sync now, reconnect or restart can resume retained requests. Definite revision/identity/validation failures retain drafts for review. Connect codes and raw error details remain available rather than being reduced to message matching.
- Conflict review can explicitly save local content against the revision actually reviewed. A fresh check rejects another intervening change; the ensuing mutation still uses the reviewed expected revision. Edited journal drafts never adopt `EXISTING_JOURNAL` automatically. Copies use fresh document/block keys and independent TODOs.
- `ListDocumentsResponse.persistence_protocol_version` is an additive capability field; the Go server still leaves it at zero. Native v1 requires explicit capability 1 and coherent positive-revision snapshots. A v1 retained request/baseline cannot fall back to legacy writes. Public versioned Save/Delete remain rejected until coordinated activation; current-server operation is still the legacy bridge. The separate typed self/session endpoint remains unimplemented; current session validation uses authenticated workspace listing.
- Verification: 67 native tests, native/web builds, DB-disabled Go server tests/build pass. Tests include actual fake-IndexedDB upgrade/reopen and session-hook request interception, alongside headless controller tests. No new development dependency or database was introduced. Packaged-webview verification remains outstanding.
- Next: online delete and other command envelopes/receipts, command-to-document cache invalidation and pending-save barriers, then coordinated read/write/capability activation. The existing workspace-cloning/hash adapter and workspace-sized local writes remain Phase 5 state/performance work; durable snapshot saves do not complete those optimizations.

### Native online delete and command coordination (2026-09-26)

- The existing scope-owned controller also handles retained deletes. Preparation requires an acknowledged clean note and an online validated session; it uses the baseline's lossless revision. Mutation ID and deleted target must match the response. Exact requests survive lost replies, related-cache failures, local acknowledgment failures and restart with an absent server document. Newer edits are retained for explicit recovery instead of being removed by the older delete request.
- IndexedDB version 3 preserves v1/v2 data and excludes older openers. Existing save envelopes remain local schema version 1; deletion envelopes use local schema version 2 plus `operation: delete`. Both send persistence protocol version 1 on the wire. The local schema version is not a server capability advertisement.
- `runDocumentCommand` serializes native note deletion, TODO update, repository move and on-deck pull against snapshot saves. Best-effort flush completion alone is insufficient: the barrier drains newer edits and rejects pending/conflicted/failed saves. It durably marks workspace document bodies for refresh, checks again for intervening edits, pauses autosave through command completion/body refresh, and rejects late cross-session results. Unknown command outcomes never justify blindly rebuilding and resending a non-receipted command.
- TODO updates re-read the current TODO after the barrier and apply only the requested UI changes to that value before invoking the legacy full-update endpoint. This preserves metadata changed by the preceding inline save, but does not replace atomic server-side patch semantics or protect against every cross-client TODO race. Status-only optimistic body patches were replaced with coherent body refresh.
- 81 native tests and the native production build pass. Coverage includes deletion durability/replay/removal, storage/cache failures, newer-edit recovery, failed-save and edit-during-retention barriers, offline rejection, scope isolation and non-destructive local upgrades. Packaged-webview verification remains pending.
- Public Save/Delete remain gated and capability remains zero. Strict native command coordination also works against the legacy server; versioned deletion guarantees are still exercised with advertised-v1 test responses only. Remaining activation work includes TODO/repository/pull receipts and retained requests, durable AI tool identity, directory/AI command coordination, coherent v1 reads, and coordinated legacy-write rejection. No backend/schema change was made in this slice.

### Backend repository/pull command receipts (2026-09-26)

- `todo_commands.go` owns repository-move/pull transactions for both legacy adapters and internal versioned callers. V1 authorizes before receipt access, locks the shared actor/workspace/mutation namespace, replays before checking resource existence, checks fresh target scope, invokes existing writer locks/domain changes/history/revision effects, stores the typed protobuf receipt, and commits once. Known serialization/deadlock errors have bounded transaction retries; ambiguous failures are not proof of rollback.
- Operation identities are `todo.move_to_repository` and `todo.pull_on_deck`. Their canonical v1 payloads contain decimal-string `document_id` or canonical `journal_date`, respectively; the existing hash format includes authenticated scope and expected-revision sentinel zero for current-state commands. These are not snapshot expected-revision operations. Altered input or operation cannot reuse a committed mutation ID.
- Pull v1 requires an explicit retained date. Legacy calls resolve server-local today once per service invocation and reuse it across internal transaction retries. Native v1 date preparation remains to be implemented and must obtain the server-local date rather than silently changing the calendar convention. Replay does not consume newly eligible TODOs or recreate a deleted journal. Newly created journals appear in effects at revision 1, even for a zero-TODO pull.
- Additive TODO protobuf fields/generated Go/TS outputs are prepared. Public repository/pull RPCs reject versioned or partial envelopes with typed upgrade errors; capability remains zero and existing clients still send legacy commands. Native command retention, TODO-update receipts/patch semantics and durable AI operation identity remain before activation.
- DB-disabled Go tests/build, sqlc consistency, frontend build and diff checks passed. Pure tests cover validation/gates, command fingerprints, date stability and typed historical replay. Three additional opt-in PostgreSQL scenarios and extended access-revocation coverage compile but remain unexecuted. No migrations, application-database writes or new development dependencies were introduced.

### Native repository/pull retention and date preparation (2026-09-26)

- `todoCommandController.ts` prepares immutable scoped request bytes and validates receipt identity/results. `useSessionSync.runTodoCommand` owns preparation, online save-barrier coordination and IndexedDB retention. One retained command per workspace blocks additional commands and snapshot autosave until recovery completes; it is not a general offline queue.
- IndexedDB v4 stores the envelope with workspace metadata and draft/cache invalidation in the existing CAS transaction. v1–v3 upgrades preserve drafts and reject older writers. New command envelopes use local version 1 independently of save/delete envelope versions.
- Authenticated `GetTodoCommandContext` checks workspace access and returns the server-local calendar date. A fresh pull resolves that date before retaining its envelope. Replay never calls date preparation or allocates another mutation identity.
- Recovery validates session membership and v1 capability, sends exact retained bytes, reads live document bodies, reconciles newer local edits, and clears the envelope only with the refreshed local cache. Immediate command completion uses this same recovery path (one receipt replay); repeated failures wait for Sync/reconnect/restart. Failed refresh/storage preserves the request. Typed missing-target rejection after receipt lookup releases the slot only after live refresh; ambiguous/auth/protocol failures retain it. Historical receipts do not resurrect deleted journals.
- **91 native tests**, both production builds and DB-disabled Go server tests/build passed. Context date/membership integration assertions compile but were not run against PostgreSQL. Packaged recovery remains release verification. Capability stays zero; TODO-update receipts/patch semantics/native envelopes, durable AI identity and remaining coordination precede activation.

### Atomic TODO update receipts and native retention (2026-09-26)

- Versioned `UpdateTodo` carries an optional-field `TodoPatch`, protocol/mutation identity and workspace scope. Supported patch fields: name, description, status, bucket, priority, deadline and goal. Omission differs from explicit clearing; fingerprints contain only present fields, with raw text and decimal-string integer values. Legacy replacement fields cannot accompany a patch.
- `todo_patch.go` owns the internal update command via the shared transaction/receipt runner. It merges fields into a locked current TODO, computes status-only bucket changes there, validates goal ownership, records history, advances affected-document revisions and stores the exact typed response atomically. `PatchTodo` changes completion metadata only on a status transition; assignment/recording fields are preserved.
- `workspace_id=0` denotes an authenticated user-scoped command for an owned, unlinked TODO. Ownership and lack of workspace/document links are rechecked after locking. Workspace commands verify declared TODO scope after locking and workspace access before receipt replay. User and workspace hashes/receipt namespaces remain distinct; existing workspace fingerprints are unchanged. Additive TODO workspace identity supports native scope preparation.
- Native `runTodoUpdate` retains local command envelope v2 in IndexedDB v5 after the save barrier and scope read. Existing replay/auth/capability/cache recovery applies; legacy updates still use post-barrier metadata. The UI supplies only intentional patch fields and receives fresh live TODO data rather than the historical receipt. Recovery refreshes TODO views as well as document bodies. v1–v4 IndexedDB upgrades preserve retained data and reject older writers.
- **95 native tests**, native/frontend builds, DB-disabled Go tests/build and sqlc consistency passed. New opt-in PostgreSQL duplicate/history/revision/completion/scope/deletion-replay scenarios compile but remain unexecuted. No schema migration was required. Public versioned writes remain gated and capability is zero; AI identity/remaining writer coordination and release verification precede activation.

### Durable AI mutation identity and atomic receipts (2026-09-26)

- `MutationCall` carries persisted run ID, provider call ID, originating actor/workspace, tool name and exact argument bytes. Separate deterministic UUIDs identify `ai.tool.prepare` and application receipts. Names/arguments are fingerprinted, not used to derive identity, so a provider ID reused for changed intent fails rather than becoming another write.
- The prepare receipt durably retains the complete call envelope before any domain mutation. Application replay is authenticated against the originating run and current workspace membership, precedes target existence checks, and returns the historical tool result. Receipt storage is independent of mutable run debug JSON and needs no migration.
- AI create/insert/move now share the command transaction/retry owner. Domain changes, history, related-document revisions and result receipts are atomic. AI creation also creates/locates its directory in that transaction and reserves its stable document client key using the existing `document.save` creation-key receipt constraint.
- Mutation failure stops the model turn so it cannot automatically replace an uncertain call with a newly generated provider ID. This does not add resumable model jobs. Exact retained calls are replayable by the internal service; automatic job resumption remains outside scope.
- Database-free regression coverage exercises retained bytes, changed-intent rejection, run/call separation, required identities, argument validation and runner fail-stop behavior. Capability remains zero; standalone directory/client coordination and coordinated activation remain next.
- Verification passed: database-free Go server/agent tests, full Go build and diff checks. No schema migration or generated-client change was needed.

### Directory coordination and supported-writer activation audit (2026-09-28)

- Standalone directory mutations share a transport-independent command/transaction owner. Validation rejects integer overflow before conversion. Targets are rediscovered after the placement workspace lock, including delete; parent validation, cycle checks, emptiness checks and writes occur inside that transaction.
- `UpdateDirectory.patch` adds optional name/parent fields. Omission preserves locked current metadata; parent zero explicitly clears placement. Native sends only rename or move intent. Existing full-field callers retain legacy semantics. Directory metadata alone does not alter a document's wire snapshot or require a body revision.
- Native directory actions drain drafts through `runDocumentCommand`, stop on unresolved writes/conflicts, retain body invalidation before transport, and wait for live refresh. Responses are used for action feedback/selection, never to replace the refreshed directory cache. Backend/token/workspace changes invalidate old callbacks and clear scoped browser state; double submits are blocked synchronously.
- Recursive directory copy remains a sequence of online directory creations and retained local note creations. Each note uses strict save completion; failure stops further copying and preserves completed/local work. It has no atomic recursive-copy receipt or automatic resume. Unknown directory-create outcomes require live reconciliation, not automatic replay.
- Directory note edits use the session's synchronous dispatch bridge, ensuring the barrier sees newly created/changed notes immediately. Verification passed: 103 native tests in the current workspace, native/web builds, database-free Go server/agent tests, full Go build and diff checks.
- **Activation inventory:** public Save/Delete/UpdateTodo/repository/pull routing and coherent versioned read exposure remain gated. Web `EditTodoDrawer.tsx` is still a legacy full-update caller. The coordinated activation slice must migrate that caller, finalize standalone TODO create/delete command coverage and legacy-write boundaries, then advertise v1 and reject legacy snapshot/update requests together. AI mutation receipts and directory locking are ready; capability remains zero.

### Public v1 activation and standalone TODO receipts (2026-09-28)

- Public document list/get return versioned snapshots from existing repeatable-read transactions. `ListDocuments.persistence_protocol_version=1`. Save/Delete/UpdateTodo/repository/pull route to the existing receipted services, rejecting legacy/unknown protocol versions before writes; the old snapshot/full-TODO implementations were removed.
- Additive CreateTodo/DeleteTodo envelopes complete the standalone TODO receipt contract. Creation uses authenticated-user scope, fingerprints every writable field, and commits creation/history/result atomically. Deletion uses workspace scope for linked TODOs or authenticated-admin scope for unlinked TODOs; current admin authorization runs before receipt access, while target scope and dependency locks are checked before fresh writes. History, FK-driven body changes, affected revisions and receipt commit together.
- Web retains one exact operation/request per account/backend in localStorage, serialized across tabs with Web Locks. Create/update/delete all share this recovery slot. Updates send field-presence patches rather than stale full metadata. Recovery runs once on mount/reconnect or explicit Retry / refresh; acknowledgment and live reconciliation are required before clearing. Missing targets are released only after live refresh; ambiguous/auth/protocol/storage failures retain the envelope. Old receipt TODO values are never published as live cache entries.
- No new schema migration. Deploy/rebuild server/native/web together: old document/TODO writers now receive typed upgrade rejection. Backend rollback to pre-v1 is incompatible with retained versioned drafts; preserve them and restore a compatible build. Packaged-native/integrated application verification remains outstanding; source activation does not claim a deployed rollout.
- Verification: 103 native tests, 8 web command-recovery tests, database-free Go server/agent tests, native/web production builds, full Go build and diff checks. Added coverage includes activated public routing/legacy rejection, standalone fingerprint fields/scope separation/current admin authorization, and web lost-response replay, create/delete recovery, malformed acknowledgments, missing-target rejection, storage failure and account-change guards.

### Remaining Phase 0 / release evidence

- Capture small/large workspace fixtures and startup/edit/undo profiles; no performance measurement was run for this inventory.
- Execute/capture the relevant regression cases; the scenarios above still need executable fixtures.
- Coordinate the owner's app/server update and capability enforcement; no additional-client compatibility window is needed.
- Review exact receipt/key/revision DDL and backfill with the active Atlas workflow before applying any migration. No database was accessed for this contract.
- PostgreSQL testing is excluded by owner decision and is not remaining release work.
