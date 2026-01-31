package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
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

	resp, err := authGet(ts.URL+"/api/recordings", token)
	if err != nil {
		t.Fatalf("list recordings: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list recordings status: %d", resp.StatusCode)
	}

	var listPayload struct {
		Recordings []Recording `json:"recordings"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&listPayload); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	resp.Body.Close()
	found := false
	for _, rec := range listPayload.Recordings {
		if rec.ID == recordingID {
			found = true
			if rec.HasAudio {
				t.Fatalf("expected has_audio false for test recording")
			}
		}
	}
	if !found {
		t.Fatalf("expected recording id %d in list", recordingID)
	}

	resp, err = authGet(ts.URL+"/api/recordings/"+strconv.FormatInt(recordingID, 10), token)
	if err != nil {
		t.Fatalf("get recording: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get recording status: %d", resp.StatusCode)
	}
	var getPayload struct {
		Recording Recording `json:"recording"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&getPayload); err != nil {
		t.Fatalf("decode get: %v", err)
	}
	resp.Body.Close()
	if getPayload.Recording.ID != recordingID {
		t.Fatalf("expected recording id %d, got %d", recordingID, getPayload.Recording.ID)
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

	createReq := CreateTodoRequest{
		Name:                 "Test todo",
		Desc:                 "Test desc",
		Status:               "not_started",
		UserID:               userID,
		CreatedAtRecordingID: recordingID,
		UpdatedAtRecordingID: recordingID,
	}
	todo := createTodo(t, ts.URL, token, createReq)
	defer cleanupTodo(t, ctx, pool, todo.ID)

	listResp, err := authGet(ts.URL+"/api/todos?user_id="+strconv.FormatInt(userID, 10), token)
	if err != nil {
		t.Fatalf("list todos: %v", err)
	}
	if listResp.StatusCode != http.StatusOK {
		t.Fatalf("list todos status: %d", listResp.StatusCode)
	}
	listResp.Body.Close()

	updateReq := UpdateTodoRequest{
		Name:                 "Test todo updated",
		Desc:                 "Updated desc",
		Status:               "done",
		UserID:               userID,
		UpdatedAtRecordingID: recordingID,
	}
	updateBody, _ := json.Marshal(updateReq)
	updateResp, err := http.NewRequest(http.MethodPut, ts.URL+"/api/todos/"+strconv.FormatInt(todo.ID, 10), bytes.NewReader(updateBody))
	if err != nil {
		t.Fatalf("build update request: %v", err)
	}
	updateResp.Header.Set("Authorization", "Bearer "+token)
	updateHTTPResp, err := http.DefaultClient.Do(updateResp)
	if err != nil {
		t.Fatalf("update todo: %v", err)
	}
	if updateHTTPResp.StatusCode != http.StatusOK {
		t.Fatalf("update todo status: %d", updateHTTPResp.StatusCode)
	}
	updateHTTPResp.Body.Close()

	historyResp, err := authGet(ts.URL+"/api/todos/"+strconv.FormatInt(todo.ID, 10)+"/history", token)
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	if historyResp.StatusCode != http.StatusOK {
		t.Fatalf("history status: %d", historyResp.StatusCode)
	}
	var historyPayload struct {
		History []TodoHistory `json:"history"`
	}
	if err := json.NewDecoder(historyResp.Body).Decode(&historyPayload); err != nil {
		t.Fatalf("decode history: %v", err)
	}
	historyResp.Body.Close()
	if len(historyPayload.History) < 2 {
		t.Fatalf("expected at least 2 history rows, got %d", len(historyPayload.History))
	}

	deleteReq, err := http.NewRequest(http.MethodDelete, ts.URL+"/api/todos/"+strconv.FormatInt(todo.ID, 10), nil)
	if err != nil {
		t.Fatalf("build delete: %v", err)
	}
	deleteReq.Header.Set("Authorization", "Bearer "+token)
	deleteResp, err := http.DefaultClient.Do(deleteReq)
	if err != nil {
		t.Fatalf("delete todo: %v", err)
	}
	if deleteResp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete todo status: %d", deleteResp.StatusCode)
	}
	deleteResp.Body.Close()
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

func createTodo(t *testing.T, baseURL string, token string, req CreateTodoRequest) Todo {
	t.Helper()
	body, _ := json.Marshal(req)
	reqHTTP, err := http.NewRequest(http.MethodPost, baseURL+"/api/todos", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("build create todo: %v", err)
	}
	reqHTTP.Header.Set("Content-Type", "application/json")
	reqHTTP.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(reqHTTP)
	if err != nil {
		t.Fatalf("create todo: %v", err)
	}
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create todo status: %d", resp.StatusCode)
	}
	var payload struct {
		Todo Todo `json:"todo"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	resp.Body.Close()
	return payload.Todo
}

func authGet(url string, token string) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
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
