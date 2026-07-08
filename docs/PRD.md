# Product Requirements Document

## Summary

Secretary needs a React Native mobile app for reading and editing notes, journals, and TODOs while using the same Go backend as the existing web and native clients. The app should be online-first with local caching for resilience, not a full offline-first sync system.

The mobile app should be touch-first and simpler than the desktop/native app. It should preserve the backend data model, especially block-based documents, but should not port keyboard-first or Vim-oriented workflows.

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
- Save through the existing `SaveDocument` endpoint.
- Replace local temporary IDs/client keys with server-returned identities after save.
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
- Store the bearer token securely enough for app-local use.
- Persist backend URL and session state in local storage.
- Logout clears token, cached user state, and sensitive local session state.

The app should use the existing backend auth model: `POST /api/login`, then `Authorization: Bearer <token>` for backend requests.

## Local Cache And Drafts

The app should be online-first with local cache and draft preservation.

Cache locally:

- auth token and user info
- backend URL
- configured workspace ID
- last loaded directory/document index
- recently opened documents
- unsaved note and journal drafts
- recent TODO list snapshot
- recent AI thread/message snapshot

Required behavior:

- Show cached data immediately when useful.
- Refresh from the backend when online.
- Preserve unsaved drafts across app restarts.
- Keep failed-save drafts until successfully saved or explicitly discarded.
- Avoid complex cross-device merge logic in V1.

Conflict behavior for V1:

- If an online save fails due to stale or invalid block identity, keep the local draft and show a recoverable error.
- Provide a manual reload-from-server action.
- Do not silently discard local edits.

## Recommended Mobile Stack

- React Native CLI app in `mobile/`.
- TypeScript.
- React Navigation.
- Zustand for local session/editor/UI state.
- TanStack Query for server-backed lists and mutations.
- MMKV for local persisted cache and drafts.
- Expo modules only where useful inside the React Native CLI app.

## Repository Structure

Suggested structure:

```text
mobile/
  src/
    app/
      navigation/
      providers/
    features/
      auth/
      notes/
      journals/
      todos/
      chat/
      settings/
    lib/
      api/
      storage/
      sync/
      outline/
    components/
```

## Shared Code Strategy

The existing native app has useful TypeScript logic that should be reused or copied into a shared layer instead of rewritten from scratch.

Useful existing sources:

- `native/src/lib/backend.ts`: manual JSON wrappers for login, documents, directories, TODOs, and AI.
- `native/src/features/outline/remote.ts`: backend document to outline-page mapping and reverse mapping.
- `native/src/features/outline/sampleData.ts`: journal date availability rules.
- `native/src/features/ai/useAIThreads.ts`: current thread creation and send flow.

Recommendation:

- Start by lifting/copying the needed API and mapping logic into `mobile/src/lib`.
- Later, consider extracting a shared TypeScript package if web/native/mobile need to share more code.

Avoid making generated Connect clients the first mobile dependency unless the existing generated clients are brought fully in sync with the backend AI/document surface.

## Backend Context

The mobile app should use existing backend APIs where possible.

Relevant backend behavior:

- Backend default local API port is `8080`.
- Auth uses `POST /api/login` and bearer-token middleware.
- Documents API supports list, get, save, delete, directory create/update/delete, and history.
- `SaveDocument` persists full document snapshots and reconciles blocks.
- Journals are unique by workspace/date and cannot belong to directories.
- TODO API supports list, get, create, update, delete, and history.
- TODO delete is permissioned; current backend allows only admins to delete TODOs.
- AI API supports threads, messages, and `RunAIThreadTurn`.

## Phases

### Phase 1: App Shell And Auth

- Create `mobile/` React Native app.
- Add TypeScript, navigation, query provider, MMKV storage, and app config.
- Implement login/logout.
- Hardcode and verify `MOBILE_WORKSPACE_ID`.
- Add Settings screen for backend URL and session/debug state.

### Phase 2: Notes And Directories

- Load document/directory index for the hardcoded workspace.
- Render full directory tree.
- Open note read-only.
- Create and rename directories.
- Create, rename, move, and delete notes.

### Phase 3: Block Editor And Save

- Implement editable block list.
- Add block creation/deletion/indent/outdent/reorder.
- Implement debounced `SaveDocument`.
- Preserve local drafts and save states.
- Handle failed saves without losing local edits.

### Phase 4: Journals

- Add Journals tab.
- Implement date list and current/future journal availability.
- Create-on-open missing journals.
- Reuse block editor and save flow for journals.

### Phase 5: TODOs

- Add My TODOs tab.
- List and filter authenticated user's TODOs.
- Create standalone TODOs assigned to the authenticated user.
- Edit TODO name, description, and status.
- Add block-level TODO controls in note/journal editor.
- Refresh TODO tab after block TODO saves.

### Phase 6: Chat

- Add Chat tab.
- List/open AI threads.
- Implement workspace chat.
- Implement note/journal contextual chat.
- Send messages through `RunAIThreadTurn`.

### Phase 7: Polish And Recovery

- Improve cached startup experience.
- Add manual retry/reload flows for failed saves.
- Add recent documents and basic search if needed.
- Tune mobile layouts and empty/error states.

## Risks And Open Questions

- The exact hardcoded workspace ID must be chosen before implementation.
- Block editing on mobile must stay simple enough to be usable while preserving the backend block tree.
- Current TODO APIs are user-centric; V1 should treat the TODO tab as "my TODOs" unless multi-user assignment becomes necessary.
- Block TODO creation/editing should rely on document save reconciliation unless backend gaps appear during implementation.
- Save conflict handling should preserve local drafts and avoid silent data loss.
