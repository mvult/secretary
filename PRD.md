# Product Requirements Document

## 1. Summary

- **Problem**: Internal meeting knowledge (summaries, recordings, action items) is hard to retrieve and track for a small team.
- **Goal**: Provide a web UI to browse meeting details and manage per-user TODOs with history.
- **Non-goals**: Argumentation/epistemology tables and workflows (future phase).
- **Success metrics**: Team can find a meeting and its summary/audio in under 30 seconds; TODO list per user is visible and editable with history.

## 2. Feature Checklist (Backend-First)

- [ ] Confirm existing schema aligns with requirements; propose changes (approval required)
- [x] Define TODO history/audit log storage model
- [x] Define ConnectRPC services + Protobufs (recordings, users, todos, history)
- [ ] Implement auth (email/password) + sessions
- [ ] Implement recordings list/detail endpoints with audio URL fallback semantics
- [ ] Implement TODO CRUD + history endpoints
- [ ] Backend integration tests
- [ ] Frontend shell routes/pages
- [ ] Meetings UI
- [ ] TODOs UI

## 3. Users and Use Cases

- **Primary users**: Internal employees (<10 people).
- **User stories**:
  - View past meetings with metadata, transcript, summary, and audio download.
  - View a per-person TODO list with CRUD and change history.
- **Core flows**:
  - Meetings: list → select meeting → view metadata + transcript + summary → download audio or show “ask Miguel” message if missing.
  - TODOs: select person → list TODOs → open TODO → edit text/status → see history.

## 4. Scope and Phases

- **Phase 1 (MVP)**:
  - Meeting list + details (metadata, transcript, summary, audio URL download).
  - Per-user TODO list + CRUD + status + history view.
  - Basic auth (email/password).
- **Phase 2**:
  - Search/filtering for meetings and TODOs.
  - Richer TODO metadata and UX polish.
- **Phase 3**:
  - Argumentation/epistemology features.
- **What’s next**:
  - Access controls by participant.
  - E2E tests if needed.

## 5. Product Requirements

- **Functional requirements**:
  - Meetings list sorted by date desc.
  - Meeting detail page: duration, participants, transcript, summary, and audio download link.
  - If audio URL missing/unavailable, show: “Ask Miguel for the recording if you need it.”
  - TODO list filtered by selected user.
  - TODO CRUD with status values: `not_started`, `partial`, `done`, `blocked`, `skipped`.
  - TODO history view showing edits over time.
- **Non-functional requirements**:
  - Readable, fast UI for small dataset.
  - No broken links; graceful fallback for missing audio.
- **Edge cases**:
  - Meeting with no transcript/summary/audio.
  - TODO edited multiple times rapidly (history still accurate).
  - User has zero TODOs.

## 6. Data and Persistence

- **Storage needs**: Postgres (Neon, existing DB).
- **DB connection details**: Use existing Neon connection string.
- **Schema entities**:
  - `recording` (meeting metadata, transcript, summary, audio_url).
  - `todo` (current state).
  - `todo_history` (audit log of changes; new table if needed).
  - `user`, `speaker_to_user` (participants).
- **Relationships**:
  - TODOs tie to both `user` and `recording`.
  - TODO history ties to `todo` + `user` (actor).
- **Migrations**: Use Atlas; changes require approval checkpoint.

## 7. Frontend Architecture

- **Framework/tooling**: Vite, React, React Router, Tailwind CSS, Mantine.
- **State management**: TanStack Query for server state.
- **Routing**: `/meetings`, `/meetings/:id`, `/todos`.
- **UI component patterns**: tables, cards, detail panels.
- **Validation**: Zod.

## 8. Backend Architecture

- **Language/framework**: Go, net/http router.
- **API style**: ConnectRPC + Protobuf.
- **Auth/session**: gorilla/sessions, email/password.
- **Data access patterns**: sqlc with pgx.
- **Migrations**: Atlas.
- **Infra/deployment**: Neon Postgres; web app hosting TBD.

## 9. Integration and External Systems

- **Third-party services**: Neon Postgres.
- **APIs/webhooks**: None for MVP.
- **Observability**: Basic logging.

## 10. Testing Strategy

- **Unit tests**: Minimal.
- **Integration tests**: Primary focus (backend).
- **E2E tests**: Not in MVP.
- **Test data/fixtures**: Seed users, meetings, TODOs, and TODO history.

## 11. Existing Code and Constraints

- **Repos/services**: Existing meeting/recording display code; use only minimal semantics.
- **Known limitations**: Some DB tables (argumentation/epistemology) are out of scope.
- **Dependencies**: Existing Neon schema; avoid schema changes unless approved.

## 12. Progress Log (Backend)

- **2026-01-26**:
  - Atlas migrations tracked in `public.atlas_schema_revisions` and `atlas.hcl` configured to use `public` for revisions.
  - Baseline schema and follow-up migration present; current target state includes `todo_history` with FKs to `todo`, `user`, and `recording`.

## 13. Checkpoints and Open Questions

- **Checkpoints for approval**:
  - Any schema changes (new tables/columns).
  - API design decisions that affect existing consumers.
  - Uncertainty in UX flow or data model.
- **Open questions**:
  - Do we need participant-based access control?
  - Should TODO history be fully immutable or allow corrections?

## 14. Suggested Next Steps (Backend)

- Confirm `todo_history` DDL matches desired semantics (statuses, actor, meeting linkage) and re-approve if changes needed.
- Implement TODO CRUD + history endpoints in Go + sqlc (include history insert on mutation).
- Implement recordings list/detail endpoints with audio URL fallback message.
- Add backend integration tests for TODO history and recordings detail.
