-- Create "block" table
CREATE TABLE "public"."block" (
  "id" integer NOT NULL GENERATED ALWAYS AS IDENTITY,
  "document_id" integer NOT NULL,
  "parent_block_id" integer NULL,
  "sort_order" integer NOT NULL,
  "text" text NOT NULL,
  "status" text NOT NULL DEFAULT 'note',
  "todo_id" integer NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "block_document_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "block_parent_fk" FOREIGN KEY ("parent_block_id") REFERENCES "public"."block" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "block_status_check" CHECK (status = ANY (ARRAY['note'::text, 'todo'::text, 'doing'::text, 'done'::text]))
);
-- Modify "block" table
ALTER TABLE "public"."block" ADD CONSTRAINT "block_todo_fk" FOREIGN KEY ("todo_id") REFERENCES "public"."todo" ("id") ON UPDATE NO ACTION ON DELETE SET NULL, ADD CONSTRAINT "block_document_parent_sort_key" UNIQUE ("document_id", "parent_block_id", "sort_order");
-- Create index "block_document_idx" to table: "block"
CREATE INDEX "block_document_idx" ON "public"."block" ("document_id");
-- Create index "block_parent_idx" to table: "block"
CREATE INDEX "block_parent_idx" ON "public"."block" ("parent_block_id");
-- Create index "block_todo_idx" to table: "block"
CREATE INDEX "block_todo_idx" ON "public"."block" ("todo_id");
