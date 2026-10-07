-- +goose Up
ALTER TABLE recording ADD COLUMN audio_object_key text;
CREATE UNIQUE INDEX recording_audio_object_key ON recording(audio_object_key) WHERE audio_object_key IS NOT NULL;
CREATE TABLE recording_audio_upload (
    id uuid PRIMARY KEY,
    user_id integer NOT NULL REFERENCES "user"(id),
    request_recording_id integer NOT NULL DEFAULT 0,
    name text NOT NULL,
    duration integer NOT NULL CHECK (duration >= 0),
    size_bytes bigint NOT NULL CHECK (size_bytes > 0),
    content_type text NOT NULL,
    object_key text NOT NULL UNIQUE,
    recording_id integer,
    state text NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading', 'complete', 'deleted')),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Recording audio storage rollback would discard object references and retry receipts'; END $$;
-- +goose StatementEnd
