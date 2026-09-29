# Product Requirements Document: iOS App

## Summary

Secretary needs a native Swift/SwiftUI iPhone app for reading and editing notes, journals, and TODOs while using the same Go backend as the existing web and Tauri desktop clients. The app should be online-first with local caching for resilience, not a full offline-first sync system.

The mobile app should be touch-first and simpler than the desktop/native app. It should preserve the backend data model, especially block-based documents, but should not port keyboard-first or Vim-oriented workflows.

The implemented shared architecture and persistence foundation is documented in [Persistence Contract](persistence-contract.md), with verification evidence in [Reliability Verification](reliability-verification.md). It covers session/draft recovery, revision-checked saves, shared backend mutation services, generated API clients, and document-scoped state. It does not implement the mobile app itself.

Decision (2026-09-29): replace the proposed React Native implementation with native iOS. Share Protobuf definitions and persistence semantics across clients; implement mobile UI, storage, and recovery in Swift. No mobile app has been implemented yet. References below to the existing native app mean the Tauri desktop app.

## Goals

- Read, create, and edit notes.
- Read, create, and edit journals.
- Browse and manage the full directory tree for notes.
- View and edit "my TODOs".
- Create and edit TODOs directly from document blocks.
- Chat with the existing backend AI system in workspace and document context.
- Use a hardcoded workspace to avoid workspace-selection flow.
- Keep local cached drafts and snapshots while saving online.

## Non-Goals

- Android support in V1.
- Vim bindings or keyboard-first desktop parity.
- Full offline-first merge/conflict-resolution engine.
- Recreating the Tauri app's dense multi-pane UI.
- Meeting/recording browsing in the first mobile scope.
- Full document history UI in the first mobile scope.
- Pomodoro/site-blocking behavior on mobile.

## Users

- Internal Secretary users who need lightweight mobile access to notes, journals, TODOs, and chat.
- Primary use case is quick capture, review, TODO updates, and backend AI chat while away from desktop.

## Core Product Shape

The app should have five top-level areas:

- Notes
- Journals
- TODOs
- Chat
- Settings

## Workspace Behavior

The app should not expose a workspace picker.

- Configure one hardcoded `MOBILE_WORKSPACE_ID` in mobile app config.
- After login, use that workspace ID for document, directory, journal, and chat APIs.
- On startup/login, verify that the authenticated user has access to the configured workspace.
- If access fails, show a clear error rather than offering workspace selection.

Hardcoding the numeric workspace ID is preferred over hardcoding a workspace name because it avoids ambiguous name resolution and an extra startup flow.

## Notes

Notes are block-based documents with `kind = "note"`.

Required behavior:

- Show the full directory tree.
- Show notes inside the selected directory.
- Create notes in the selected directory.
- Rename notes.
- Move notes between directories.
- Delete notes.
- Open notes in a touch-friendly block editor.
- Autosave edited notes online.
- Preserve local drafts if saving fails.

Directory behavior:

- Create directories.
- Rename directories.
- Move directories where backend constraints allow.
- Delete directories where backend constraints allow.
- Preserve nested directory structure.

## Journals

Journals are block-based documents with `kind = "journal"`.

Important backend constraint:

- Journals cannot belong to directories.

Required behavior:

- Provide a separate Journals tab, not mixed into the directory tree.
- Show a date-based journal list.
- Open today's journal.
- Create a journal on open if one does not exist for that date.
- Support available future journal dates using the existing native app rule: after 6pm, tomorrow is available; after 6pm Friday, Saturday, Sunday, and Monday are available.
- Edit journals with the same block editor used for notes.
- Autosave journals online and preserve local drafts on failure.

## Block Editor

Documents must be edited as block trees, not as one large markdown/plain-text field.

V1 editor behavior:

- Edit document title.
- Render blocks in order with visual indentation.
- Edit block text with multiline inputs.
- Add block below.
- Delete block.
- Indent and outdent block.
- Move block up and down.
- Preserve parent/child block relationships.
- Preserve backend block IDs after saves.
- Generate stable local client keys for unsaved blocks.

Save behavior:

- Load the full backend document.
- Keep an editable local snapshot.
- Debounce online saves.
- Save through the existing `SaveDocument` endpoint using persistence protocol v1, an immutable mutation ID, and the acknowledged expected revision (explicit zero for creation).
- Atomically persist the draft and encoded pending request before sending. Local draft persistence must not wait for the network debounce.
- Preserve stable local client keys and attach server-returned identities/revisions after save; do not infer block identity from array position.
- Preserve newer edits made during a save; acknowledge only the submitted edit generation.
- Keep the local draft if save fails.
- Show simple save states: saving, saved, failed, unsaved changes.

