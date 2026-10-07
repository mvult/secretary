-- name: BeginAudioUpload :exec
INSERT INTO recording_audio_upload (id, user_id, request_recording_id, name, duration, size_bytes, content_type, object_key)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING;

-- name: GetAudioUpload :one
SELECT * FROM recording_audio_upload WHERE id=$1 AND user_id=$2;

-- name: LockAudioUpload :one
SELECT * FROM recording_audio_upload WHERE id=$1 AND user_id=$2 FOR UPDATE;

-- name: CompleteAudioUpload :exec
UPDATE recording_audio_upload SET recording_id=$2, state='complete' WHERE id=$1;

-- name: CreateAudioRecording :one
INSERT INTO recording (name, duration, audio_object_key, created_at, archived)
VALUES ($1,$2,$3,now(),false) RETURNING id;

-- name: AttachRecordingAudio :one
UPDATE recording SET audio_object_key=$2 WHERE id=$1 AND audio_object_key IS NULL AND COALESCE(audio_url,'')='' RETURNING id;

-- name: LockRecordingAudio :one
SELECT id, audio_object_key, audio_url FROM recording WHERE id=$1 FOR UPDATE;

-- name: ClearRecordingAudio :exec
UPDATE recording SET audio_object_key=NULL WHERE id=$1;

-- name: RetireRecordingAudioUploads :exec
UPDATE recording_audio_upload SET state='deleted' WHERE recording_id=$1 OR request_recording_id=$1;
