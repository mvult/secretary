-- Create ai_thread table
CREATE TABLE "public"."ai_thread" (
  "id" bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
  "workspace_id" integer NOT NULL,
  "document_id" integer NULL,
  "title" text NULL,
  "created_by_user_id" integer NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "ai_thread_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "ai_thread_document_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  CONSTRAINT "ai_thread_created_by_user_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  CONSTRAINT "ai_thread_title_check" CHECK ("title" IS NULL OR btrim("title") <> ''::text)
);

-- Create ai_message table
CREATE TABLE "public"."ai_message" (
  "id" bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
  "thread_id" bigint NOT NULL,
  "role" text NOT NULL,
  "content" text NOT NULL,
  "created_by_user_id" integer NULL,
  "run_id" bigint NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "ai_message_thread_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."ai_thread" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "ai_message_created_by_user_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  CONSTRAINT "ai_message_role_check" CHECK ("role" = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text])),
  CONSTRAINT "ai_message_content_check" CHECK (btrim("content") <> ''::text)
);

-- Create ai_run table
CREATE TABLE "public"."ai_run" (
  "id" bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
  "trigger_message_id" bigint NULL,
  "status" text NOT NULL,
  "mode" text NOT NULL,
  "provider" text NULL,
  "model" text NULL,
  "request_json" jsonb NULL,
  "response_json" jsonb NULL,
  "input_tokens" integer NULL,
  "output_tokens" integer NULL,
  "latency_ms" integer NULL,
  "error_message" text NULL,
  "started_at" timestamptz NULL,
  "completed_at" timestamptz NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "ai_run_trigger_message_fk" FOREIGN KEY ("trigger_message_id") REFERENCES "public"."ai_message" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  CONSTRAINT "ai_run_status_check" CHECK ("status" = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])),
  CONSTRAINT "ai_run_mode_check" CHECK ("mode" = ANY (ARRAY['ask'::text, 'draft'::text, 'edit'::text, 'todo_assist'::text])),
  CONSTRAINT "ai_run_input_tokens_check" CHECK ("input_tokens" IS NULL OR "input_tokens" >= 0),
  CONSTRAINT "ai_run_output_tokens_check" CHECK ("output_tokens" IS NULL OR "output_tokens" >= 0),
  CONSTRAINT "ai_run_latency_ms_check" CHECK ("latency_ms" IS NULL OR "latency_ms" >= 0)
);

ALTER TABLE "public"."ai_message"
  ADD CONSTRAINT "ai_message_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_run" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

-- Create ai_artifact table
CREATE TABLE "public"."ai_artifact" (
  "id" bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
  "run_id" bigint NOT NULL,
  "kind" text NOT NULL,
  "title" text NULL,
  "content_json" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "applied_at" timestamptz NULL,
  "applied_by_user_id" integer NULL,
  "superseded_by_artifact_id" bigint NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "ai_artifact_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_run" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "ai_artifact_applied_by_user_fk" FOREIGN KEY ("applied_by_user_id") REFERENCES "public"."user" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  CONSTRAINT "ai_artifact_superseded_by_fk" FOREIGN KEY ("superseded_by_artifact_id") REFERENCES "public"."ai_artifact" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  CONSTRAINT "ai_artifact_kind_check" CHECK ("kind" = ANY (ARRAY['draft'::text, 'patch'::text, 'retrieval_manifest'::text, 'summary'::text, 'todo_proposal'::text]))
);

-- Create ai_source_ref table
CREATE TABLE "public"."ai_source_ref" (
  "id" bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
  "run_id" bigint NULL,
  "artifact_id" bigint NULL,
  "source_kind" text NOT NULL,
  "source_id" integer NOT NULL,
  "label" text NULL,
  "quote_text" text NULL,
  "rank" integer NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "ai_source_ref_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_run" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "ai_source_ref_artifact_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."ai_artifact" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "ai_source_ref_source_kind_check" CHECK ("source_kind" = ANY (ARRAY['document'::text, 'block'::text, 'todo'::text, 'recording'::text])),
  CONSTRAINT "ai_source_ref_owner_check" CHECK ((("run_id" IS NOT NULL) AND ("artifact_id" IS NULL)) OR (("run_id" IS NULL) AND ("artifact_id" IS NOT NULL))),
  CONSTRAINT "ai_source_ref_rank_check" CHECK ("rank" IS NULL OR "rank" >= 0)
);

CREATE INDEX "ai_artifact_run_idx" ON "public"."ai_artifact" ("run_id", "created_at", "id");
CREATE INDEX "ai_message_thread_idx" ON "public"."ai_message" ("thread_id", "created_at", "id");
CREATE INDEX "ai_run_trigger_message_idx" ON "public"."ai_run" ("trigger_message_id", "created_at", "id");
CREATE INDEX "ai_source_ref_artifact_idx" ON "public"."ai_source_ref" ("artifact_id", "rank", "id");
CREATE INDEX "ai_source_ref_run_idx" ON "public"."ai_source_ref" ("run_id", "rank", "id");
CREATE INDEX "ai_source_ref_source_idx" ON "public"."ai_source_ref" ("source_kind", "source_id");
CREATE INDEX "ai_thread_workspace_updated_idx" ON "public"."ai_thread" ("workspace_id", "updated_at" DESC, "id" DESC);
