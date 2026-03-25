-- Create "block_document_link" table
CREATE TABLE "public"."block_document_link" (
  "block_id" integer NOT NULL,
  "target_document_id" integer NOT NULL,
  PRIMARY KEY ("block_id", "target_document_id"),
  CONSTRAINT "block_document_link_block_fk" FOREIGN KEY ("block_id") REFERENCES "public"."block" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "block_document_link_target_document_fk" FOREIGN KEY ("target_document_id") REFERENCES "public"."document" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "block_document_link_target_document_idx" to table: "block_document_link"
CREATE INDEX "block_document_link_target_document_idx" ON "public"."block_document_link" ("target_document_id");
