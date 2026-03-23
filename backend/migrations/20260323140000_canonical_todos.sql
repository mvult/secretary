ALTER TABLE "public"."block"
  DROP CONSTRAINT IF EXISTS "block_status_check";

ALTER TABLE "public"."block"
  ADD CONSTRAINT "block_status_check" CHECK (status = ANY (ARRAY['note'::text, 'todo'::text, 'doing'::text, 'done'::text, 'blocked'::text, 'skipped'::text]));

ALTER TABLE "public"."todo"
  ADD COLUMN IF NOT EXISTS "workspace_id" integer NULL,
  ADD COLUMN IF NOT EXISTS "source_kind" text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS "source_document_id" integer NULL,
  ADD COLUMN IF NOT EXISTS "source_block_id" integer NULL,
  ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();

UPDATE "public"."todo"
SET "source_kind" = CASE
  WHEN "source_kind" <> '' THEN "source_kind"
  WHEN "created_at_recording_id" IS NOT NULL THEN 'recording'
  ELSE 'manual'
END;

ALTER TABLE "public"."todo"
  ADD CONSTRAINT "todo_source_document_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."document" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  ADD CONSTRAINT "todo_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  ADD CONSTRAINT "todo_source_kind_check" CHECK (source_kind = ANY (ARRAY['manual'::text, 'block'::text, 'recording'::text, 'llm'::text]));

CREATE UNIQUE INDEX "todo_source_block_idx" ON "public"."todo" ("source_block_id") WHERE ("source_block_id" IS NOT NULL);
CREATE INDEX "todo_workspace_idx" ON "public"."todo" ("workspace_id");
