-- name: ListRecordings :many
SELECT
  r.id,
  r.created_at,
  r.name,
  r.audio_url,
  r.transcript,
  r.summary,
  r.local_audio,
  r.nas_audio,
  r.duration,
  r.notes,
  r.archived
FROM recording r
ORDER BY r.created_at DESC;

-- name: GetRecording :one
SELECT
  r.id,
  r.created_at,
  r.name,
  r.audio_url,
  r.transcript,
  r.summary,
  r.local_audio,
  r.nas_audio,
  r.duration,
  r.notes,
  r.archived
FROM recording r
WHERE r.id = $1;
