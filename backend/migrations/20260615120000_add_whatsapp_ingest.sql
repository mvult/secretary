CREATE TABLE "public"."whatsapp_chat" (
  "id" bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
  "jid" text NOT NULL,
  "name" text NULL,
  "is_group" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "whatsapp_chat_jid_key" UNIQUE ("jid"),
  CONSTRAINT "whatsapp_chat_jid_check" CHECK (btrim("jid") <> ''::text)
);

CREATE TABLE "public"."whatsapp_message" (
  "id" bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
  "chat_jid" text NOT NULL,
  "message_id" text NOT NULL,
  "sender_jid" text NULL,
  "sender_name" text NULL,
  "is_from_me" boolean NOT NULL DEFAULT false,
  "sent_at" timestamptz NULL,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "message_type" text NOT NULL,
  "text" text NULL,
  "raw_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "classification_status" text NOT NULL DEFAULT 'pending',
  "classification_important" boolean NULL,
  "classification_reason" text NULL,
  "classification_model" text NULL,
  "classification_error" text NULL,
  "classified_at" timestamptz NULL,
  "notified_at" timestamptz NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "whatsapp_message_chat_fk" FOREIGN KEY ("chat_jid") REFERENCES "public"."whatsapp_chat" ("jid") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "whatsapp_message_chat_message_key" UNIQUE ("chat_jid", "message_id"),
  CONSTRAINT "whatsapp_message_chat_jid_check" CHECK (btrim("chat_jid") <> ''::text),
  CONSTRAINT "whatsapp_message_id_check" CHECK (btrim("message_id") <> ''::text),
  CONSTRAINT "whatsapp_message_type_check" CHECK (btrim("message_type") <> ''::text),
  CONSTRAINT "whatsapp_message_classification_status_check" CHECK ("classification_status" = ANY (ARRAY['pending'::text, 'classified'::text, 'error'::text]))
);

CREATE INDEX "whatsapp_message_status_received_idx" ON "public"."whatsapp_message" ("classification_status", "received_at");
CREATE INDEX "whatsapp_message_important_received_idx" ON "public"."whatsapp_message" ("classification_important", "received_at" DESC);
CREATE INDEX "whatsapp_message_chat_sent_idx" ON "public"."whatsapp_message" ("chat_jid", "sent_at" DESC, "id" DESC);

CREATE TABLE "public"."whatsapp_settings" (
  "id" boolean NOT NULL DEFAULT true,
  "importance_instructions" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "whatsapp_settings_singleton_check" CHECK ("id" = true),
  CONSTRAINT "whatsapp_settings_instructions_check" CHECK (btrim("importance_instructions") <> ''::text)
);
