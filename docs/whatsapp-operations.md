# WhatsApp operations

## Pairing and persistence

In Dokploy, mount a named volume at `/data/whatsapp` and set
`WHATSAPP_SESSION_DB=/data/whatsapp/session.db`. Preserve the whole directory,
including SQLite companion files. Pairing credentials are stored there;
messages, classifications, and notification acknowledgments are in Postgres.

Point native Settings at this backend, log in, and choose **Generate QR**.
Scan using WhatsApp's **Linked devices → Link a device**. Restart the backend
and confirm it reconnects without scanning again. A shared Postgres database
does not transfer pairing credentials between backends.

## Message triage

Set `OPENROUTER_API_KEY` on the backend for incoming-message classification.
`MESSAGE_TRIAGE_MODEL` selects the OpenRouter model and defaults to
`~openai/gpt-luna-latest` when unset or blank. Triage requests go to
`https://openrouter.ai/api/v1/chat/completions`. Configure these before deploying;
messages already marked as classification errors do not automatically retry.

## Staying current

- The backend checks Go's module proxy for a newer WhatsMeow version at startup
  and every 24 hours, with a ten-second deadline. It compares release/commit times
  against the dependency embedded in the running binary. Failed checks are logged
  and retain the last successful result. Local module replacements are not checked.
- Native reads the connected backend's cached result once a minute and shows a
  desktop notification once per backend/version, recorded in local storage. Native
  must be running and notification permission granted. A remote backend's result
  is visible only while connected to that backend; it is not shared via Postgres.
- No automatic code updates, version overrides, PRs, or forced reconnects occur.
  Connections use the installed WhatsMeow library's bundled WhatsApp Web version.
- To update manually, run `go get go.mau.fi/whatsmeow@latest` and `go mod tidy`
  in `backend/`. Check any new minimum Go version against both Go build stages
  in the root Dockerfile. Run `go test -race ./internal/whatsapp` and
  `go build ./...`, then rebuild/redeploy the backend.
- If `qr: err-client-outdated` persists, update WhatsMeow and confirm the latest
  backend build is deployed. Do not delete the session volume.

After deploying an update, verify real phone pairing and a received message;
unit tests cannot establish WhatsApp server compatibility.