The mobile editor should be simpler than the native outline editor. It should not include Vim mode, dense command workflows, or advanced keyboard-only controls.

## TODOs

TODO support has two surfaces: a dedicated TODO tab and block-level TODO creation/editing inside notes and journals.

### My TODOs

The TODO tab should focus on the authenticated user's TODOs.

Required behavior:

- List my TODOs.
- Filter by status: all, open, done, blocked, skipped.
- Create a standalone TODO assigned to me.
- Edit TODO name, description, and status.
- Show source context when available, including source document/block references.
- Refresh from the backend after mutations.
- Hide delete unless the backend permits the current user to delete.

### Block TODOs

Users must be able to create and edit TODOs directly from document blocks.

Required behavior:

- Convert a block into a TODO.
- Set or change a block TODO status: todo, doing, done, blocked, skipped.
- Keep TODO status visible on the block.
- Sync block TODO changes through document save.
- Reflect saved block TODO changes in the TODO tab after refresh.
- Preserve `todoId` returned by the backend.

The backend already reconciles block TODO state during document saves, so mobile should prefer editing the block document snapshot and saving the document rather than inventing a separate block-TODO API.

## Chat

The app should chat with the existing backend AI system.

Required behavior:

- Workspace chat with no document context.
- Note-specific chat using the active note document ID.
- Journal-specific chat using the active journal document ID.
- List AI threads.
- Open AI thread detail.
- Create a new AI thread automatically when sending the first message in a context.
- Send user messages through `RunAIThreadTurn`.
- Render assistant responses.

V1 does not need to expose AI artifacts, source refs, run JSON, or debugging details unless needed for support.

## Authentication

Required behavior:

- Login with backend URL, email, and password.
- Store the bearer token in iOS Keychain; never include credentials in cached documents or pending requests.
- Persist backend URL and non-sensitive preferences locally. Scope retained data by normalized backend URL, authenticated account, and workspace.
- Logout clears credentials and active in-memory session/cache state, and hides retained drafts and pending operations. Retain recovery records for that account, following the persistence contract; never expose or replay them under a different account.
- Validate the account and configured workspace against the backend before replaying retained operations. Expired credentials pause writes and preserve local work for reauthentication.

The app should use the existing backend auth model: `POST /api/login`, then `Authorization: Bearer <token>` for backend requests.

## Local Cache And Drafts

The app should be online-first with local cache and draft preservation.

Cache locally:

- scoped user identity (auth token is stored separately in Keychain)
- backend URL
- configured workspace ID
- last loaded directory/document index
- recently opened documents
- unsaved note and journal drafts
- acknowledged baselines, edit generations, immutable pending requests, and conflict/recovery records
- recent TODO list snapshot
- recent AI thread/message snapshot

Required behavior:

- Show cached data immediately when useful.
- Refresh from the backend when online.
- Preserve unsaved drafts across app restarts.
- Keep failed-save drafts until successfully saved or explicitly discarded.
- Avoid complex cross-device merge logic in V1.
- Use SQLite transactions for draft/baseline/pending-request changes. Server-response caches must never own or replace unsaved drafts or pending operations.
- Retain the original encoded request bytes and mutation ID for retry after timeout, process termination, or a lost response. Do not reconstruct an uncertain operation from the latest editor state.
- Resolve a pending document mutation before sending later edits or dependent commands. Apply the same retained-operation discipline to protocol-v1 TODO mutations and document deletion.
- Reconcile returned identities by client key. Refetch affected document bodies after related mutations; never attach a new revision to an old cached body.
- Persist edits during normal editing rather than relying on an app-background callback. On foreground/relaunch, validate session and protocol support, resolve retained operations, and refresh live state. V1 does not require continuous background sync.
- Never evict dirty drafts, pending requests, or conflict records. If local persistence fails, retain in-memory edits, surface the failure, and stop preparing new network mutations.

Conflict behavior for V1:

- If an online save fails due to revision conflict, deletion, or invalid identity, retain the draft, original baseline, rejected request, and latest available server copy. Branch on Connect codes and typed persistence error details.
- Provide explicit manual retry, review/save against the reviewed revision, and reload-from-server actions. Resolve uncertain pending operations before discarding/reloading; cancellation is not proof that the server did not commit.
- A replayed receipt acknowledges an earlier operation, not current server state; refresh before presenting its result as current.
- Adopt an `EXISTING_JOURNAL` response automatically only for an untouched create-on-open draft. Preserve an edited draft for manual resolution.
- Do not silently discard local edits.

