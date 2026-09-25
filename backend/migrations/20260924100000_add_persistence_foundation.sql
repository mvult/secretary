-- Additive foundation only. Deploy the complete revision-aware writer service
-- before advertising persistence protocol v1 or accepting versioned requests.
ALTER TABLE "public"."document"
  ADD COLUMN "client_key" text,
  ADD COLUMN "revision" bigint NOT NULL DEFAULT 1;
UPDATE "public"."document" SET client_key = 'document-' || id::text;
ALTER TABLE "public"."document"
  ALTER COLUMN client_key SET DEFAULT gen_random_uuid()::text,
  ALTER COLUMN client_key SET NOT NULL,
  ADD CONSTRAINT "document_client_key_check" CHECK (btrim(client_key) <> ''),
  ADD CONSTRAINT "document_revision_check" CHECK (revision > 0),
  ADD CONSTRAINT "document_workspace_client_key_key" UNIQUE (workspace_id, client_key);

ALTER TABLE "public"."block" ADD COLUMN "client_key" text;
UPDATE "public"."block" SET client_key = 'block-' || id::text;
ALTER TABLE "public"."block"
  ALTER COLUMN client_key SET DEFAULT gen_random_uuid()::text,
  ALTER COLUMN client_key SET NOT NULL,
  ADD CONSTRAINT "block_client_key_check" CHECK (btrim(client_key) <> ''),
  ADD CONSTRAINT "block_document_client_key_key" UNIQUE (document_id, client_key);

-- No cascading resource references or receipt TTL. Actor deletion is restricted
-- until user lifecycle cleanup has an explicit receipt-retention policy.
CREATE TABLE "public"."mutation_receipt" (
  "actor_user_id" integer NOT NULL,
  "scope_kind" text NOT NULL,
  "scope_id" integer NOT NULL,
  "mutation_id" uuid NOT NULL,
  "protocol_version" integer NOT NULL,
  "operation" text NOT NULL,
  "payload_sha256" bytea NOT NULL,
  "target_ids" bigint[] NOT NULL DEFAULT '{}',
  "creation_key" text NULL,
  "result_type" text NOT NULL,
  "result_version" integer NOT NULL,
  "result_payload" bytea NOT NULL,
  "committed_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_user_id, scope_kind, scope_id, mutation_id),
  CONSTRAINT "mutation_receipt_actor_fk" FOREIGN KEY (actor_user_id) REFERENCES "public"."user" (id) ON DELETE RESTRICT,
  CONSTRAINT "mutation_receipt_scope_check" CHECK (scope_kind IN ('workspace', 'user') AND scope_id > 0 AND (scope_kind <> 'user' OR scope_id = actor_user_id)),
  CONSTRAINT "mutation_receipt_protocol_check" CHECK (protocol_version > 0),
  CONSTRAINT "mutation_receipt_operation_check" CHECK (btrim(operation) <> ''),
  CONSTRAINT "mutation_receipt_hash_check" CHECK (octet_length(payload_sha256) = 32),
  CONSTRAINT "mutation_receipt_creation_key_check" CHECK (creation_key IS NULL OR (scope_kind = 'workspace' AND operation = 'document.save' AND btrim(creation_key) <> '')),
  CONSTRAINT "mutation_receipt_result_check" CHECK (btrim(result_type) <> '' AND result_version > 0 AND octet_length(result_payload) > 0)
);
CREATE UNIQUE INDEX "mutation_receipt_creation_key_idx" ON "public"."mutation_receipt" (scope_id, creation_key) WHERE creation_key IS NOT NULL;
