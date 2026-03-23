package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	"github.com/mvult/secretary/backend/gen/secretary/v1/secretaryv1connect"
	"golang.org/x/crypto/bcrypt"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func TestRecordingsListAndGet(t *testing.T) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		t.Skip("DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(pool.Close)

	recordingID := insertRecording(t, ctx, pool)
	defer cleanupRecording(t, ctx, pool, recordingID)

	srv := New(pool, []byte("test-secret"), 24*time.Hour)
	ts := httptest.NewServer(srv.Routes())
	defer ts.Close()

	userID, email, password := insertUser(t, ctx, pool)
	defer cleanupUser(t, ctx, pool, userID)
	token := login(t, ts.URL, email, password)

	// ListRecordings
	// ConnectRPC uses POST by default. URL: /<package>.<Service>/<Method>
	listURL := ts.URL + secretaryv1connect.RecordingsServiceListRecordingsProcedure
	resp, err := authPost(listURL, token, map[string]any{})
	if err != nil {
		t.Fatalf("list recordings: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list recordings status: %d", resp.StatusCode)
	}

	var listPayload secretaryv1.ListRecordingsResponse
	if err := json.NewDecoder(resp.Body).Decode(&listPayload); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	resp.Body.Close()
	found := false
	for _, rec := range listPayload.Recordings {
		if rec.Id == recordingID {
			found = true
			if rec.HasAudio {
				t.Fatalf("expected has_audio false for test recording")
			}
		}
	}
	if !found {
		t.Fatalf("expected recording id %d in list", recordingID)
	}

	// GetRecording
	getURL := ts.URL + secretaryv1connect.RecordingsServiceGetRecordingProcedure
	resp, err = authPost(getURL, token, map[string]any{"id": recordingID})
	if err != nil {
		t.Fatalf("get recording: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get recording status: %d", resp.StatusCode)
	}
	var getPayload secretaryv1.GetRecordingResponse
	if err := json.NewDecoder(resp.Body).Decode(&getPayload); err != nil {
		t.Fatalf("decode get: %v", err)
	}
	resp.Body.Close()
	if getPayload.Recording.Id != recordingID {
		t.Fatalf("expected recording id %d, got %d", recordingID, getPayload.Recording.Id)
	}
}

func TestTodoLifecycle(t *testing.T) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		t.Skip("DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(pool.Close)

	userID, email, password := insertUser(t, ctx, pool)
	recordingID := insertRecording(t, ctx, pool)
	defer cleanupRecording(t, ctx, pool, recordingID)
	defer cleanupUser(t, ctx, pool, userID)

	srv := New(pool, []byte("test-secret"), 24*time.Hour)
	ts := httptest.NewServer(srv.Routes())
	defer ts.Close()

	token := login(t, ts.URL, email, password)

	createReq := secretaryv1.CreateTodoRequest{
		Name:                 "Test todo",
		Desc:                 "Test desc",
		Status:               secretaryv1.TodoStatus_TODO_STATUS_NOT_STARTED,
		UserId:               userID,
		CreatedAtRecordingId: recordingID,
		UpdatedAtRecordingId: recordingID,
	}
	todo := createTodo(t, ts.URL, token, createReq)
	defer cleanupTodo(t, ctx, pool, todo.Id)

	// ListTodos
	listURL := ts.URL + secretaryv1connect.TodosServiceListTodosProcedure
	listResp, err := authPost(listURL, token, map[string]any{"user_id": userID})
	if err != nil {
		t.Fatalf("list todos: %v", err)
	}
	if listResp.StatusCode != http.StatusOK {
		t.Fatalf("list todos status: %d", listResp.StatusCode)
	}
	listResp.Body.Close()

	// UpdateTodo
	updateReq := secretaryv1.UpdateTodoRequest{
		Id:                   todo.Id,
		Name:                 "Test todo updated",
		Desc:                 "Updated desc",
		Status:               secretaryv1.TodoStatus_TODO_STATUS_DONE,
		UserId:               userID,
		UpdatedAtRecordingId: recordingID,
	}
	updateURL := ts.URL + secretaryv1connect.TodosServiceUpdateTodoProcedure
	updateResp, err := authPost(updateURL, token, updateReq)
	if err != nil {
		t.Fatalf("update todo: %v", err)
	}
	if updateResp.StatusCode != http.StatusOK {
		t.Fatalf("update todo status: %d", updateResp.StatusCode)
	}
	updateResp.Body.Close()

	// ListTodoHistory
	historyURL := ts.URL + secretaryv1connect.TodosServiceListTodoHistoryProcedure
	historyResp, err := authPost(historyURL, token, map[string]any{"todo_id": todo.Id})
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	if historyResp.StatusCode != http.StatusOK {
		t.Fatalf("history status: %d", historyResp.StatusCode)
	}
	var historyPayload secretaryv1.ListTodoHistoryResponse
	if err := json.NewDecoder(historyResp.Body).Decode(&historyPayload); err != nil {
		t.Fatalf("decode history: %v", err)
	}
	historyResp.Body.Close()
	if len(historyPayload.History) < 2 {
		t.Fatalf("expected at least 2 history rows, got %d", len(historyPayload.History))
	}

	// DeleteTodo
	deleteURL := ts.URL + secretaryv1connect.TodosServiceDeleteTodoProcedure
	deleteResp, err := authPost(deleteURL, token, map[string]any{"id": todo.Id})
	if err != nil {
		t.Fatalf("delete todo: %v", err)
	}
	if deleteResp.StatusCode != http.StatusOK { // Connect returns 200 OK for empty responses usually, not 204
		t.Fatalf("delete todo status: %d", deleteResp.StatusCode)
	}
	deleteResp.Body.Close()
}

