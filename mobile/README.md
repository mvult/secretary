# Secretary for iPhone

Native SwiftUI app targeting **iOS 26+**, initially simulator-only. Workspace **4** is configured in `Secretary/Core/AppConfiguration.swift`. The provisional bundle ID is `com.secretary.ios`; choose a signing team and final bundle ID before device distribution.

## Run

Open `Secretary.xcodeproj`, select the **Secretary** scheme and an iPhone simulator, then Run. Xcode resolves the pinned Swift packages. No XcodeGen installation is required.

The login screen accepts a backend URL, email, and password. The default URL is `http://localhost:8091`, which reaches the Mac's backend from the simulator. The app validates workspace access and persistence protocol v1 before opening the tab shell. Local-network HTTP is permitted; use HTTPS for remote backends.

From `mobile/`:

```sh
swift test
xcodebuild -project Secretary.xcodeproj -scheme Secretary \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath DerivedData test
```

The Xcode scheme runs the core tests plus a Keychain round-trip in the iOS app host; `swift test` runs the platform-independent tests on macOS. Keep simulator ad-hoc signing enabled so the app's Keychain entitlements are present; no development team is needed for simulator builds. The checked-in Xcode project contains the app and test target, while the local Swift package owns reusable core code.

## API generation

Requires Buf. Generator and runtime versions are pinned to SwiftProtobuf **1.38.1** and Connect-Swift **1.2.3**. GRDB is pinned to **7.11.1**. Commit changes to `Package.resolved` and Xcode's workspace lockfile when updating dependencies.

```sh
sh scripts/api.sh generate
sh scripts/api.sh check
```

Generation consumes `../backend/proto` through Buf's remote plugins; generated Swift files are checked in under `Secretary/Core/API/Generated`. Do not edit them by hand. The drift check generates into a temporary directory and compares the complete output.

## Foundation boundaries

- `BackendAPI`: REST login, generated authenticated workspace/capability reads, typed Connect errors, and exact-byte mutation transport. No automatic mutation retry or legacy protocol fallback.
- `SessionModel`: observable main-actor session state with epoch guards, Keychain restoration, login/logout, and foreground validation. A successful workspace RPC authenticates the JWT before its subject is used to check retained account identity.
- `DraftRepository`: GRDB/SQLite actor with account/backend/workspace-scoped records, local compare-and-set versions, atomic retained requests, and acknowledgment of only the submitted generation. Local schema migrations never reset the database.
- `KeychainCredentials`: device-local token/session storage. Logout hides retained recovery data and clears credentials, not drafts.
- `DocumentCoordinator`: account-owned actor queue with atomic local transitions, immutable retained save/delete envelopes, client-key reconciliation, and a durable live-refresh barrier after acknowledgments. Conflicts preserve local work and rejected envelopes; uncertain requests must be resolved before reload/discard.
- `DocumentEditor` / `EditorLibrary`: one editor per document, immediate ordered local writes, 700 ms network debounce, account-session gating, and recovery enumeration/resumption after validation.

Notes support paginated folder browsing, on-demand block documents, and account-scoped SQLite index/body caching. Pull to refresh; long-press a folder to rename, move, or delete it (empty folders only). Folder updates use presence-aware patches; folder mutations are never automatically retried, and a failed folder mutation requires refreshing before another attempt.

## Editing and recovery

- Create a note with the compose icon. Edit its title inline and tap block text to edit. Empty notes offer **Add first block**; all further block actions (add-below, indent/outdent, move-up/down, subtree deletion) live in the long-press menu. **Cycle TODO state** follows the native app's cycle: none → todo → done → none, using the same durable document-save flow. The keyboard toolbar only dismisses the keyboard.
- Use the note's menu to save, move, export, reload, or delete. Delete requires a clean acknowledged note. Headings and TODO boxes render when a block is not being edited.
- Reload runs immediately for clean documents; local edits/conflicts require **Discard edits** confirmation. A spinner and **Reloading…** stay inside the fixed-size status slot while replacement runs, without shifting the editor layout.
- Local writes happen immediately for actual changes; focus-only updates and no-op actions do not save. A small fixed-size status beside the title distinguishes local persistence from server acknowledgment; tap it for error details/recovery. The queue survives navigation. Retained requests resume after account/workspace validation and always use their original bytes and mutation IDs.
- Conflicts expose the retained draft and reviewed server copy. Explicitly save against that revision, discard edits and reload, or save a recovery copy. An uncertain request cannot be discarded. Archiving a resolved/rejected recovery hides it while retaining its SQLite snapshot.
- A local persistence failure keeps the in-memory text and pauses network preparation; retry local storage or export the text. Cache invalidation never overwrites drafts.

The Journals tab lists today, available future dates, and existing journals newest-first. After 6pm local time it offers tomorrow; Friday evenings also offer Sunday and Monday. The calendar action opens older dates. Missing journals are created on open through the retained save flow; an existing-journal response adopts the server copy only for an untouched placeholder, otherwise retaining a conflict. Journals reuse the block editor and TODO cycle, without folder-move or note-delete actions. Local journal recovery appears in the Journals tab.

## My TODOs

The TODOs tab lists the signed-in user's tasks with all/open/done/blocked/skipped filters (open includes todo and doing). Create a task with **+**, or open one to edit its name, description, and status. Source/current document links and source block IDs are shown when available. Delete appears only for a backend-reported admin.

TODO writes use retained protocol-v1 commands and changed-field patches. Unknown outcomes expose **Retry retained request** with the original bytes/ID, including after restart, and block new mutations until resolved. Definitively rejected commands can be discarded explicitly; authentication/permission failures remain retained. Acknowledgments invalidate caches and refresh open documents without overwriting dirty drafts. The shared block long-press menu includes all TODO statuses.

Chat is deferred. Cached startup follows successful session validation, so offline authentication/startup is not implemented. Touch/keyboard polish and real-device lifecycle/storage-failure exercises remain Phase 6 work.

## Live smoke test

The default suite uses fixtures and temporary SQLite stores. An opt-in iOS test uses the simulator's existing Keychain login to create, read, rename, edit, move, and delete a uniquely named smoke note in workspace 4:

```sh
xcodebuild -project Secretary.xcodeproj -scheme Secretary \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath DerivedData SECRETARY_LIVE_SMOKE=1 test
```

It deletes its test note after success and retains any interrupted operation in the app's scoped recovery store. No credentials are embedded in the test.

See [`../docs/PRD.md`](../docs/PRD.md) for the live implementation checklist and [`../docs/persistence-contract.md`](../docs/persistence-contract.md) for the cross-client protocol.