## Mobile Stack

- Native iOS Xcode project in `mobile/`, written in Swift.
- SwiftUI for the five-tab shell, navigation, and touch-first screens; use UIKit integration where needed for reliable block text editing/focus.
- Observable Swift state for session/editor/UI state, with UI updates isolated to the main actor.
- Swift concurrency and an actor-owned save/recovery coordinator. Explicitly serialize pending-operation transitions across suspension points.
- SwiftProtobuf and Connect-Swift clients generated from the existing backend `.proto` definitions.
- A transport path that can send the original retained request bytes unchanged for durable mutations; ordinary reads can use generated RPC calls.
- SQLite-backed transactional cache, drafts, baselines, and pending operations; Keychain for credentials; UserDefaults for non-sensitive preferences.
- Swift Package Manager for dependencies, with pinned compatible runtime/generator versions and a reproducible generation/drift check.

This replaces the React Native/TypeScript, React Navigation, Zustand, TanStack Query, and MMKV proposal. The shared Go backend and its authentication model remain the API foundation.

## Repository Structure

Suggested structure:

```text
mobile/
  Secretary.xcodeproj/
  Secretary/
    App/
    Features/
      Auth/
      Notes/
      Journals/
      Todos/
      Chat/
      Settings/
    Core/
      API/
        Generated/
      Storage/
      Sync/
      Outline/
    Components/
  SecretaryTests/
```

## Shared Code Strategy

The shared boundary is the backend Protobuf schema and language-independent persistence contract, not the TypeScript runtime. Swift does not import `@secretary/api` or embed JavaScript to run the desktop save controller.

Useful existing sources:

- `backend/proto/secretary/v1/`: authoritative API messages, services, revisions, outcomes, and typed persistence errors.
- `packages/api/README.md` and `packages/api/src/transport.ts`: existing transport semantics, authentication, and retained-byte replay reference.
- `native/src/features/session/documentSaveController.ts` and its reconciliation code/tests: reference state transitions and failure cases, not a drop-in mobile library.
- `native/src/lib/draftStorage.ts`: reference durability, scope isolation, and recovery behavior; use SQLite transactions instead of IndexedDB/Web Locks.
- `native/src/features/outline/remote.ts`: backend document to outline-page mapping and reverse mapping.
- `native/src/features/outline/sampleData.ts`: journal date availability rules.
- `native/src/features/ai/useAIThreads.ts`: current thread creation and send flow.

Implementation direction:

- Generate Swift messages/clients from the same schemas used by Go and TypeScript. Preserve optional-field presence, including an explicitly present zero expected revision for creates, and use lossless Int64 handling with Protobuf JSON encoding where applicable.
- Port document identity/tree, journal-date, and save/recovery behavior into small Swift components. Do not port desktop-specific editor/UI machinery.
- Match persistence protocol v1 and typed errors. The backend fingerprints decoded writable fields; Swift need not reproduce JavaScript serialization order or calculate server receipt hashes.
- Add shared language-neutral protocol fixtures and equivalent Swift recovery tests to keep clients aligned as the contract evolves.
- Verify server capability before writes/replay; do not add an unversioned fallback. Protocol v1 is active in current backend source; target-deployment verification is still required.

## Backend Context

The mobile app should use existing backend APIs where possible.

Relevant backend behavior:

- Backend default local API port is `8091`.
- Auth uses `POST /api/login` and bearer-token middleware.
- Documents API supports list, get, save, delete, directory create/update/delete, and history.
- `SaveDocument` persists full document snapshots and reconciles blocks.
- Journals are unique by workspace/date and cannot belong to directories.
- TODO API supports list, get, create, update, delete, and history.
- TODO delete is permissioned; current backend allows only admins to delete TODOs.
- AI API supports threads, messages, and `RunAIThreadTurn`.

## Phases

Live checklist: mobile implementation has not started. Check off and strike through completed items as work lands; the next step is Phase 1.

- [x] ~~Choose native Swift/SwiftUI and define the mobile persistence/API boundary.~~

### Phase 1: App Shell And Auth

