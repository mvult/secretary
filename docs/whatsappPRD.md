# WhatsApp Ingest PRD

## Goal

Add always-on WhatsApp ingest to Secretary using `whatsmeow`, store incoming messages, classify each incoming message with an LLM against user-editable importance instructions, and surface important messages as native app notifications.

## Non-Goals

- Do not send WhatsApp replies from Secretary in this phase.
- Do not auto-create TODOs, notes, or journal entries from WhatsApp messages yet.
- Do not build multi-account WhatsApp support yet.
- Do not build a full WhatsApp chat UI yet.
- Do not classify historical backfill messages unless explicitly requested later.

## Product Behavior

- WhatsApp integration is always enabled when the backend starts.
- On first run, backend exposes admin status/QR endpoints so the native app can pair the WhatsApp account.
- Backend listens for all incoming WhatsApp messages after pairing.
- Every incoming message is persisted before classification.
- Every incoming text/caption message is sent to the configured LLM classifier.
- The classifier uses a user-editable prompt/instruction text from the native app settings page.
- Each message is marked important or not important, with a short reason and classifier metadata.
- If a message is important, the native app creates a local notification.
- Duplicate WhatsApp events must be idempotent and must not create duplicate notifications.

## User Settings

Add a native settings field for WhatsApp importance instructions.

Default text:

```text
Mark a WhatsApp message as important if it likely needs my timely attention, asks me to do something, contains a commitment, includes urgent personal or work context, mentions scheduling, money, travel, family logistics, health, or anything that would be costly to miss. Mark casual chatter, reactions, memes, FYIs, and low-stakes group noise as not important.
```

Settings requirements:

- Editable from the native app settings page.
- Persisted locally and synced to backend, or persisted directly in backend if native settings already use backend-backed storage.
- Backend classification must always use the latest saved text.
- Empty text should fall back to the default text.

## Backend Architecture

### WhatsApp Client

- Add `go.mau.fi/whatsmeow`.
- Use whatsmeow `sqlstore` for WhatsApp auth/session state.
- Prefer a local SQLite session DB path such as `backend/var/whatsapp-session.db` so whatsmeow-owned tables stay separate from Secretary Postgres schema.
- Start the WhatsApp client from `backend/cmd/server/main.go` with the app context.
- Connect automatically on backend startup.
- Reconnect automatically when disconnected.
- Print QR pairing events to logs for local debugging, but expose QR through admin endpoint for native UI.

### Admin Endpoints

Expose authenticated admin endpoints under `/api/whatsapp/*`.

- `GET /api/whatsapp/status`
  - Returns connection state, pairing state, logged-in JID, last connect error, and latest QR availability.
- `GET /api/whatsapp/qr`
  - Returns latest QR pairing code or QR payload when pairing is required.
  - Returns a useful status when already paired.
- `POST /api/whatsapp/reconnect`
  - Forces disconnect/reconnect.
- `POST /api/whatsapp/logout`
  - Logs out WhatsApp and clears the current session.
- `GET /api/whatsapp/settings`
  - Returns current importance instructions.
- `PUT /api/whatsapp/settings`
  - Updates importance instructions.

### Message Storage

Add Postgres tables managed by Atlas migrations and sqlc.

`whatsapp_chat`:

- `id bigint identity primary key`
- `jid text not null unique`
- `name text null`
- `is_group boolean not null default false`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

`whatsapp_message`:

- `id bigint identity primary key`
- `chat_jid text not null`
- `message_id text not null`
- `sender_jid text null`
- `sender_name text null`
- `is_from_me boolean not null default false`
- `sent_at timestamptz null`
- `received_at timestamptz not null default now()`
- `message_type text not null`
- `text text null`
- `raw_json jsonb not null default '{}'::jsonb`
- `classification_status text not null default 'pending'`
- `classification_important boolean null`
- `classification_reason text null`
- `classification_model text null`
- `classification_error text null`
- `classified_at timestamptz null`
- `notified_at timestamptz null`
- `created_at timestamptz not null default now()`

Constraints/indexes:

- Unique `(chat_jid, message_id)` for idempotency.
- Index `(classification_status, received_at)`.
- Index `(classification_important, received_at desc)`.
- Index `(chat_jid, sent_at desc, id desc)`.

`whatsapp_settings`:

- `id boolean primary key default true check (id = true)`
- `importance_instructions text not null`
- `updated_at timestamptz not null default now()`

### Classification

Classification flow:

1. Receive whatsmeow message event.
2. Ignore outgoing messages for notification purposes, but store them if useful for context.
3. Extract message text from conversation, extended text, and media captions.
4. Upsert chat.
5. Insert message with `classification_status = 'pending'` using idempotent unique key.
6. If inserted and has text/caption, enqueue classification.
7. Classifier reads current importance instructions.
8. LLM returns strict JSON:

```json
{
  "important": true,
  "reason": "Short reason."
}
```

9. Store classification result.
10. If important and not already notified, mark notification pending/ready for native app.

Classifier requirements:

