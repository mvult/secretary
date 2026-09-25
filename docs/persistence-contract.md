# Persistence Contract and Writer Inventory

Technical foundation for [Architecture and Persistence Reliability](architecture-reliability-prd.md), Phase 0. Audited against repository source on 2026-09-23. This specifies the implementation target; it is not a description of guarantees already deployed.

## 1. Current writer inventory

Paths below are relative to the repository root. Generated sqlc methods and migrations are not separate runtime entry points.

| Entry point | Current behavior / source | Required participation |
| --- | --- | --- |
| Native autosave, navigation flush, manual save | `native/src/features/session/useSessionSync.ts`: full snapshot through `SaveDocument`; acknowledgments/hashes live in memory; 10-second network debounce | One durable per-document controller, expected revision and persisted mutation envelope |
| Native rename, duplicate, directory move | `native/src/features/directory/useDirectoryBrowser.ts`: three direct `saveDocument` calls outside autosave | Rename/move must serialize with the same controller; duplicate uses fresh creation identities |
| Native note deletion | `native/src/app/useAppCommands.ts` → `DeleteDocument` | Online-only, resolve outstanding save first, revision check and receipt |
| Native TODO status/details | `native/src/features/todos/useTodos.ts` → `UpdateTodo` | Service mutation must lock and advance revisions of linked documents |
| Native move-to-repository / pull-on-deck | `native/src/app/useAppCommands.ts` → corresponding TODO RPCs | Atomic block/TODO changes, receipt, affected-document revisions and cache invalidation |
| Web TODO create/edit/delete | `frontend/src/components/{CreateTodoModal,EditTodoDrawer}.tsx` → generated TODO client | Same application services; retain existing admin restriction on standalone deletion |
| Document snapshot save | `backend/internal/server/documents.go`: `SaveDocument` | Owns document/blocks, inline TODO reconciliation/deletion, document links, history; all must commit with revision and receipt |
| Document deletion | Same file: `DeleteDocument` | Currently only notes; inspect cascade effects on other documents before deletion, include them in transaction/revision set |
| Standalone TODO mutations | `backend/internal/server/server.go`: `CreateTodo`, `UpdateTodo`, `DeleteTodo` | Shared authorization/transaction owner; discover linked blocks before mutation, including FK-driven clearing on deletion |
| Move document TODOs to repository | Same file: `MoveDocumentTodosToRepository` | Clears `block.todo_id`, retains block text, changes TODO current location; even stale-link cleanup changes the document |
| Pull on-deck TODOs into today | Same file: `PullOnDeckTodosToToday` | Finds/creates journal, inserts blocks, attaches TODOs; uniqueness and concurrent pulls must be atomic |
| AI create note | `backend/internal/server/agent/mutations.go` → `ai_agent_adapter.go` → `ai_tool_mutations.go`: `createDocument` | Currently makes a synthetic `SaveDocument` handler call; replace with shared service, stable tool-operation identity |
| AI insert/move block | Same adapter → `insertDocumentBlock`, `moveDocumentBlock`, `reindexSiblings` | Currently direct transactional sqlc writes; participate in document locking/revisions/history and receipts |
| Directory create/update/delete | `backend/internal/server/documents.go`; AI `ensureAIDirectory` also creates directly | Online-only. Serialize destination validation/deletion with document placement; a nonempty directory must not disappear through a race |
| TODO goals | `backend/internal/server/server.go`: goal CRUD | Does not change current document wire representation; invalidate TODO/goal queries, no body revision required solely for a goal rename |
| TUI transcript analysis | `tui/services/analysis_service.py` → `tui/db/service.py`: `TodoService.create_todo` | Deferred direct DB exception: inserts recording-derived TODOs with no document/block/workspace links |
| TUI recording lifecycle | `tui/db/service.py`: recording create/update/delete | No direct document writes found. Current recording→TODO FKs are `NO ACTION`, not cascading TODO deletion |

The audited Python code has no path updating/deleting an existing TODO or writing document/block rows. Its creation path does not currently invalidate a document revision. It also bypasses backend TODO history and uses database defaults for newer TODO metadata. This is the precise deferred exception; a future direct writer that attaches or updates existing TODOs requires re-audit.

### Indirect changes that must be included

Sources: `backend/sql/schema.sql`, `backend/sql/queries/{documents,todos}.sql`, `documents.go:loadBlockTodoStatuses`.

