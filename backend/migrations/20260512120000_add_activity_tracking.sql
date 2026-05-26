-- Create "activity_type" table
CREATE TABLE "public"."activity_type" (
  "id" integer NOT NULL GENERATED ALWAYS AS IDENTITY,
  "user_id" integer NOT NULL,
  "key" text NOT NULL,
  "name" text NOT NULL,
  "unit" text NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "activity_type_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "activity_type_user_key_key" UNIQUE ("user_id", "key"),
  CONSTRAINT "activity_type_key_check" CHECK (btrim("key") <> ''::text),
  CONSTRAINT "activity_type_name_check" CHECK (btrim("name") <> ''::text)
);

-- Create "activity_entry" table
CREATE TABLE "public"."activity_entry" (
  "id" bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
  "activity_type_id" integer NOT NULL,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "value" double precision NULL,
  "note" text NULL,
  "data" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "activity_entry_type_fk" FOREIGN KEY ("activity_type_id") REFERENCES "public"."activity_type" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);

-- Create indexes.
CREATE INDEX "activity_entry_type_time_idx" ON "public"."activity_entry" ("activity_type_id", "occurred_at" DESC, "id" DESC);
CREATE INDEX "activity_type_user_idx" ON "public"."activity_type" ("user_id", "key");
