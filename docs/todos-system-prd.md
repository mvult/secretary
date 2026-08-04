# TODO System Rework PRD

## Summary

Secretary needs a stronger TODO system that treats tasks as durable work items instead of transient checklist lines tied to a single daily note. TODOs should still be easy to create and complete inside notes and journals, but they should also support priority ranking, deadlines, goals, a central repository, and a kanban-style view for planning active work.

The core product change is separating where a TODO is captured from where it currently lives. A TODO may originate in a journal or note, move to a central TODO repository, and later be pulled onto today's journal when it is on deck. A TODO should have one current location: one note/journal or the central repository, not multiple active document references.

## Goals

- Allow TODOs to be ranked by priority.
- Add deadlines to TODOs.
- Add a simple Goal object that TODOs can optionally link to.
- Reduce manual daily TODO porting between journals.
- Preserve completion context by keeping completed TODOs linked to the note or journal where they were completed.
- Add a central TODO repository for active, unbucketed, and on-deck work.
- Add a kanban-style visualization layer for the active working set, including `On deck`.
- Keep the long-tail of unbucketed TODOs out of the kanban by default, while making it easy to search and promote items into the active board.
- Keep inline TODO creation and editing inside documents fast and keyboard-friendly.

## Non-Goals

- Do not build a full project-management system.
- Do not add complex goal hierarchies, milestones, OKRs, or progress formulas in the first pass.
- Do not require every TODO to have a goal, deadline, or priority.
- Do not remove existing document-based TODO workflows.
- Do not build multi-user assignment or team collaboration features.

## Product Concepts

### TODO

A TODO is a task that can be represented inline in a document and tracked centrally.

Required fields:

- Title/text.
- Status.
- Priority rank.
- Optional deadline.
- Optional goal link.
- Source document/block reference where it was created, when available.
- Current document/block reference when the TODO currently lives in a note or journal.
- Completion document/block reference where it was completed, when available.
- Created, updated, and completed timestamps.

### Goal

A Goal is a simple semantic object used to group TODOs by outcome.

Required fields:

- Name.
- Description.
- Created and updated timestamps.

Goal behavior:

- TODOs may have zero or one goal.
- Goals should be editable from the TODO planning surface.
- Goals should stay intentionally simple in this version.

### Central TODO Repository

The central repository is the canonical place for TODOs that are not currently anchored to today's journal.

It should contain:

- On-deck TODOs.
- Blocked TODOs.
- TODOs with future deadlines.
- TODOs associated with goals.
- The long-tail backlog of unbucketed TODOs.

Completed TODOs should not need to live in the central planning queue unless a history view is explicitly filtering for them.

## Core Workflows

### Capture TODO Inline

Users can create TODOs in notes and journals as they do today.

Required behavior:

- Inline TODOs remain visible in the document.
- Inline TODOs are represented in the central TODO model.
- Updating status inline updates the central TODO.
- Updating priority, deadline, or goal from a TODO view updates the inline TODO metadata where practical.

### Move Note TODOs To Central Repository

Users can move every incomplete TODO on a given note or journal to the central TODO repository.

Required behavior:

- Applies to all incomplete TODOs in the current document.
- Moves those TODOs out of the daily/document-local active queue.
- Preserves the original source document/block link.
- Removes the visible TODO blocks from the current document once moved.
- Does not move completed TODOs.
- Does not duplicate TODOs if run more than once.
- Should be available as a command and keyboard shortcut in the native app.

This workflow replaces the manual habit of copying unfinished daily TODOs forward to another journal.

### Pull On-Deck TODOs To Today's Journal

Users can pull all `On deck` TODOs into today's journal.

Required behavior:

- Finds TODOs in the central repository with bucket/status `On deck`.
- Moves those TODOs into today's journal.
- Keeps TODO identity stable; this must not create duplicate independent tasks.
- If today's journal does not exist, create it using existing journal behavior.
- Completed TODOs stay linked to today's journal once completed there.
- Running the pull command repeatedly should not duplicate already-pulled TODOs.
- TODOs pulled into today's journal no longer live in the central repository as active repository items.

### Complete TODO In Today's Journal

When a pulled TODO is completed in today's journal, completion context should point to that journal.

Required behavior:

- Mark TODO complete centrally.
- Record completed timestamp.
- Record completion document/block reference as today's journal.
- Leave the completed TODO visible in today's journal.
- Remove it from active kanban buckets by default.

### Plan With Kanban

Users can manage TODOs in a kanban-style planning view.

Initial buckets:

- Inbox.
- On deck.
- Blocked.
- Done.

Required behavior:

- Drag or keyboard-move TODOs between buckets.
- Show priority rank clearly.
- Show deadlines clearly.
- Show goal association when present.
- Support filtering by goal.
- Support sorting by priority rank and deadline.
- Preserve keyboard-first operation in the native app.
- Do not render thousands of unbucketed TODOs as kanban cards.
- Treat the kanban as the active working set, not the entire TODO database.
- Provide a long-tail/backlog source panel or picker for searching and promoting TODOs into kanban buckets.

Long-tail behavior:

- Most TODOs should remain unbucketed by default.
- Unbucketed TODOs should be available through search, filters, goal views, deadline views, and priority-ordered lists.
- Users should be able to promote selected TODOs from the long-tail backlog into `Inbox`, `On deck`, or `Blocked`.
- Pulling TODOs into today's journal should only use `On deck`, not every high-priority or deadline-bearing TODO.

## Priority Ranking

Priority should be global and rankable, not just coarse labels.

Required behavior:

- Each active TODO can have an explicit global priority rank.
- Users can move a TODO up/down in priority with keyboard shortcuts.
- Kanban buckets should display TODOs in global priority order by default.
- If a TODO has no explicit rank, it should sort after ranked TODOs unless deadline sorting is selected.

Global ranking should be the main expression of priority. Buckets are lightweight views over the same ranked TODO set, not separate priority systems.

## Deadlines

TODOs can optionally have deadlines.

Required behavior:

- Store deadline date, with optional time only if existing date/time UI makes that cheap.
- Deadlines are date-only. Do not add deadline times in the first pass.
- Show overdue TODOs distinctly.
- Show due-today TODOs distinctly.
- Allow filtering and sorting by deadline.
- Pulling on-deck TODOs should not automatically pull every deadline-bearing TODO unless it is also in `On deck`.

## Status And Buckets

The existing TODO status model should stay simple. Kanban buckets should have little semantic weight and should not become a second task-status system.

Proposed active statuses:

- `todo`.
- `done`.
- `blocked`.
- `skipped`.

Proposed planning buckets:

- `inbox`.
- `on_deck`.
- `blocked`.
- `done`.
- `null` / unbucketed long-tail backlog.

Implementation note:

- Buckets are visualization/planning hints. Global priority rank remains the canonical ordering signal.
- Unbucketed TODOs are not kanban cards by default; they are a source pool for selecting what enters the active board.
- If backend compatibility requires keeping legacy `doing`, it should remain readable but not be reachable from new frontend cycles.

## Native App Requirements

- Add command: move all incomplete TODOs from current document to central repository.
- Add command: pull all on-deck TODOs into today's journal.
- Add kanban TODO view.
- Add searchable long-tail/backlog source for unbucketed TODOs.
- Keep TODO navigation keyboard-first.
- Support editing priority rank, deadline, goal, and bucket without opening a heavy modal when possible.
- Keep inline document TODO editing fast.

Suggested shortcuts:

- `Cmd+T` / `Ctrl+T`: open TODO view, as today.
- `J` / `K`: move selected TODO priority down/up within bucket.
- `Shift+H` / `Shift+L`: move selected TODO between kanban buckets.
- Command palette entries for repository push/pull workflows.

## Backend Requirements

- Add goal storage.
- Add TODO metadata for priority rank, deadline, goal link, planning bucket, source reference, and completion reference.
- Add idempotent endpoints or RPC methods for moving document TODOs to the central repository.
- Add idempotent endpoints or RPC methods for pulling on-deck TODOs into today's journal.
- Preserve stable TODO identity across document movement and journal pulls.
- Enforce one current TODO location: repository or one document block.
- Ensure central TODO queries can power kanban filtering, sorting, and goal views.

## Data Model Sketch

`goal`:

- `id`.
- `user_id`.
- `name`.
- `description`.
- `created_at`.
- `updated_at`.

TODO metadata additions:

- `priority_rank` nullable integer.
- `deadline_date` nullable date.
- `goal_id` nullable foreign key.
- `bucket` text.
- `source_document_id` nullable.
- `source_block_id` nullable.
- `current_document_id` nullable.
- `current_block_id` nullable.
- `completed_document_id` nullable.
- `completed_block_id` nullable.
- `completed_at` nullable.

Open implementation question:

- Confirm whether TODOs currently exist only as block metadata or already have a backend TODO table. The final schema should use the smallest migration that preserves stable TODO identity.

## Checkpoints

## Implementation Task List

Work this list from top to bottom. Mark tasks complete only after code is implemented and the relevant build/test command passes.

1. Confirm existing TODO persistence model. `[done]`
2. Update PRD semantics for one current TODO location, date-only deadlines, user-scoped goals, and no multi-note active references. `[done]`
3. Extend backend schema with planning metadata, current/completion location fields, and user-scoped goals. `[done]`
4. Add backend SQL queries for TODO planning fields and goal CRUD. `[done]`
5. Extend TODO protobuf API for planning fields and goal CRUD. `[done]`
6. Regenerate sqlc and protobuf code. `[done]`
7. Implement backend TODO mapping, validation, date-only parsing, bucket normalization, and goal RPC handlers. `[done]`
8. Verify backend compiles/tests after metadata and goal changes. `[done]`
9. Extend native backend client models and API helpers for TODO planning fields and goals. `[done]`
10. Add native kanban/backlog TODO planning view with bucket, priority, and deadline editing. `[done]`
11. Add native goal loading, goal filtering, goal display, and per-card goal editing. `[done]`
12. Verify native build after planning view changes. `[done]`
13. Apply backend migration to the target database. `[done]`
14. Runtime-test TODO list/update/goal RPCs against the migrated database. `[done]`
15. Add backend RPC for moving incomplete TODOs from the current document to the central repository. `[done]`
16. Ensure repository move preserves source document/block, clears current document/block, and does not delete canonical TODOs. `[done]`
17. Ensure repository move removes visible inline TODO blocks from the document without deleting completed TODOs. `[done]`
18. Add backend tests for idempotent repository move and repeated runs. `[done]`
19. Add backend RPC for pulling `on_deck` TODOs into today's journal. `[done]`
20. Ensure on-deck pull creates today's journal if needed using existing journal behavior. `[done]`
21. Ensure on-deck pull preserves TODO identity, creates visible journal blocks, updates current document/block, and avoids duplicates. `[done]`
22. Add backend tests for idempotent on-deck pull and completion-context behavior. `[done]`
23. Add native commands for repository move and on-deck pull. `[done]`
24. Add native keyboard shortcuts or command-palette entries for repository move and on-deck pull. `[done]`
25. Add keyboard movement for TODO priority and bucket movement in the planning view. `[done]`
26. Add overdue and due-today visual states. `[done]`
27. Verify full native daily workflow with real data. `[next]`
28. Re-run backend tests and native build after all TODO flow work. `[todo]`
29. Update docs/agent migration instructions once Goose replaces Atlas. `[todo: separate Goose migration PRD]`

### Checkpoint 1: Model And API

- Confirm current TODO persistence model.
- Add Goal model.
- Add TODO metadata for rank, deadline, goal, bucket, source, and completion references.
- Add central TODO list query.
- Add tests for idempotent movement and pull operations.

### Checkpoint 2: Native TODO Planning View

- Add kanban-style TODO view.
- Keep kanban scoped to bucketed/active TODOs rather than the full TODO database.
- Add backlog source/search for unbucketed TODOs.
- Add goal display/filtering.
- Add deadline and priority editing.
- Add keyboard movement between buckets and priority ranks.

### Checkpoint 3: Daily Workflow Commands

- Add move-current-document-TODOs-to-repository command.
- Add pull-on-deck-TODOs-to-today command.
- Ensure repeated runs do not duplicate TODOs.
- Ensure moved TODOs have only one current location.
- Ensure completed TODOs remain linked to the completion journal.

### Checkpoint 4: Polish And Migration

- Handle legacy inline TODOs without stable central identity.
- Preserve existing `doing` compatibility if needed.
- Add empty states and clear bucket labels.
- Verify with real daily journal workflow.

## Open Questions

- None currently.