- A document response includes block `todo_id` and status loaded from `todo`, not just block columns. TODO status changes must advance every referencing document's revision.
- TODO deletion sets referencing `block.todo_id` to null through a foreign key. Discover all referencing documents, not just `todo.current_document_id`.
- Deleting a source document cascades deletion of its sourced TODOs. A TODO moved to another journal may still reference the original source document; deleting that source can therefore change the other journal's blocks. Include those surviving documents in revision updates. Preserve current cascade behavior pending any separate product decision.
- Directory deletion sets `document.directory_id` to null at the database level. The existing empty-directory check is outside a transaction; serialize it with save/move destination validation so the intended nonempty-directory rejection holds.
- Document saves currently rewrite canonical TODO name, description, assignee, status, current location and completion context. Revision protection must consider fields a save can overwrite, not only fields visibly returned in `Document`.

### Observed gaps to cover during service extraction

- `SaveDocument` has no expected revision or receipt. An ID-less journal save can find an existing journal and replace its blocks.
- Client keys are echoed in save responses but not persisted; subsequent reads synthesize `document-<id>` / `block-<id>`.
- Native stale-block recovery removes invalid server IDs and automatically retries; retire this behavior before revision enforcement. It can turn deleted content into new insertions.
- Standalone `UpdateTodo` uses request `user_id` as owner/history actor without resource authorization in that handler. Shared services must derive the actor from authentication and check resource access; request ownership is not authorization.
- `PullOnDeckTodosToToday` inserts a block before a conditional TODO attachment. On a zero-row attachment it currently continues, potentially leaving an extra block. Atomic mutation tests must cover this race.
- AI `blocksFromPlainText` begins `sort_order` at zero, while document validation requires positive values. AI insertion also passes a pre-insert block map to reindexing without adding the created block. Capture regressions for these existing paths when consolidating services.

## 2. Client and toolchain baseline

| Component | Source-controlled baseline |
| --- | --- |
| Native | `native/package.json`: app `0.1.0`, React `^19.2.0`, TypeScript `~5.9.3`, Vite `^7.2.4`, Tauri API `^2.8.0` / CLI `^2.9.1`; handwritten JSON RPC wrappers; no Protobuf/Connect dependency |
| Web | `frontend/package.json`: app `0.0.0`; Protobuf `^1.10.0`, Connect / Connect-web `^1.4.0`; generators ES `^1.0.0`, Connect ES `^1.7.0` |
| Web lock | `frontend/bun.lock`: resolved Protobuf / ES generator `1.10.1`, Connect / Connect-web / Connect generator `1.7.0`. Workspace manifest entries still say Protobuf `^1.0.0`, Connect `^1.6.0`: manifest/lock metadata drift exists |
| Generated TS | Headers show ES `1.10.1`, Connect ES `1.7.0`. Includes documents, workspaces, TODOs, users, recordings, AI; no generated activities files found |
| Go | `backend/go.mod`: Go `1.25.0`, Connect `1.19.1`, Protobuf runtime `1.36.11`, pgx `5.6.0`; document generated header reports protoc-gen-go `1.36.5` |
| Generation | `backend/buf.gen.yaml` and `frontend/buf.gen.yaml` use local, unversioned plugin names. No single pinned cross-client generation command |
| Migration workflow | `backend/atlas.hcl` and Atlas migrations remain active. Goose is a separate proposal |

App package versions are not evidence of installed/deployed client builds. The owner confirmed they are the only client user: update the app and server together, with no extended compatibility window or fleet inventory. No deployed server capability was queried.

For the first shared package, stay on the existing TS Protobuf/Connect v1 family; pin a mutually compatible runtime/generator set and reconcile lock metadata while migrating. A major-version upgrade is not needed for the persistence protocol. Pin Go generators as well and regenerate all services, including activities. Verify builds and generated drift then; this inventory does not establish that the current web build passes.

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

