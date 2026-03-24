ALTER TABLE "public"."block"
  DROP CONSTRAINT IF EXISTS "block_status_check";

ALTER TABLE "public"."block"
  DROP COLUMN IF EXISTS "status";
