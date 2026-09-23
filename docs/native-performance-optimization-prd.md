# Native App View Performance Optimization PRD

## 1. Summary

- **High-level project context**: Secretary's native desktop application is a Tauri shell containing a React 19 and Vite frontend. View transitions can intermittently feel slow, particularly as the workspace accumulates documents and blocks.
- **Scope of PRD**: A focused optimization pass over behavior-preserving React render and derived-state work performed during native app navigation.
- **Goal**: Make switching between native app views observably faster and more consistent by eliminating repeated indexing, sorting, searching, and persistence derivation that does not need to run during navigation.
- **Success measure**: Record browser performance profiles against the same realistic workspace and navigation flows before and after implementation. The optimized build must show a relative reduction in transition scripting/rendering time and repeated computation. No fixed millisecond threshold is required for this pass.
- **Non-goals**:
  - Changing autosave timing, ordering, or reliability.
  - Changing synchronization behavior or persistence semantics.
  - Caching TODO or AI API responses between view visits.
  - Changing API contracts, backend behavior, database schemas, or Rust commands.
  - Changing undo history depth or snapshot semantics.
  - Adding virtualization, pagination, or changing how much content is visible.
  - Redesigning native app navigation or UI.
  - Introducing a performance testing framework or automated benchmark suite.

## 2. Users and Use Cases

- **Primary users**: Keyboard-first native app users working in a realistically large workspace containing many notes, journals, and outline blocks.
- **Core flows**:
  - Switch from a note or journal to Search, Directory, TODOs, AI, Pomodoro, or Settings.
  - Return from a utility view to the current note or journal.
  - Open a large note without repeated per-row global indexing.
  - Open Journals without repeated per-row node-depth indexing.
  - Navigate while an outline edit is active without changing current draft persistence behavior.
  - Open the document-link picker and receive the same sorted results as before.

## 3. Data and Persistence

- **Storage needs**: None.
- **DB connection details**: Not applicable. The optimization must not add or alter database access.
- **Schema entities**: None.
- **Relationships**: None.
- **Migrations**: None.
- **Persistence constraint**: This pass may narrow React memoization dependencies to the values actually consumed, but it must not alter page cloning, hashing, save scheduling, save ordering, dirty-page detection, or failure recovery behavior.

## 4. Technology and Architectural Choices

- Continue using the existing Tauri 2, React 19, TypeScript, Vite, and Bun stack.
- Treat the React frontend as the optimization target. Initial inspection found no Rust command on the view-switch path.
- Prefer local `useMemo` derivation and one-time-per-render lookup maps over new state, global caches, dependencies, or architectural layers.
- Preserve the existing outline state and component APIs unless passing an already-derived lookup into child rows removes repeated work.
- Do not add `useCallback` or component memoization speculatively. Optimize only computations identified in profiling or direct code inspection.
- Use browser development tools for before/after measurements. Production build verification remains required, but no automated benchmark will be added in this phase.

## 5. Requirements

### Functional Requirements

- All views must display the same data and controls after optimization.
- Search ranking, scope, result limits, and selection behavior must remain unchanged.
- Document-link ranking, result limits, and selection behavior must remain unchanged.
- Outline indentation and selection rendering must remain unchanged for valid and malformed parent relationships.
- Journal order, previews, active-journal behavior, and editing behavior must remain unchanged.
- Navigation must continue committing active draft text through the existing reducer behavior.
- TODO and AI views must retain their current refresh-on-entry behavior.
- Autosave and dirty-page indicators must retain their current behavior.

### Performance Requirements

- An outline render must build the page-to-backend-ID lookup at most once per editor render, not once per row.
- An outline render must derive node depths at most once per page render, not rebuild a node index once per row.
- Selected-row membership checks must use constant-time lookup after one selection derivation.
- Journal previews must derive reusable node-depth lookups instead of rebuilding an index for each preview row.
- View-only state changes must not rerun full note search when documents and the query are unchanged.
- The closed document-link picker must not sort and filter all documents.
- View-only state changes must not recalculate persistence pages when pages, editing ID, and draft text are unchanged.
- Current page and journal collections must not be rescanned and resorted solely because an unrelated view field changed.

## 6. Scope and Live Checklist

- [ ] **Phase 1: Establish Baseline**
  - [ ] Select a realistic existing workspace and record its document, journal, and block counts.
  - [ ] Capture development performance profiles for representative transitions: Note to Search, Note to Directory, Note to TODOs, Note to AI, and utility view back to Journals.
  - [x] Identify repeated calls attributable to the scoped computations through code inspection.
- [ ] **Phase 2: Remove Per-Row Repeated Work**
  - [x] Build `pagesByBackendId` once per outline editor render and share it with outline rows.
  - [x] Derive node depths once per outline page and share them with outline rows.
  - [x] Replace repeated selected-ID array scans with one selected-ID set.
  - [x] Derive journal preview node depths once per journal collection render.
  - [ ] Verify indentation, links, selection, and editing on notes and journals.
- [ ] **Phase 3: Narrow Derived-State Recalculation**
  - [x] Memoize current-page and journal selectors using only page and active-page dependencies.
  - [x] Recompute Search results only when pages or the search query change.
  - [x] Skip document-link filtering and sorting while the picker is closed.
  - [x] Recompute persistence pages only when pages, editing ID, or draft text change.
  - [x] Share the app-level document lookup with note and journal outline editors.
  - [x] Avoid deriving preview depths for the active journal already handled by the outline editor.
  - [x] Group TODO buckets and backlog results in one memoized pass.
  - [x] Reuse the active-page hash for dirty-state detection.
  - [ ] Verify search, document links, navigation with an active draft, and save indicators.
- [ ] **Phase 4: Verify Improvement**
  - [x] Run `bun run build` in `native/`.
  - [ ] Repeat the Phase 1 profiles using the same workspace and transition sequence.
  - [ ] Document relative before/after scripting and rendering results.
  - [ ] Confirm that scoped repeated work is absent or reduced in the profiles.
  - [ ] Perform a smoke test of all native views and keyboard navigation.

## 7. Acceptance Criteria

- The production TypeScript/Vite build passes.
- Before/after profiles use the same workspace, app mode, and navigation sequence.
- Representative view transitions show a relative performance improvement without a regression in another measured transition.
- `OutlineRow` no longer independently scans all pages or rebuilds a node map for each row.
- Journal preview rows no longer independently rebuild node maps.
- Search and persistence derivations do not rerun for unrelated view-only state changes.
- The closed document-link picker performs no document filtering or sorting.
- Search results, document links, indentation, selection, navigation, autosave indicators, TODO refresh, AI refresh, and undo behavior remain functionally unchanged.
- No backend, Rust, API, schema, migration, or dependency changes are included.

## 8. Checkpoints and Open Questions

- **Checkpoint 1**: After baseline profiling, proceed directly with the scoped behavior-preserving changes unless profiling disproves the identified hotspots.
- **Checkpoint 2**: After implementation and build verification, compare profiles before declaring the work complete.
- **Stop for approval**: Ask before changing autosave scheduling, hash caching, persistence structural sharing, undo history, API refresh behavior, visible content volume, or adding virtualization.
- **Iteration guidance**: Complete one narrow pass over the seven approved low/no-risk optimizations. Do not expand scope merely because additional optimization opportunities appear.
- **Open questions**: None. Success is based on relative development-profile improvement rather than a fixed transition latency target.
