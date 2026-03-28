-- Create document_history table for lightweight note snapshots.
CREATE TABLE "public"."document_history" (
  "id" bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
  "document_id" integer NOT NULL,
  "capture_reason" text NOT NULL,
  "content_hash" text NOT NULL,
  "snapshot_json" jsonb NOT NULL,
  "captured_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "document_history_document_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "document_history_reason_check" CHECK ("capture_reason" = ANY (ARRAY['day_start'::text, 'periodic'::text]))
);

CREATE INDEX "document_history_document_captured_idx" ON "public"."document_history" ("document_id", "captured_at" DESC, "id" DESC);
CREATE INDEX "document_history_document_hash_idx" ON "public"."document_history" ("document_id", "content_hash");
