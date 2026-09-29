# Reliability verification — 2026-09-28

## Verified locally

- `cd native && bun test tests`: **125 pass, 0 fail**. Includes integrated indexed loading, two-document edits/saves, undo against the acknowledged revision, local draft retention, fresh offline session restoration, and subsequent online saving against the current revision. The unrelated document remains unchanged and undo history does not survive restart.
- `cd native && bun run tauri build --bundles app`: macOS release build and app bundle succeeded. Artifact: `native/src-tauri/target/release/bundle/macos/Secretary Outline.app`.
- This is build verification and simulated session restart, **not** an actual packaged-process crash/disk-durability result. Hook tests use fake IndexedDB and mocked RPCs.

## Reproducible client profile

Run `cd native && bun run profile:reliability`.

Measured on Apple M4/macOS, Bun 1.3.14, 2026-09-28T21:45:16Z. Synthetic note-only fixtures, ten blocks/document, 100 loaded bodies for editing. RPCs use real client serialization against an in-process mock with zero network latency; storage uses fake IndexedDB. These are client microbenchmarks, not UI frame time, server performance, real-workspace startup, or WebKit disk latency. No backend/database writes occur.

| Measurement | 180 documents / 1,800 blocks | 1,800 documents / 18,000 blocks |
| --- | ---: | ---: |
| Cold index/body load + initial retention | 6.82 ms | 13.36 ms |
| Cold index reads / body reads | 2 / 1 | 18 / 1 |
| Warm storage restore + index revalidation | 1.33 ms | 8.65 ms |
| Warm body reads | 0 | 0 |
| Loaded-body refresh/reconciliation + retention | 5.22 ms | 13.22 ms |
| Refresh index reads / body reads | 2 / 0 | 18 / 0 |
| Edit CPU p50 / p95 | 0.040 / 0.088 ms | 0.039 / 0.089 ms |
| Retention p50 / p95 | 0.336 / 0.664 ms | 2.407 / 2.988 ms |
| Edit + retention p50 / p95 | 0.383 / 0.757 ms | 2.449 / 3.039 ms |
| Edit + retention maximum | 1.488 ms | 3.667 ms |

Cold/warm/refresh are single samples; editing uses 200 samples after 20 warmups. Refresh measures `loadIndexedWorkspace`, reconciliation and retention, not the entire UI Sync action or mutation transport. Results are observational, not timing assertions or release gates. The script asserts bounded cold body loading, equal-revision body reuse, and retained edited content.

### Initial finding (before index separation)

Body loading stays bounded and edit CPU is essentially flat at a fixed loaded-body budget. Retention still scales with workspace metadata: `DraftStorage.write` gets and puts the full index in the workspace CAS row on every write. Changed-document writes no longer copy all bodies, but metadata serialization remains. Consider separating the rarely changing index from the small CAS row after measuring actual WebKit latency. Paginated metadata loading also makes 18 sequential index requests at 1,800 documents; zero-latency figures do not capture that network cost.

### Follow-up: separate index storage

IndexedDB v6 now stores the index in its own scoped store. Immutable unchanged indexes are neither read nor written during ordinary retention. The index and small workspace CAS row still participate in the same transaction, preserving cross-window conflict detection and atomic updates. Legacy inline indexes migrate on the first successful save; older database writers are excluded by the version upgrade.

Same script, hardware and fixture, measured at 2026-09-28T22:05:01Z:

| Measurement | 180 documents | 1,800 documents |
| --- | ---: | ---: |
| Cold load + retention | 8.36 ms | 13.65 ms |
| Warm restore + revalidation | 1.42 ms | 10.46 ms |
| Refresh + retention | 4.87 ms | 11.02 ms |
| Edit + retention p50 / p95 | 0.105 / 0.138 ms | 0.091 / 0.118 ms |
| Retention p50 / p95 | 0.065 / 0.090 ms | 0.054 / 0.073 ms |
| Edit + retention maximum | 1.248 ms | 1.532 ms |

The metadata-size-dependent retention cost is removed in this synthetic profile; cold/warm startup still processes the full index. Request counts are unchanged. These observations retain the mock transport/fake IndexedDB limitations above.

Follow-up checks: **127 native tests pass**, production build passes. Coverage includes v1–v5 upgrades, index scope isolation, unchanged-index write skipping, changed/empty indexes, stale-writer recovery including the index, and transaction abort followed by successful retry. The earlier packaged app artifact predates this storage change; rebuild it for live verification.

## Remaining owner-workspace verification

### Journal loading regression follow-up

Owner reported unloaded journal cards and keyboard jumps over recent dates to old cached journals. Read-only inspection confirmed the intervening journal dates still exist. Boundary navigation now resolves the immediate neighboring journal from the full metadata index and loads its body before moving. Visible/nearby journal previews load automatically online, limited to two concurrent preview reads; offline uncached cards remain explicit. Regression coverage exercises forward/backward date navigation across uncached bodies and viewport-limited preview loading.

Subsequent query-read integration: **132 native tests pass** and the production build passes. New checks cover index/search key isolation by account/workspace/cursor/query, concurrent TODO/goal read deduplication, subsequent-read revalidation, cancellation on full/list-only clear, and partial pagination failure. Existing indexed session/search/recovery tests now exercise query-backed index transport. No live-server or packaged-runtime result is implied.

No desktop browser was connected to the agent session, so no live UI trace was captured. Deployed protocol-one support and actual app crash/restart durability are still unverified.

Use the built app for the following remaining scenarios:

1. Record cold startup, warm reopening, Sync, and sustained typing on the same workspace and build. Record document/block counts, loaded-body counts, RPC counts and elapsed times. Do not clear existing recovery storage to simulate a cold start; use a separate profile if needed.
2. Edit and save two notes; undo in one. Confirm the other note is unchanged, then save the undone content.
3. Edit a note, wait for local retention, force-quit before the ten-second autosave, and reopen offline. Confirm the draft survives. Reconnect and confirm it saves once.
4. Interrupt a save after server commit but before the response reaches the app; reopen and confirm exact-request replay, no duplicate insertion, and reconciliation against the live revision. This requires controlled response interruption, not merely quitting at an arbitrary time.
5. Verify editor/API/AI/TODO mutations together against the deployed protocol-one server, including source-document refresh and manual conflict recovery.

PostgreSQL tests are excluded. Real-server interaction and packaged crash verification remain separate from these local results.
