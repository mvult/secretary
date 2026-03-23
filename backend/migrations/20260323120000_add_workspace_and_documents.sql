-- Create "workspace" table
CREATE TABLE "public"."workspace" (
  "id" integer NOT NULL GENERATED ALWAYS AS IDENTITY,
  "name" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);
-- Create "workspace_user_rel" table
CREATE TABLE "public"."workspace_user_rel" (
  "workspace_id" integer NOT NULL,
  "user_id" integer NOT NULL,
  "role" text NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id", "user_id"),
  CONSTRAINT "workspace_user_rel_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "workspace_user_rel_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create "document" table
CREATE TABLE "public"."document" (
  "id" integer NOT NULL GENERATED ALWAYS AS IDENTITY,
  "workspace_id" integer NOT NULL,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "journal_date" date NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "document_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "document_kind_check" CHECK (kind = ANY (ARRAY['journal'::text, 'note'::text])),
  CONSTRAINT "document_kind_date_check" CHECK (((kind = 'journal'::text) AND (journal_date IS NOT NULL)) OR ((kind = 'note'::text) AND (journal_date IS NULL))),
  CONSTRAINT "document_workspace_journal_date_key" UNIQUE ("workspace_id", "journal_date")
);
