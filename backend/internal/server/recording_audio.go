package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/mvult/secretary/backend/internal/db/gen"
)

type audioUploadRequest struct {
	ID          string `json:"id"`
	RecordingID int32  `json:"recording_id"`
	Name        string `json:"name"`
	Duration    int32  `json:"duration"`
	Size        int64  `json:"size_bytes"`
	ContentType string `json:"content_type"`
}
type audioHTTPError struct {
	status  int
	message string
}

func (e audioHTTPError) Error() string { return e.message }
func audioError(w http.ResponseWriter, err error) {
	var e audioHTTPError
	if errors.As(err, &e) {
		writeError(w, e.status, e.message)
	} else if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 404, "recording or upload not found")
	} else {
		writeError(w, 503, "audio storage unavailable; retry with the same upload ID")
	}
}

func (r audioUploadRequest) params(userID int64) (db.BeginAudioUploadParams, error) {
	id, err := uuid.Parse(r.ID)
	suffix := map[string]string{"audio/mp4": ".m4a", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/flac": ".flac", "audio/ogg": ".ogg"}[r.ContentType]
	if err != nil || id == uuid.Nil || r.RecordingID < 0 || strings.TrimSpace(r.Name) == "" || len(r.Name) > 500 || r.Duration < 0 || r.Size <= 0 || r.Size > 2*1024*1024*1024 || suffix == "" {
		return db.BeginAudioUploadParams{}, audioHTTPError{400, "valid UUID, name, duration, audio type and size (maximum 2 GiB) required"}
	}
	return db.BeginAudioUploadParams{ID: pgtype.UUID{Bytes: id, Valid: true}, UserID: int32(userID), RequestRecordingID: r.RecordingID,
		Name: r.Name, Duration: r.Duration, SizeBytes: r.Size, ContentType: r.ContentType, ObjectKey: "recordings/" + id.String() + suffix}, nil
}
func sameAudioUpload(row db.RecordingAudioUpload, p db.BeginAudioUploadParams) bool {
	return row.UserID == p.UserID && row.RequestRecordingID == p.RequestRecordingID && row.Name == p.Name && row.Duration == p.Duration && row.SizeBytes == p.SizeBytes && row.ContentType == p.ContentType && row.ObjectKey == p.ObjectKey
}

func (s *Server) handleBeginAudioUpload(w http.ResponseWriter, r *http.Request) {
	if s.audio == nil {
		writeError(w, 503, "B2 storage is not configured")
		return
	}
	var req audioUploadRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, 400, "invalid upload request")
		return
	}
	actor, err := requireUserID(r.Context())
	if err != nil {
		writeError(w, 401, "unauthenticated")
		return
	}
	p, err := req.params(actor)
	if err != nil {
		audioError(w, err)
		return
	}
	// Registration itself is durable and repeatable. The upload ID binds immutable metadata.
	if p.RequestRecordingID != 0 {
		if _, err = s.queries.GetRecording(r.Context(), p.RequestRecordingID); err != nil {
			audioError(w, err)
			return
		}
	}
	if err = s.queries.BeginAudioUpload(r.Context(), p); err != nil {
		audioError(w, err)
		return
	}
	row, err := s.queries.GetAudioUpload(r.Context(), db.GetAudioUploadParams{ID: p.ID, UserID: p.UserID})
	if err != nil {
		audioError(w, err)
		return
	}
	if !sameAudioUpload(row, p) {
		writeError(w, 409, "upload ID already belongs to different audio metadata")
		return
	}
	if row.State == "deleted" {
		writeError(w, 410, "upload was deleted")
		return
	}
	if row.State == "complete" {
		writeJSON(w, 200, map[string]any{"id": req.ID, "recording_id": row.RecordingID.Int32, "complete": true})
		return
	}
	if p.RequestRecordingID != 0 {
		recording, err := s.queries.GetRecording(r.Context(), p.RequestRecordingID)
		if err != nil {
			audioError(w, err)
			return
		}
		if recording.AudioObjectKey.Valid || recording.AudioUrl.String != "" {
			writeError(w, 409, "recording already has cloud audio")
			return
		}
	}
	target, headers, err := s.audio.upload(r.Context(), row.ObjectKey, row.ContentType, row.SizeBytes)
	if err != nil {
		audioError(w, err)
		return
	}
	// HTTP libraries own Host and Content-Length. Return other signed headers verbatim.
	headers.Del("Host")
	headers.Del("Content-Length")
	headers.Set("Content-Type", row.ContentType)
	writeJSON(w, 200, map[string]any{"id": req.ID, "url": target, "headers": headers, "complete": false})
}

