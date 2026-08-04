CREATE TABLE "public"."todo_goal" (
  "id" integer NOT NULL GENERATED ALWAYS AS IDENTITY,
  "user_id" integer NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "todo_goal_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "todo_goal_name_check" CHECK (btrim("name") <> ''::text)
);

ALTER TABLE "public"."todo"
  ADD COLUMN "bucket" text NULL,
  ADD COLUMN "priority_rank" integer NULL,
  ADD COLUMN "deadline_date" date NULL,
  ADD COLUMN "goal_id" integer NULL,
  ADD COLUMN "current_document_id" integer NULL,
  ADD COLUMN "current_block_id" integer NULL,
  ADD COLUMN "completed_at" timestamptz NULL,
  ADD COLUMN "completed_document_id" integer NULL,
  ADD COLUMN "completed_block_id" integer NULL,
  ADD CONSTRAINT "todo_bucket_check" CHECK ("bucket" IS NULL OR "bucket" = ANY (ARRAY['inbox'::text, 'on_deck'::text, 'blocked'::text, 'done'::text])),
  ADD CONSTRAINT "todo_goal_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."todo_goal" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  ADD CONSTRAINT "todo_current_document_fk" FOREIGN KEY ("current_document_id") REFERENCES "public"."document" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  ADD CONSTRAINT "todo_current_block_fk" FOREIGN KEY ("current_block_id") REFERENCES "public"."block" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  ADD CONSTRAINT "todo_completed_document_fk" FOREIGN KEY ("completed_document_id") REFERENCES "public"."document" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  ADD CONSTRAINT "todo_completed_block_fk" FOREIGN KEY ("completed_block_id") REFERENCES "public"."block" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

UPDATE "public"."todo" t
SET
  "current_document_id" = b."document_id",
  "current_block_id" = b."id",
  "completed_at" = CASE WHEN t."status" = 'done' THEN t."updated_at" ELSE NULL END,
  "completed_document_id" = CASE WHEN t."status" = 'done' THEN b."document_id" ELSE NULL END,
  "completed_block_id" = CASE WHEN t."status" = 'done' THEN b."id" ELSE NULL END,
  "bucket" = CASE
    WHEN t."status" = 'done' THEN 'done'
    WHEN t."status" = 'blocked' THEN 'blocked'
    ELSE NULL
  END
FROM "public"."block" b
WHERE b."todo_id" = t."id";

UPDATE "public"."todo"
SET
  "completed_at" = COALESCE("completed_at", "updated_at"),
  "bucket" = COALESCE("bucket", 'done')
WHERE "status" = 'done';

UPDATE "public"."todo"
SET "bucket" = 'blocked'
WHERE "status" = 'blocked' AND "bucket" IS NULL;

CREATE INDEX "todo_goal_user_idx" ON "public"."todo_goal" ("user_id", "name");
CREATE UNIQUE INDEX "todo_current_block_idx" ON "public"."todo" ("current_block_id") WHERE (current_block_id IS NOT NULL);
CREATE INDEX "todo_goal_idx" ON "public"."todo" ("goal_id");
CREATE INDEX "todo_user_bucket_priority_idx" ON "public"."todo" ("user_id", "bucket", "priority_rank", "deadline_date", "id");
