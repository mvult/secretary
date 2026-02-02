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

-- name: ListRecordingParticipants :many
SELECT
  u.id,
  u.first_name,
  u.last_name,
  u.role,
  stu.speaker_id
FROM speaker_to_user stu
JOIN "user" u ON u.id = stu.user_id
WHERE stu.recording_id = $1;

-- name: DeleteRecording :exec
DELETE FROM recording
WHERE id = $1;
