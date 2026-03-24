CREATE TABLE "public"."directory" (
  "id" integer NOT NULL GENERATED ALWAYS AS IDENTITY,
  "workspace_id" integer NOT NULL,
  "parent_id" integer NULL,
  "name" text NOT NULL,
  "position" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "directory_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."directory" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT "directory_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "directory_name_check" CHECK (btrim(name) <> ''::text)
);

CREATE INDEX "directory_parent_idx" ON "public"."directory" ("parent_id");
CREATE INDEX "directory_workspace_idx" ON "public"."directory" ("workspace_id");

ALTER TABLE "public"."document"
  ADD COLUMN "directory_id" integer NULL,
  ADD CONSTRAINT "document_directory_fk" FOREIGN KEY ("directory_id") REFERENCES "public"."directory" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  ADD CONSTRAINT "document_kind_directory_check" CHECK (((kind = 'journal'::text) AND (directory_id IS NULL)) OR (kind = 'note'::text));

CREATE INDEX "document_directory_idx" ON "public"."document" ("directory_id");
