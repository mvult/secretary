-- name: UpsertWhatsAppChat :one
INSERT INTO whatsapp_chat (
  jid,
  name,
  is_group
) VALUES (
  $1, $2, $3
)
ON CONFLICT (jid) DO UPDATE SET
  name = COALESCE(EXCLUDED.name, whatsapp_chat.name),
  is_group = EXCLUDED.is_group,
  updated_at = now()
RETURNING id, jid, name, is_group, created_at, updated_at;

-- name: InsertWhatsAppMessage :one
INSERT INTO whatsapp_message (
  chat_jid,
  message_id,
  sender_jid,
  sender_name,
  is_from_me,
  sent_at,
  message_type,
  text,
  raw_json,
  classification_status,
  classification_important,
  classification_reason,
  classified_at
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9,
  CASE WHEN $5 OR COALESCE(btrim($8), '') = '' THEN 'classified' ELSE 'pending' END,
  CASE WHEN $5 OR COALESCE(btrim($8), '') = '' THEN false ELSE NULL END,
  CASE
    WHEN $5 THEN 'Outgoing message'
    WHEN COALESCE(btrim($8), '') = '' THEN 'No text content to classify'
    ELSE NULL
  END,
  CASE WHEN $5 OR COALESCE(btrim($8), '') = '' THEN now() ELSE NULL END
)
ON CONFLICT (chat_jid, message_id) DO NOTHING
RETURNING id, chat_jid, message_id, sender_jid, sender_name, is_from_me, sent_at, received_at, message_type, text, raw_json, classification_status, classification_important, classification_reason, classification_model, classification_error, classified_at, notified_at, created_at;

-- name: GetWhatsAppMessage :one
SELECT id, chat_jid, message_id, sender_jid, sender_name, is_from_me, sent_at, received_at, message_type, text, raw_json, classification_status, classification_important, classification_reason, classification_model, classification_error, classified_at, notified_at, created_at
FROM whatsapp_message
WHERE id = $1;

-- name: ListPendingWhatsAppClassifications :many
SELECT id, chat_jid, message_id, sender_jid, sender_name, is_from_me, sent_at, received_at, message_type, text, raw_json, classification_status, classification_important, classification_reason, classification_model, classification_error, classified_at, notified_at, created_at
FROM whatsapp_message
WHERE classification_status = 'pending'
  AND COALESCE(btrim(text), '') <> ''
ORDER BY received_at ASC, id ASC
LIMIT $1;

-- name: UpdateWhatsAppMessageClassification :one
UPDATE whatsapp_message
SET
  classification_status = $2,
  classification_important = $3,
  classification_reason = $4,
  classification_model = $5,
  classification_error = $6,
  classified_at = now()
WHERE id = $1
RETURNING id, chat_jid, message_id, sender_jid, sender_name, is_from_me, sent_at, received_at, message_type, text, raw_json, classification_status, classification_important, classification_reason, classification_model, classification_error, classified_at, notified_at, created_at;

-- name: GetWhatsAppSettings :one
SELECT id, importance_instructions, updated_at
FROM whatsapp_settings
WHERE id = true;

-- name: UpsertWhatsAppSettings :one
INSERT INTO whatsapp_settings (
  id,
  importance_instructions
) VALUES (
  true, $1
)
ON CONFLICT (id) DO UPDATE SET
  importance_instructions = EXCLUDED.importance_instructions,
  updated_at = now()
RETURNING id, importance_instructions, updated_at;

-- name: ListPendingWhatsAppNotifications :many
SELECT id, chat_jid, message_id, sender_jid, sender_name, is_from_me, sent_at, received_at, message_type, text, raw_json, classification_status, classification_important, classification_reason, classification_model, classification_error, classified_at, notified_at, created_at
FROM whatsapp_message
WHERE classification_status = 'classified'
  AND classification_important = true
  AND notified_at IS NULL
ORDER BY received_at ASC, id ASC
LIMIT $1;

-- name: MarkWhatsAppMessagesNotified :many
UPDATE whatsapp_message
SET notified_at = now()
WHERE id = ANY($1::bigint[])
RETURNING id, chat_jid, message_id, sender_jid, sender_name, is_from_me, sent_at, received_at, message_type, text, raw_json, classification_status, classification_important, classification_reason, classification_model, classification_error, classified_at, notified_at, created_at;
