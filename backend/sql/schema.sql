-- Add new schema named "public"
CREATE SCHEMA IF NOT EXISTS "public";
-- Set comment to schema: "public"
COMMENT ON SCHEMA "public" IS 'standard public schema';
-- Create "topic" table
CREATE TABLE "public"."topic" (
  "id" integer NOT NULL GENERATED ALWAYS AS IDENTITY,
  "name" text NOT NULL,
  "desc" text NULL,
  "created_at" timestamptz NULL,
  PRIMARY KEY ("id")
);
-- Create enum type "relation_kind"
CREATE TYPE "public"."relation_kind" AS ENUM ('support', 'attack');
-- Create enum type "issue_status"
CREATE TYPE "public"."issue_status" AS ENUM ('open', 'answered', 'stale');
-- Create enum type "argument_acceptance"
CREATE TYPE "public"."argument_acceptance" AS ENUM ('accepted', 'contested', 'rejected', '');
-- Create enum type "argument_type"
CREATE TYPE "public"."argument_type" AS ENUM ('belief', 'hypothesis', 'evidence', 'decision', 'question', 'principle');
-- Create "argument" table
CREATE TABLE "public"."argument" (
  "id" integer NOT NULL GENERATED ALWAYS AS IDENTITY,
  "topic_id" integer NULL,
  "claim_text" text NOT NULL,
  "type" "public"."argument_type" NULL,
  "base_weight" numeric(4,3) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "topic_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topic" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "weight_range" CHECK ((base_weight >= 0.0) AND (base_weight <= 1.0))
);
-- Create "issue" table
CREATE TABLE "public"."issue" (
  "id" integer NOT NULL GENERATED ALWAYS AS IDENTITY,
  "topic_id" integer NOT NULL,
  "question" text NOT NULL,
  "status" "public"."issue_status" NOT NULL DEFAULT 'open',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "issue_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "public"."topic" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create "issue_position" table
CREATE TABLE "public"."issue_position" (
  "id" integer NOT NULL GENERATED ALWAYS AS IDENTITY,
  "issue_id" integer NOT NULL,
  "argument_id" integer NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "issue_position_issue_id_argument_id_key" UNIQUE ("issue_id", "argument_id"),
  CONSTRAINT "issue_position_argument_id_fkey" FOREIGN KEY ("argument_id") REFERENCES "public"."argument" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "issue_position_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "public"."issue" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create "qbaf_run" table
CREATE TABLE "public"."qbaf_run" (
  "id" integer NOT NULL GENERATED ALWAYS AS IDENTITY,
  "topic_id" integer NOT NULL,
  "method" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "qbaf_run_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "public"."topic" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create "qbaf_result" table
CREATE TABLE "public"."qbaf_result" (
  "run_id" integer NOT NULL,
  "argument_id" integer NOT NULL,
  "final_strength" numeric(4,3) NOT NULL,
  "status" "public"."argument_acceptance" NOT NULL,
  PRIMARY KEY ("run_id", "argument_id"),
  CONSTRAINT "qbaf_result_argument_id_fkey" FOREIGN KEY ("argument_id") REFERENCES "public"."argument" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "qbaf_result_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."qbaf_run" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "qbaf_result_final_strength_check" CHECK ((final_strength >= 0.0) AND (final_strength <= 1.0))
);
-- Create "relation" table
CREATE TABLE "public"."relation" (
  "id" integer NOT NULL GENERATED ALWAYS AS IDENTITY,
  "topic_id" integer NOT NULL,
  "src_id" integer NOT NULL,
  "dst_id" integer NOT NULL,
  "kind" "public"."relation_kind" NOT NULL,
  "weight" numeric(4,3) NOT NULL DEFAULT 1.0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "relation_topic_id_src_id_dst_id_kind_key" UNIQUE ("topic_id", "src_id", "dst_id", "kind"),
  CONSTRAINT "relation_dst_id_fkey" FOREIGN KEY ("dst_id") REFERENCES "public"."argument" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "relation_src_id_fkey" FOREIGN KEY ("src_id") REFERENCES "public"."argument" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "relation_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "public"."topic" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "no_self_loops" CHECK (src_id <> dst_id),
  CONSTRAINT "relation_weight_check" CHECK ((weight >= 0.0) AND (weight <= 1.0))
);
-- Create "user" table
CREATE TABLE "public"."user" (
  "id" integer NOT NULL GENERATED ALWAYS AS IDENTITY,
  "first_name" text NOT NULL,
  "last_name" text NULL,
  "role" text NULL,
  "email" text NULL,
  "password_hash" text NULL,
  PRIMARY KEY ("id")
);
-- Create "speaker_to_user" table
CREATE TABLE "public"."speaker_to_user" (
  "recording_id" integer NOT NULL,
  "speaker_id" integer NOT NULL,
  "user_id" integer NOT NULL,
  "words_spoken" integer,
  CONSTRAINT "constraint_1" PRIMARY KEY ("recording_id", "speaker_id", "user_id"),
  CONSTRAINT "user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create "recording" table
CREATE TABLE "public"."recording" (
  "id" integer NOT NULL GENERATED ALWAYS AS IDENTITY,
  "created_at" timestamptz NULL,
  "name" text NULL,
  "audio_url" text NULL,
  "transcript" text NULL,
  "summary" text NULL,
  "local_audio" text NULL,
  "nas_audio" text NULL,
  "duration" integer NULL,
  "notes" text NULL,
  "archived" boolean NULL,
  PRIMARY KEY ("id")
);
-- Create "todo" table
CREATE TABLE "public"."todo" (
  "id" integer NOT NULL GENERATED ALWAYS AS IDENTITY,
  "name" text NOT NULL,
  "desc" text NULL,
  "status" text NULL,
  "user_id" integer NULL,
  "created_at_recording_id" integer NULL,
  "updated_at_recording_id" integer NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "created_session_fk" FOREIGN KEY ("created_at_recording_id") REFERENCES "public"."recording" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "todo_user" FOREIGN KEY ("user_id") REFERENCES "public"."user" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "updated_at_recording_id" FOREIGN KEY ("updated_at_recording_id") REFERENCES "public"."recording" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create "todo_history" table
CREATE TABLE "public"."todo_history" (
  "id" bigserial NOT NULL,
  "todo_id" integer NOT NULL,
  "actor_user_id" integer NULL,
  "change_type" text NOT NULL,
  "name" text NULL,
  "desc" text NULL,
  "status" text NULL,
  "user_id" integer NULL,
  "created_at_recording_id" integer NULL,
  "updated_at_recording_id" integer NULL,
  "changed_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "todo_history_todo_fk" FOREIGN KEY ("todo_id") REFERENCES "public"."todo" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "todo_history_actor_user_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  CONSTRAINT "todo_history_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  CONSTRAINT "todo_history_created_at_recording_fk" FOREIGN KEY ("created_at_recording_id") REFERENCES "public"."recording" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  CONSTRAINT "todo_history_updated_at_recording_fk" FOREIGN KEY ("updated_at_recording_id") REFERENCES "public"."recording" ("id") ON UPDATE NO ACTION ON DELETE SET NULL
);
