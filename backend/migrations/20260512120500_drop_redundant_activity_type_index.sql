-- The unique constraint on (user_id, key) already creates the lookup index.
DROP INDEX "public"."activity_type_user_idx";
