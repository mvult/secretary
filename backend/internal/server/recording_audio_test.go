package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/mvult/secretary/backend/internal/db/gen"
)

type audioQueriesFixture struct {
	row               db.RecordingAudioUpload
	creates, attaches int
	occupied          bool
}

func (f *audioQueriesFixture) LockAudioUpload(_ context.Context, p db.LockAudioUploadParams) (db.RecordingAudioUpload, error) {
	if p.ID != f.row.ID || p.UserID != f.row.UserID {
		return db.RecordingAudioUpload{}, pgx.ErrNoRows
	}
	return f.row, nil
}
func (f *audioQueriesFixture) CreateAudioRecording(_ context.Context, p db.CreateAudioRecordingParams) (int32, error) {
	f.creates++
	return 42, nil
}
func (f *audioQueriesFixture) AttachRecordingAudio(_ context.Context, p db.AttachRecordingAudioParams) (int32, error) {
	f.attaches++
	if f.occupied {
		return 0, pgx.ErrNoRows
	}
	return p.ID, nil
}
func (f *audioQueriesFixture) CompleteAudioUpload(_ context.Context, p db.CompleteAudioUploadParams) error {
	f.row.State = "complete"
	f.row.RecordingID = p.RecordingID
	return nil
}

type audioStoreFixture struct {
	verified int
	err      error
}

func (f *audioStoreFixture) upload(context.Context, string, string, int64) (string, http.Header, error) {
	return "", nil, nil
}
func (f *audioStoreFixture) download(context.Context, string) (string, error) { return "", nil }
func (f *audioStoreFixture) delete(context.Context, string) error             { return nil }
func (f *audioStoreFixture) verify(context.Context, string, string, int64) error {
	f.verified++
	return f.err
}

func TestAudioFinalizeReplayAndOwnerIsolation(t *testing.T) {
	q := &audioQueriesFixture{row: db.RecordingAudioUpload{ID: pgtype.UUID{Bytes: uuid.New(), Valid: true}, UserID: 7, State: "uploading", ObjectKey: "recordings/a.m4a", SizeBytes: 4, ContentType: "audio/mp4"}}
	store := &audioStoreFixture{}
	s := &Server{audio: store}
	ctx := context.Background()
	if _, err := s.finalizeAudioUpload(ctx, q, q.row.ID, 8); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("another user could finalize", err)
	}
	first, err := s.finalizeAudioUpload(ctx, q, q.row.ID, 7)
	if err != nil {
		t.Fatal(err)
	}
	// Lost response: receipt replay must work even if object storage is now unavailable.
	s.audio = nil
	second, err := s.finalizeAudioUpload(ctx, q, q.row.ID, 7)
	if err != nil || first != second || q.creates != 1 || store.verified != 1 {
		t.Fatalf("duplicated create: %d %d %+v %v", first, second, q, err)
	}
	q.row.State = "deleted"
	if _, err := s.finalizeAudioUpload(ctx, q, q.row.ID, 7); err == nil {
		t.Fatal("deleted receipt recreated recording")
	}
}

func TestAudioFinalizeVerifiesBeforeRegisteringAndNeverReplacesAudio(t *testing.T) {
	q := &audioQueriesFixture{row: db.RecordingAudioUpload{ID: pgtype.UUID{Bytes: uuid.New(), Valid: true}, UserID: 7, State: "uploading", RequestRecordingID: 5}}
	store := &audioStoreFixture{err: errors.New("truncated upload")}
	s := &Server{audio: store}
	ctx := context.Background()
	if _, err := s.finalizeAudioUpload(ctx, q, q.row.ID, 7); err == nil || q.attaches != 0 || q.row.State != "uploading" {
		t.Fatal("registered unverified audio")
	}
	store.err = nil
	q.occupied = true
	if _, err := s.finalizeAudioUpload(ctx, q, q.row.ID, 7); err == nil || q.row.State != "uploading" {
		t.Fatal("replaced existing audio")
	}
	q.occupied = false
	if id, err := s.finalizeAudioUpload(ctx, q, q.row.ID, 7); err != nil || id != 5 || q.creates != 0 {
		t.Fatal("failed to attach", id, err)
	}
}

func TestAudioUploadMetadataCannotChangeOnRetry(t *testing.T) {
	request := audioUploadRequest{ID: uuid.NewString(), Name: "Meeting", Duration: 30, Size: 100, ContentType: "audio/mp4"}
	p, err := request.params(7)
	if err != nil {
		t.Fatal(err)
	}
	row := db.RecordingAudioUpload{UserID: p.UserID, RequestRecordingID: p.RequestRecordingID, Name: p.Name, Duration: p.Duration, SizeBytes: p.SizeBytes, ContentType: p.ContentType, ObjectKey: p.ObjectKey}
	if !sameAudioUpload(row, p) {
		t.Fatal("same request rejected")
	}
	p.SizeBytes++
	if sameAudioUpload(row, p) {
		t.Fatal("accepted changed bytes")
	}
	for _, mutate := range []func(*audioUploadRequest){
		func(r *audioUploadRequest) { r.ID = "../object" }, func(r *audioUploadRequest) { r.Size = 0 }, func(r *audioUploadRequest) { r.Size = 3 << 30 },
		func(r *audioUploadRequest) { r.ContentType = "text/html" }, func(r *audioUploadRequest) { r.RecordingID = -1 },
	} {
		r := request
		mutate(&r)
		if _, err := r.params(7); err == nil {
			t.Fatalf("accepted invalid request %+v", r)
		}
	}
}

func TestB2SigningAndObjectVerification(t *testing.T) {
	contentType := "audio/mp4"
	size := "4"
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "HEAD" || r.URL.Path != "/bucket/recordings/a.m4a" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Length", size)
	}))
	defer endpoint.Close()
	client := s3.New(s3.Options{Region: "us-west-004", BaseEndpoint: aws.String(endpoint.URL), UsePathStyle: true,
		Credentials:                credentials.NewStaticCredentialsProvider("key-id", "test-secret", ""),
		RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired})
	b := &b2AudioStore{client: client, signer: s3.NewPresignClient(client), bucket: "bucket"}
	target, headers, err := b.upload(context.Background(), "recordings/a.m4a", "audio/mp4", 4)
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(target)
	if u.Query().Get("X-Amz-Expires") != "1800" || !strings.Contains(u.Query().Get("X-Amz-SignedHeaders"), "content-length") || headers.Get("Content-Length") != "4" {
		t.Fatalf("unsigned size or wrong expiry: %s %v", target, headers)
	}
	if err = b.verify(context.Background(), "recordings/a.m4a", "audio/mp4", 4); err != nil {
		t.Fatal(err)
	}
	size = "3"
	if err = b.verify(context.Background(), "recordings/a.m4a", "audio/mp4", 4); err == nil {
		t.Fatal("accepted truncated object")
	}
	size = "4"
	contentType = "text/html"
	if err = b.verify(context.Background(), "recordings/a.m4a", "audio/mp4", 4); err == nil {
		t.Fatal("accepted wrong media type")
	}
	s := &Server{}
	legacy := "https://legacy.blob.core.windows.net/recordings/a.mp3"
	if got, err := s.recordingAudioURL(context.Background(), "", legacy); err != nil || got != legacy {
		t.Fatal("lost legacy audio")
	}
}