func (s *Server) completeAudioUpload(ctx context.Context, id pgtype.UUID, actor int32) (int32, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	recordingID, err := s.finalizeAudioUpload(ctx, s.queries.WithTx(tx), id, actor)
	if err != nil {
		return 0, err
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	return recordingID, nil
}

type audioUploadQueries interface {
	LockAudioUpload(context.Context, db.LockAudioUploadParams) (db.RecordingAudioUpload, error)
	CreateAudioRecording(context.Context, db.CreateAudioRecordingParams) (int32, error)
	AttachRecordingAudio(context.Context, db.AttachRecordingAudioParams) (int32, error)
	CompleteAudioUpload(context.Context, db.CompleteAudioUploadParams) error
}

// q must be transaction-bound: the locked receipt and recording are committed together.
func (s *Server) finalizeAudioUpload(ctx context.Context, q audioUploadQueries, id pgtype.UUID, actor int32) (int32, error) {
	row, err := q.LockAudioUpload(ctx, db.LockAudioUploadParams{ID: id, UserID: actor})
	if err != nil {
		return 0, err
	}
	if row.State == "deleted" {
		return 0, audioHTTPError{410, "upload was deleted"}
	}
	if row.State == "complete" {
		return row.RecordingID.Int32, nil
	}
	if s.audio == nil {
		return 0, audioHTTPError{503, "B2 storage is not configured"}
	}
	if err = s.audio.verify(ctx, row.ObjectKey, row.ContentType, row.SizeBytes); err != nil {
		return 0, err
	}
	key := pgtype.Text{String: row.ObjectKey, Valid: true}
	var recordingID int32
	if row.RequestRecordingID == 0 {
		recordingID, err = q.CreateAudioRecording(ctx, db.CreateAudioRecordingParams{Name: pgtype.Text{String: row.Name, Valid: true}, Duration: pgtype.Int4{Int32: row.Duration, Valid: true}, AudioObjectKey: key})
	} else {
		recordingID, err = q.AttachRecordingAudio(ctx, db.AttachRecordingAudioParams{ID: row.RequestRecordingID, AudioObjectKey: key})
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, audioHTTPError{409, "recording missing or already has cloud audio"}
		}
	}
	if err != nil {
		return 0, err
	}
	if err = q.CompleteAudioUpload(ctx, db.CompleteAudioUploadParams{ID: id, RecordingID: pgtype.Int4{Int32: recordingID, Valid: true}}); err != nil {
		return 0, err
	}
	return recordingID, nil
}
func (s *Server) handleCompleteAudioUpload(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeError(w, 400, "invalid upload ID")
		return
	}
	actor, err := requireUserID(r.Context())
	if err != nil {
		writeError(w, 401, "unauthenticated")
		return
	}
	recordingID, err := s.completeAudioUpload(r.Context(), pgtype.UUID{Bytes: id, Valid: true}, int32(actor))
	if err != nil {
		audioError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"recording_id": recordingID, "complete": true})
}
func audioRecordingID(r *http.Request) (int32, error) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 32)
	if err != nil || id <= 0 {
		return 0, audioHTTPError{400, "invalid recording ID"}
	}
	return int32(id), nil
}
func (s *Server) handleGetRecordingAudio(w http.ResponseWriter, r *http.Request) {
	id, err := audioRecordingID(r)
	if err != nil {
		audioError(w, err)
		return
	}
	row, err := s.queries.GetRecording(r.Context(), id)
	if err != nil {
		audioError(w, err)
		return
	}
	target, err := s.recordingAudioURL(r.Context(), row.AudioObjectKey.String, row.AudioUrl.String)
	if err != nil {
		audioError(w, err)
		return
	}
	if target == "" {
		writeError(w, 404, "recording has no cloud audio")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, map[string]any{"url": target})
}
func (s *Server) handleDeleteRecordingAudio(w http.ResponseWriter, r *http.Request) {
	id, err := audioRecordingID(r)
	if err != nil {
		audioError(w, err)
		return
	}
	actor, err := requireUserID(r.Context())
	if err != nil {
		writeError(w, 401, "unauthenticated")
		return
	}
	user, err := s.queries.GetUser(r.Context(), int32(actor))
	if err != nil {
		audioError(w, err)
		return
	}
	if user.Role.String != "admin" {
		writeError(w, 403, "only admins can delete recording audio")
		return
	}
	if err = s.removeRecordingAudio(r.Context(), id, false); err != nil {
		audioError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"success": true})
}
func (s *Server) removeRecordingAudio(ctx context.Context, id int32, deleteRecording bool) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := s.queries.WithTx(tx)
	if err = q.RetireRecordingAudioUploads(ctx, pgtype.Int4{Int32: id, Valid: true}); err != nil {
		return err
	}
	row, err := q.LockRecordingAudio(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return tx.Commit(ctx)
	}
	if err != nil {
		return err
	}
	if row.AudioObjectKey.Valid {
		if s.audio == nil {
			return fmt.Errorf("B2 storage is not configured")
		}
		// Keep the object reference if deletion fails. Retrying DeleteObject is safe.
		if err = s.audio.delete(ctx, row.AudioObjectKey.String); err != nil {
			return err
		}
	} else if row.AudioUrl.String != "" && !deleteRecording {
		return audioHTTPError{409, "legacy Azure audio is preserved; remove it using Azure tooling"}
	}
	if deleteRecording {
		err = q.DeleteRecording(ctx, id)
	} else {
		err = q.ClearRecordingAudio(ctx, id)
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