- Use existing backend AI provider configuration where practical.
- Keep prompt short and deterministic.
- Require JSON output and handle malformed model output as `classification_status = 'error'`.
- Add conservative retry path later; do not block WhatsApp ingest on LLM failure.
- If text is empty or unsupported message type, mark not important with reason like `No text content to classify`.

### Notification Delivery

Native app notification requirement:

- Native app polls authenticated backend endpoint for important unnotified messages, or subscribes later if an event stream exists.
- Initial implementation should use polling to keep scope small.

Backend endpoint:

- `GET /api/whatsapp/notifications/pending`
  - Returns important classified messages where `notified_at is null`.
- `POST /api/whatsapp/notifications/mark-notified`
  - Accepts message IDs and sets `notified_at = now()`.

Native behavior:

- Poll while app is running.
- Create a local OS notification for each pending important message.
- Mark messages notified only after notification creation succeeds.
- Notification title should include sender/chat name when available.
- Notification body should include a short preview and classification reason.

## Native App Requirements

- Add WhatsApp section to settings page.
- Show connection status.
- Show QR pairing payload/code when not paired.
- Allow reconnect and logout actions.
- Add editable importance instructions textarea.
- Save instructions to backend.
- Poll pending important WhatsApp messages while native app is running.
- Create local notifications for pending important messages.
- Mark messages notified after successful local notification creation.

## Privacy/Safety

- Store raw WhatsApp event JSON for debugging and future parsing.
- Do not log full message bodies at info level.
- Do not send outgoing WhatsApp messages in this phase.
- Do not expose WhatsApp endpoints without existing auth middleware.
- Idempotency must prevent duplicate rows and duplicate notifications.

## Open Questions

- Should outgoing messages be stored for context, or should they be ignored entirely?
- Should group chats have stricter default importance rules?
- Should pending notifications be delivered when the native app was closed, or is app-running polling sufficient for phase one?
- Should message media be downloaded later, or only captions/text for now?

## TODOs

### Checkpoint 1: Backend Storage

- Add Atlas migration for `whatsapp_chat`, `whatsapp_message`, and `whatsapp_settings`.
- Update `backend/sql/schema.sql`.
- Add sqlc queries for chat upsert, message insert, classification update, settings get/update, pending notifications, and mark-notified.
- Regenerate sqlc code.
- Run backend tests.

Acceptance:

- `go test ./...` passes.
- Duplicate `(chat_jid, message_id)` inserts are idempotent.
- Default settings row can be read when no user edit exists.

### Checkpoint 2: WhatsMeow Client

- Add whatsmeow dependency.
- Add `internal/whatsapp` service.
- Use separate SQLite session DB.
- Start service automatically from backend startup.
- Handle QR, connected, disconnected, logged-out, and message events.
- Store incoming messages.

Acceptance:

- Backend starts with WhatsApp service enabled by default.
- First run exposes a QR code.
- Scanning QR pairs successfully.
- Incoming WhatsApp messages are inserted into Postgres.
- Backend shutdown stops WhatsApp service cleanly.

### Checkpoint 3: Admin Endpoints

- Add authenticated `/api/whatsapp/status`.
- Add authenticated `/api/whatsapp/qr`.
- Add authenticated `/api/whatsapp/reconnect`.
- Add authenticated `/api/whatsapp/logout`.
- Add authenticated settings get/update endpoints.

Acceptance:

- Native app can read pairing status and QR payload.
- Reconnect/logout work without restarting backend.
- Settings updates persist.

### Checkpoint 4: LLM Classification

- Add classifier using existing backend AI config.
- Load latest importance instructions for each classification.
- Store important/not-important result and reason.
- Store classifier errors without dropping messages.
- Avoid duplicate classification work on duplicate events.

Acceptance:

- Text messages get classified.
- Unsupported/no-text messages are safely marked not important.
- LLM failures mark `classification_status = 'error'`.
- Important messages become eligible for notification.

### Checkpoint 5: Native Settings UI

- Add WhatsApp settings section.
- Show status and QR pairing info.
- Add importance instructions textarea.
- Add save/reconnect/logout actions.

Acceptance:

- User can pair WhatsApp from native settings.
- User can edit/save classifier instructions.
- Backend uses edited instructions for later messages.

### Checkpoint 6: Native Notifications

- Add polling for pending important WhatsApp messages.
- Create OS notifications from native app.
- Mark messages notified after success.

Acceptance:

- Important incoming message creates a native notification.
- Not-important incoming message does not create a notification.
- Restarting native app does not duplicate already marked notifications.

### Checkpoint 7: End-to-End Test

- Pair WhatsApp.
- Send one obviously unimportant message.
- Send one obviously important message.
- Confirm both are stored.
- Confirm classifier labels differ correctly.
- Confirm only important message creates native notification.

Acceptance:

- End-to-end flow works without backend restart after pairing.
- No duplicate rows or duplicate notifications for repeated delivery events.

## Verification Commands

Backend:

```bash
cd backend
go test ./...
```

Native:

```bash
cd native
bun run typecheck
```

## Restart Note

Backend Go changes require rebuilding/restarting the Go server before WhatsApp ingest is live.