func TestWorkspaceDocumentPersistenceFlow(t *testing.T) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		t.Skip("DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(pool.Close)

	userID, email, password := insertUser(t, ctx, pool)
	defer cleanupUser(t, ctx, pool, userID)

	srv := New(pool, []byte("test-secret"), 24*time.Hour)
	ts := httptest.NewServer(srv.Routes())
	defer ts.Close()

	token := login(t, ts.URL, email, password)

	workspaceURL := ts.URL + secretaryv1connect.WorkspacesServiceCreateWorkspaceProcedure
	workspaceResp, err := authPost(workspaceURL, token, secretaryv1.CreateWorkspaceRequest{Name: "Native Sync"})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	if workspaceResp.StatusCode != http.StatusOK {
		t.Fatalf("create workspace status: %d", workspaceResp.StatusCode)
	}
	var workspacePayload secretaryv1.CreateWorkspaceResponse
	if err := decodeProtoBody(workspaceResp.Body, &workspacePayload); err != nil {
		t.Fatalf("decode workspace: %v", err)
	}
	workspaceResp.Body.Close()
	workspaceID := workspacePayload.Workspace.Id
	defer cleanupWorkspace(t, ctx, pool, workspaceID)

	saveURL := ts.URL + secretaryv1connect.DocumentsServiceSaveDocumentProcedure
	createResp, err := authPost(saveURL, token, &secretaryv1.SaveDocumentRequest{
		Document: &secretaryv1.Document{
			ClientKey:   "note-local-1",
			WorkspaceId: workspaceID,
			Kind:        "note",
			Title:       "Persistence flow",
			Blocks: []*secretaryv1.Block{
				{ClientKey: "block-a", SortOrder: 1, Text: "Top level", Status: "note"},
				{ClientKey: "block-b", ParentClientKey: "block-a", SortOrder: 2, Text: "Nested", Status: "todo"},
			},
		},
	})
	if err != nil {
		t.Fatalf("save document: %v", err)
	}
	if createResp.StatusCode != http.StatusOK {
		t.Fatalf("save document status: %d", createResp.StatusCode)
	}
	var createPayload secretaryv1.SaveDocumentResponse
	if err := decodeProtoBody(createResp.Body, &createPayload); err != nil {
		t.Fatalf("decode save document: %v", err)
	}
	createResp.Body.Close()
	if createPayload.Document == nil || createPayload.Document.Id == 0 {
		t.Fatalf("expected saved document id")
	}
	if len(createPayload.Document.Blocks) != 2 {
		t.Fatalf("expected 2 saved blocks, got %d", len(createPayload.Document.Blocks))
	}
	if createPayload.Document.Blocks[1].ParentBlockId != createPayload.Document.Blocks[0].Id {
		t.Fatalf("expected nested block parent to be persisted")
	}

	updatedResp, err := authPost(saveURL, token, &secretaryv1.SaveDocumentRequest{
		Document: &secretaryv1.Document{
			Id:          createPayload.Document.Id,
			ClientKey:   createPayload.Document.ClientKey,
			WorkspaceId: workspaceID,
			Kind:        "note",
			Title:       "Persistence flow updated",
			Blocks: []*secretaryv1.Block{
				{
					Id:        createPayload.Document.Blocks[0].Id,
					ClientKey: createPayload.Document.Blocks[0].ClientKey,
					SortOrder: 1,
					Text:      "Top level updated",
					Status:    "doing",
				},
				{
					ClientKey: "block-c",
					SortOrder: 2,
					Text:      "Fresh second block",
					Status:    "done",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("update document: %v", err)
	}
	if updatedResp.StatusCode != http.StatusOK {
		t.Fatalf("update document status: %d", updatedResp.StatusCode)
	}
	var updatedPayload secretaryv1.SaveDocumentResponse
	if err := decodeProtoBody(updatedResp.Body, &updatedPayload); err != nil {
		t.Fatalf("decode updated document: %v", err)
	}
	updatedResp.Body.Close()
	if len(updatedPayload.Document.Blocks) != 2 {
		t.Fatalf("expected 2 blocks after reconcile, got %d", len(updatedPayload.Document.Blocks))
	}
	if updatedPayload.Document.Blocks[0].Text != "Top level updated" {
		t.Fatalf("expected updated text, got %q", updatedPayload.Document.Blocks[0].Text)
	}

	listURL := ts.URL + secretaryv1connect.DocumentsServiceListDocumentsProcedure
	listResp, err := authPost(listURL, token, secretaryv1.ListDocumentsRequest{WorkspaceId: workspaceID})
	if err != nil {
		t.Fatalf("list documents: %v", err)
	}
	if listResp.StatusCode != http.StatusOK {
		t.Fatalf("list documents status: %d", listResp.StatusCode)
	}
	var listPayload secretaryv1.ListDocumentsResponse
	if err := decodeProtoBody(listResp.Body, &listPayload); err != nil {
		t.Fatalf("decode list documents: %v", err)
	}
	listResp.Body.Close()
	if len(listPayload.Documents) != 1 {
		t.Fatalf("expected 1 document, got %d", len(listPayload.Documents))
	}
	if listPayload.Documents[0].Title != "Persistence flow updated" {
		t.Fatalf("expected updated title, got %q", listPayload.Documents[0].Title)
	}
	if len(listPayload.Documents[0].Blocks) != 2 {
		t.Fatalf("expected 2 blocks from list, got %d", len(listPayload.Documents[0].Blocks))
	}
}

func insertUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool) (int64, string, string) {
	t.Helper()
	var id int64
	email := "test-user-" + strconv.FormatInt(time.Now().UnixNano(), 10) + "@example.com"
	password := "test-password"
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	_, _ = pool.Exec(ctx, `
    SELECT setval(
      pg_get_serial_sequence('"user"', 'id'),
      GREATEST(COALESCE((SELECT MAX(id) FROM "user"), 0), 1),
      true
    )
  `)
	err = pool.QueryRow(ctx, `
    INSERT INTO "user" (first_name, last_name, role, email, password_hash)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `, "Test", "User", "tester", email, string(hash)).Scan(&id)
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}
	return id, email, password
}

func insertRecording(t *testing.T, ctx context.Context, pool *pgxpool.Pool) int64 {
	t.Helper()
	var id int64
	err := pool.QueryRow(ctx, `
    INSERT INTO recording (created_at, name, summary, transcript, duration)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `, time.Now().UTC(), "Test recording", "Summary", "Transcript", 120).Scan(&id)
	if err != nil {
		t.Fatalf("insert recording: %v", err)
	}
	return id
}

func cleanupTodo(t *testing.T, ctx context.Context, pool *pgxpool.Pool, todoID int64) {
	t.Helper()
	_, _ = pool.Exec(ctx, `DELETE FROM todo_history WHERE todo_id = $1`, todoID)
	_, _ = pool.Exec(ctx, `DELETE FROM todo WHERE id = $1`, todoID)
}

func cleanupRecording(t *testing.T, ctx context.Context, pool *pgxpool.Pool, recordingID int64) {
	t.Helper()
	_, _ = pool.Exec(ctx, `DELETE FROM recording WHERE id = $1`, recordingID)
}

func cleanupUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID int64) {
	t.Helper()
	_, _ = pool.Exec(ctx, `DELETE FROM "user" WHERE id = $1`, userID)
}

func cleanupWorkspace(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workspaceID int64) {
	t.Helper()
	_, _ = pool.Exec(ctx, `DELETE FROM workspace WHERE id = $1`, workspaceID)
}

func createTodo(t *testing.T, baseURL string, token string, req secretaryv1.CreateTodoRequest) *secretaryv1.Todo {
	t.Helper()
	createURL := baseURL + secretaryv1connect.TodosServiceCreateTodoProcedure
	resp, err := authPost(createURL, token, req)
	if err != nil {
		t.Fatalf("create todo: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create todo status: %d", resp.StatusCode)
	}
	var payload secretaryv1.CreateTodoResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	resp.Body.Close()
	return payload.Todo
}

func authPost(url string, token string, body any) (*http.Response, error) {
	b, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	return http.DefaultClient.Do(req)
}

func login(t *testing.T, baseURL, email, password string) string {
	t.Helper()
	body, _ := json.Marshal(LoginRequest{Email: email, Password: password})
	resp, err := http.Post(baseURL+"/api/login", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login status: %d", resp.StatusCode)
	}
	var payload struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode login: %v", err)
	}
	resp.Body.Close()
	if payload.Token == "" {
		t.Fatalf("missing token")
	}
	return payload.Token
}

func decodeProtoBody(body io.ReadCloser, target proto.Message) error {
	data, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	return protojson.Unmarshal(data, target)
}
