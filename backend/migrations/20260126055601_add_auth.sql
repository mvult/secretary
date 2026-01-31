-- Modify "user" table
ALTER TABLE "public"."user" ADD COLUMN "email" text NULL, ADD COLUMN "password_hash" text NULL;