- [ ] Confirm minimum iOS version, app signing/distribution, workspace ID, and SQLite access library before scaffolding.
- [ ] Create the `mobile/` Xcode project, SwiftUI tab shell, observable session state, and app config.
- [ ] Add SwiftProtobuf/Connect-Swift generation, pinned dependencies, and generation drift validation.
- [ ] Implement login/logout with Keychain and account/backend-scoped state restoration.
- [ ] Add SQLite storage and transactional draft/pending-operation repository foundations.
- [ ] Hardcode and verify `MOBILE_WORKSPACE_ID`; validate the target server's persistence capability.
- [ ] Add Settings for backend URL and session/debug state.
- [ ] Verify a generated authenticated read, typed error decoding, and retained-byte transport compatibility against the target backend.

### Phase 2: Notes And Directories

- [ ] Load the paginated document/directory index for the hardcoded workspace; fetch full bodies on demand.
- [ ] Render the full directory tree and open notes read-only with cached startup.
- [ ] Implement directory create/rename/move/delete within backend constraints.

### Phase 3: Block Editor And Save

- [ ] Implement the editable block list with creation/deletion/indent/outdent/reorder.
- [ ] Implement the Swift save coordinator with immediate local durability and debounced protocol-v1 saves.
- [ ] Preserve pending request bytes, submitted generations, baseline revisions, and client-key mappings across restarts.
- [ ] Implement note create/rename/move/delete through the save/command coordinator.
- [ ] Add save states and manual conflict/retry/reload flows without losing local edits.
- [ ] Verify crash recovery, ambiguous outcomes, in-flight edits, deletion, journal-create races, and account switching before expanding editable scope.

### Phase 4: Journals

- [ ] Add the Journals tab and date list with current/future journal availability.
- [ ] Create missing journals on open, including safe `EXISTING_JOURNAL` handling.
- [ ] Reuse the block editor and save flow for journals.

### Phase 5: TODOs

- [ ] Add My TODOs with user-scoped listing and status filters.
- [ ] Create/edit TODOs and expose permitted deletion using retained protocol-v1 mutations.
- [ ] Add block-level TODO controls in the note/journal editor.
- [ ] Refresh TODOs and affected document bodies after mutations, preserving dirty drafts.

### Phase 6: Chat

- [ ] Add Chat with thread listing/detail and workspace chat.
- [ ] Add note/journal contextual chat through `RunAIThreadTurn`.
- [ ] Refresh affected document state after AI activity without replacing local edits; do not assume AI turns have the document-save replay guarantees.

### Phase 7: Polish And Recovery

- [ ] Improve cached startup and bounded clean-cache eviction.
- [ ] Add recent documents and server-backed search if needed.
- [ ] Tune touch editing, keyboard/focus behavior, and empty/error states.
- [ ] Verify foreground/background transitions, termination/relaunch recovery, and storage failures on iPhone.

## Acceptance And Checkpoints

- Core flows: authenticate, browse/manage notes and folders, edit block trees and journals, update standalone/block TODOs, and use workspace/document chat against the existing backend.
- Durability: acknowledged local edits survive restart; crash before send, lost response after server commit, and crash before local acknowledgment reuse one retained operation without duplicate effects or loss of newer edits.
- Concurrency: a desktop/AI/TODO change causes safe refresh or a visible retained conflict, never silent overwrite. Test journal-create races and historical receipt replay after deletion.
- Isolation: logout, expired credentials, backend/account changes, and late responses cannot expose or write another scope's data.
- Cross-language compatibility: generated Swift clients and protocol fixtures preserve Int64 values, optional zero revisions, identities, outcomes, and typed errors.
- Pause before scaffolding to settle the platform/distribution/storage choices listed in Phase 1. Review the touch block-editor interaction and recovery behavior at the end of Phase 3 before building out journals/TODOs.
- Backend schema changes are not expected for the Swift switch. Any discovered API gap should be scoped explicitly; applying migrations requires user approval.

## Risks And Open Questions

- The exact hardcoded workspace ID must be chosen before implementation.
- Minimum iOS version, bundle ID/signing and distribution method, and SQLite access library remain implementation checkpoints.
- Swift and TypeScript recovery implementations can drift; shared fixtures and translated recovery scenarios are required, rather than assuming generated API types enforce client durability.
- Connect-Swift integration must support the chosen retained-byte replay path and structured error decoding; verify this in Phase 1.
- Block editing on mobile must stay simple enough to be usable while preserving the backend block tree.
- Current TODO APIs are user-centric; V1 should treat the TODO tab as "my TODOs" unless multi-user assignment becomes necessary.
- Block TODO creation/editing should rely on document save reconciliation unless backend gaps appear during implementation.
- Save conflict handling should preserve local drafts and avoid silent data loss.