The loading follow-up is implemented: accurate stages, native/backend timings, and batched block/TODO reads. Owner measurements show workspace 4 improving from 941 queries / 91.83 seconds to four queries / 928.772 ms, with the same 180 documents, 1,832 blocks, and 758 TODO links. See [PRD continuation notes](architecture-reliability-prd.md#9-continuation-notes--owner-feedback-and-current-state-2026-09-23).

The Phase 2 schema/API foundation is now prepared, **not deployed**:

- Migration `backend/migrations/20260924100000_add_persistence_foundation.sql` backfills existing synthetic client keys, adds scoped uniqueness, positive revisions starting at 1, and a durable `mutation_receipt` table. UUID defaults cover legacy inserts during expansion; legacy handlers still synthesize read identities and do not honor submitted immutable keys yet. Coordinate initial v1 snapshot/identity adoption rather than assuming old cached keys match newly stored fallback keys.
- Receipt results are encoded response bytes (`bytea`) with explicit type/version, not raw incoming HTTP requests. SHA-256 is stored as 32 bytes. The document creation-key reservation index is workspace-wide across actors; receipt replay lookup remains actor-scoped. Resource deletions cannot cascade receipts; actor deletion is restricted. Polymorphic receipt scope IDs deliberately have no cascading FK. Creation identities deleted before receipt support cannot be recovered retrospectively.
- `backend/sql/queries/persistence.sql` provides transaction locks, receipt storage, creation reservation checks, explicit-key inserts, locked document reads and expected-revision increments. The service must authorize, acquire locks in the prescribed order, fingerprint, replay before resource checks, and atomically commit effects/receipt; generated queries alone do not supply those guarantees.
- `documents.proto` and new `persistence.proto` define additive revision/envelope/outcome/effects/error fields. Go/TS generated outputs are refreshed. Expected revisions preserve explicit zero versus missing and int64 JSON precision.
- Versioned or partially versioned saves/deletes are explicitly rejected with typed `failed_precondition / protocol_upgrade_required` until all writers participate. Legacy reads emit revision 0, not the unused database counter. There is no v1 capability advertisement or durable native envelope support yet.
- Generated SQL now requires the added columns. **Do not deploy this backend build before approved migration application.** Atlas checksums/directory validation, sqlc checks, backend non-DB tests, and native/web builds pass; migration execution, constraint/backfill verification and transactional race tests remain pending on dedicated infrastructure. No migration was applied.

Next: implement canonical fingerprinting and atomic receipt/revision-aware document services, coherent read transactions, and AI/TODO/directory writer participation, then the native controller and coordinated capability activation. Do not manufacture revisions for legacy baselines or replay old uncertain creates as new operations. Obtain permission before applying migrations.

**Subsequent owner feedback:** the owner reported successfully applying the foundation migration with `PGSSLMODE=disable atlas migrate apply --env neon`; no agent applied it. Native save-time row displacement was then reproduced and corrected: preserve already-valid parent-before-child row order, retain echoed block client keys, and match save-response/editor identities without positional fallback. Six new regressions bring native coverage to 42 passing tests. Existing persisted duplicate text requires deliberate recovery/cleanup, not guessed deletion. See the PRD's save-time regression handoff for details.

### Transactional service implementation (2026-09-25)

- `backend/internal/server/document_persistence.go` implements internal save/delete entry points and a shared transaction runner. Receipt replay precedes target/revision validation; workspace/document/TODO locks and dependency rediscovery cover related-document effects; content, history, revisions and the typed receipt commit together. Creation keys remain reserved and exact replay works after deletion. Journal creates can return an unchanged existing journal with a receipted outcome.
- `persistence_input.go` freezes fingerprint v1 using sorted-key JSON, explicit writable defaults, decimal string identities/revisions, raw content, ordered blocks and authenticated scope. Tests cover alternate JSON encodings, server-owned field exclusion, Unicode/whitespace/order changes and >JS-safe-integer revision precision. Validation rejects int32 overflow, immutable key mismatches and invalid trees/orders before committing.
- `documents.go` shares block/TODO/link/history persistence between legacy saves and the new transaction owner. Versioned TODO reconciliation preserves independently owned metadata and current location/completion context. The shared new-block TODO insert initializes completion context when status starts as done.
- Related-document revisions are conservatively advanced for the discovered/locked dependency set, including source/current/completion relationships. This is intentionally broader than minimal changed-body tracking and can cause extra related-document invalidations.
- Public List/Get document handlers now use read-only repeatable-read snapshots. Public read identities/revisions and write protocol gating remain legacy until all writers and clients participate. **The internal service is not exposed by RPC and is not evidence of deployed concurrency protection.**
- `document_persistence_integration_test.go` adds 11 real-Postgres scenarios behind `PERSISTENCE_TEST_DATABASE_URL`; `REQUIRE_PERSISTENCE_DB_TESTS=1` fails if unavailable. Tests compile; runtime DB scenarios await an owner-provided migrated disposable DB/CI target. Unit tests, Go build, sqlc consistency and diff checks pass. No migrations or database writes were performed.
- Next: execute the dedicated integration suite, route all backend writers through shared locks/revision services, add durable native envelopes and coordinated identity/baseline adoption, then enable capabilities and versioned enforcement. See the PRD's latest handoff for commands and the pending test-infrastructure decision.

### Remaining Phase 0 / release evidence

- Capture small/large workspace fixtures and startup/edit/undo profiles; no performance measurement was run for this inventory.
- Execute/capture the relevant regression cases; the scenarios above still need executable fixtures.
- Coordinate the owner's app/server update and capability enforcement; no additional-client compatibility window is needed.
- Review exact receipt/key/revision DDL and backfill with the active Atlas workflow before applying any migration. No database was accessed for this contract.
- Supply a dedicated test database in CI/target infrastructure before treating persistence integration coverage as passing.
